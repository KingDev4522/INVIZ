/**
 * Page-change detection with the concrete trigger list
 * (PRD 6.1 §1.4; PRD 3 §29; PRD 4 §15–16, §86–88).
 * Replaces the circular "semantic change" rule: local signals only, each with
 * a defined meaning. Minor DOM churn stays local — no full rebuilds.
 */

export type ChangeTrigger =
  | "full-navigation" // content script re-injected (handled by boot, listed for completeness)
  | "route" // pushState / replaceState / popstate with URL change
  | "modal" // dialog opened or closed / modal root changed
  | "counts" // interactive-element count changed materially
  | "form-structure" // form field set changed
  | "results" // results container replaced / list length changed
  | "busy" // aria-busy busy→ready transition
  | "state" // generic control-state flip with no count change (pressed/checked/selected/label)
  | "root" // document root / body replaced
  | "bfcache" // pageshow with persisted=true → revalidate everything
  | "minor"; // everything else: handled locally, no rebuild

export interface TriggerCounts {
  interactives: number;
  fields: number;
  results: number;
  dialogs: number;
}

export interface ObserverHooks {
  onTrigger: (trigger: ChangeTrigger, detail: string) => void;
}

const DEBOUNCE_MS = 150;
const COUNT_DELTA_THRESHOLD = 3;

function currentUrl(): string {
  return location.href;
}

export function countRegions(root: ParentNode): TriggerCounts {
  // Shadow-aware counting (generic): component frameworks mount content
  // inside OPEN shadow roots. Flat querySelectorAll misses it, so a late
  // grid load classifies as "minor" and never pushes a snapshot — the CURRENT
  // page stays stale/empty for the next voice command. Descend into open
  // shadow roots (same traversal as dom-extractor queryDeep) so late renders
  // surface as counts/results triggers. Falls back to flat counts if shadow
  // traversal throws (hostile page).
  try {
    const deepAll = (selector: string): number => {
      let n = 0;
      const walk = (node: ParentNode): void => {
        n += node.querySelectorAll(selector).length;
        node.querySelectorAll("*").forEach((el) => {
          const shadow = (el as HTMLElement).shadowRoot ?? null;
          if (shadow !== null) walk(shadow);
        });
      };
      walk(root);
      return n;
    };
    const interactives = deepAll(
      "a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='menuitem'],[role='tab']",
    );
    const fields = deepAll("input,select,textarea");
    const results = deepAll("[role='list'] > *, ul > li, ol > li");
    const dialogs = deepAll("dialog[open],[role='dialog'],[role='alertdialog']");
    return { interactives, fields, results, dialogs };
  } catch {
    const interactives = root.querySelectorAll(
      "a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='menuitem'],[role='tab']",
    ).length;
    const fields = root.querySelectorAll("input,select,textarea").length;
    const results = root.querySelectorAll("[role='list'] > *, ul > li, ol > li").length;
    const dialogs = root.querySelectorAll(
      "dialog[open],[role='dialog'],[role='alertdialog']",
    ).length;
    return { interactives, fields, results, dialogs };
  }
}

/**
 * Generic control-state attributes whose flip changes what the CURRENT page
 * means without changing element counts (e.g. a generic play/pause toggle
 * flipping pressed/label). No site-specific names here — only standard
 * ARIA/HTML state attributes.
 */
const STATE_ATTRS: ReadonlySet<string> = new Set([
  "aria-pressed",
  "aria-checked",
  "aria-selected",
  "aria-label",
  "disabled",
]);

export class PageObserver {
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastUrl = currentUrl();
  private baseline: TriggerCounts;
  private disposers: Array<() => void> = [];
  private stateDirty = false;

  constructor(
    private readonly root: ParentNode,
    private readonly hooks: ObserverHooks,
  ) {
    this.baseline = countRegions(root);
  }

  start(): void {
    if (this.observer !== null) return;
    this.wrapHistory("pushState");
    this.wrapHistory("replaceState");
    const onPopState = (): void => this.checkRoute("popstate");
    window.addEventListener("popstate", onPopState);
    this.disposers.push(() => window.removeEventListener("popstate", onPopState));

    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) this.hooks.onTrigger("bfcache", "restored from bfcache; revalidate");
    };
    window.addEventListener("pageshow", onPageShow);
    this.disposers.push(() => window.removeEventListener("pageshow", onPageShow));

    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.type === "attributes" &&
          typeof record.attributeName === "string" &&
          STATE_ATTRS.has(record.attributeName)
        ) {
          this.stateDirty = true;
          break;
        }
      }
      this.schedule();
    });
    this.observer.observe(this.root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-busy",
        "open",
        "aria-expanded",
        "aria-hidden",
        "hidden",
        "aria-pressed",
        "aria-checked",
        "aria-selected",
        "aria-label",
        "disabled",
      ],
    });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  private wrapHistory(method: "pushState" | "replaceState"): void {
    const original = history[method].bind(history) as (...args: unknown[]) => void;
    const self = this;
    (history as unknown as Record<string, unknown>)[method] = function (
      ...args: unknown[]
    ): void {
      original(...args);
      self.checkRoute(method);
    };
    this.disposers.push(() => {
      (history as unknown as Record<string, unknown>)[method] = original;
    });
  }

  private checkRoute(source: string): void {
    const now = currentUrl();
    if (now !== this.lastUrl) {
      this.lastUrl = now;
      this.rebaseline();
      this.hooks.onTrigger("route", `${source}: ${now}`);
    }
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.classify();
    }, DEBOUNCE_MS);
  }

  /** Testable classification core: compares fresh counts to the baseline. */
  classifyNow(): ChangeTrigger {
    return this.classify();
  }

  private classify(): ChangeTrigger {
    // Root replacement check.
    if (!document.contains(this.root as Node) && this.root === document.body) {
      this.rebaseline();
      this.hooks.onTrigger("root", "document body replaced");
      return "root";
    }
    const fresh = countRegions(this.root);

    if (fresh.dialogs !== this.baseline.dialogs) {
      this.rebaseline(fresh);
      this.hooks.onTrigger("modal", `dialog count ${this.baseline.dialogs}→${fresh.dialogs}`);
      return "modal";
    }
    if (fresh.fields !== this.baseline.fields) {
      this.rebaseline(fresh);
      this.hooks.onTrigger("form-structure", `field count ${this.baseline.fields}→${fresh.fields}`);
      return "form-structure";
    }
    if (Math.abs(fresh.results - this.baseline.results) > 0) {
      const before = this.baseline.results;
      this.rebaseline(fresh);
      this.hooks.onTrigger("results", `results count ${before}→${fresh.results}`);
      return "results";
    }
    if (Math.abs(fresh.interactives - this.baseline.interactives) >= COUNT_DELTA_THRESHOLD) {
      const before = this.baseline.interactives;
      this.rebaseline(fresh);
      this.hooks.onTrigger("counts", `interactive count ${before}→${fresh.interactives}`);
      return "counts";
    }
    // Generic state flip with no count change: the registry's states/names
    // for the CURRENT page are stale (e.g. toggled control). Rebaseline and
    // push once (debounced by schedule) so the next command reads live state.
    if (this.stateDirty) {
      this.stateDirty = false;
      this.rebaseline(fresh);
      this.hooks.onTrigger("state", "control state changed");
      return "state";
    }
    // aria-busy transitions are observed via attribute records; a settled
    // busy=false after observed activity counts as a meaningful refresh.
    const busy = (this.root as ParentNode & Document).querySelector?.(
      "[aria-busy='true']",
    );
    void busy;
    return "minor";
  }

  private rebaseline(next?: TriggerCounts): void {
    this.baseline = next ?? countRegions(this.root);
    this.lastUrl = currentUrl();
    this.stateDirty = false;
  }
}
