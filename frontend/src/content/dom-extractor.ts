/**
 * DOM structure extraction (PRD 6.1 §1.1; PRD 4 §8).
 * Role resolution, visibility filtering, state extraction, page structure.
 * Naming (accessible names) lives in aria-extractor.ts.
 */

export type FieldKind =
  | "text"
  | "email"
  | "password"
  | "number"
  | "textarea"
  | "checkbox"
  | "radio"
  | "select"
  | "combobox"
  | "date"
  | "file"
  | "other";

export interface FieldInfo {
  kind: FieldKind;
  /** True for password/OTP/file and any Category C control (PRD 5 §23). */
  sensitive: boolean;
}

export interface ExtractedElement {
  element: Element;
  role: string;
  states: Record<string, string | boolean | number>;
  /** Field info when the element is a form control, else null. */
  field: FieldInfo | null;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "select",
  "textarea",
  "heading",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "banner",
  "form",
  "dialog",
  "alertdialog",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "tablist",
  "tabpanel",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "img",
  "progressbar",
  "status",
  "alert",
  "article",
  "region",
  "search",
  "separator",
  "toolbar",
  "tooltip",
  "tree",
  "treeitem",
  "grid",
  "gridcell",
  "option",
  "radiogroup",
  "group",
  "generic",
]);

/** Roles that make an element meaningful for the interactive set. */
export const WIDGET_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "select",
  "textarea",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "option",
  "progressbar",
  "img",
]);

function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
      return el.hasAttribute("href") ? "link" : "generic";
    case "button":
      return "button";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "summary":
      return "button";
    case "dialog":
      return "dialog";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "header":
      return "banner";
    case "footer":
      return "contentinfo";
    case "aside":
      return "complementary";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "td":
      return "cell";
    case "th":
      return "columnheader";
    case "img":
      return el.getAttribute("alt") === null ? "presentation" : "img";
    case "progress":
      return "progressbar";
    case "form":
      return "form";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      switch (type) {
        case "button":
        case "submit":
        case "reset":
        case "image":
          return "button";
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "search":
          return "searchbox";
        case "number":
        case "range":
          return type === "range" ? "slider" : "spinbutton";
        case "hidden":
          return "none";
        default:
          return "textbox";
      }
    }
    default:
      return "generic";
  }
}

/** Explicit role wins when valid; otherwise the native implicit role. */
export function resolveRole(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit !== undefined && explicit !== "" && KNOWN_ROLES.has(explicit)) {
    return explicit;
  }
  return implicitRole(el);
}

/**
 * Visibility for registry purposes. Attribute + computed-style based only —
 * never layout-rect based, so empty-but-labelled controls (icon buttons with
 * aria-label) are never dropped.
 */
export function isVisible(el: Element): boolean {
  if (el.hasAttribute("hidden")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
  } catch {
    // Non-visual DOM (tests): fall through to attribute checks only.
  }
  return true;
}

function readAriaState(
  states: Record<string, string | boolean | number>,
  el: Element,
  attr: string,
  key: string,
): void {
  const v = el.getAttribute(attr);
  if (v === null) return;
  if (v === "true") states[key] = true;
  else if (v === "false") states[key] = false;
  else states[key] = v;
}

/** ARIA + native states for announcement and verification use. */
export function extractStates(el: Element, role: string): Record<string, string | boolean | number> {
  const states: Record<string, string | boolean | number> = {};
  readAriaState(states, el, "aria-checked", "checked");
  readAriaState(states, el, "aria-selected", "selected");
  readAriaState(states, el, "aria-expanded", "expanded");
  readAriaState(states, el, "aria-pressed", "pressed");
  readAriaState(states, el, "aria-required", "required");
  readAriaState(states, el, "aria-invalid", "invalid");
  readAriaState(states, el, "aria-readonly", "readonly");
  readAriaState(states, el, "aria-disabled", "disabled");
  readAriaState(states, el, "aria-level", "level");
  readAriaState(states, el, "aria-valuenow", "value");

  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") states["checked"] = el.checked;
    if (el.disabled) states["disabled"] = true;
    if (el.required) states["required"] = true;
    if (el.readOnly) states["readonly"] = true;
  }
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled) states["disabled"] = true;
    if (el.required) states["required"] = true;
  }
  if (el instanceof HTMLButtonElement && el.disabled) states["disabled"] = true;
  if (role === "heading") {
    const m = /^h([1-6])$/.exec(el.tagName.toLowerCase());
    if (m?.[1] !== undefined) states["level"] = Number(m[1]);
    else if (states["level"] === undefined) states["level"] = 2;
  }
  if (el instanceof HTMLDialogElement) states["open"] = el.open;
  if (el.tagName.toLowerCase() === "details") {
    states["expanded"] = (el as HTMLDetailsElement).open;
  }
  return states;
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
  "[role]",
  "[contenteditable]",
].join(",");

export interface InteractiveSet {
  items: Element[];
  /** Elements skipped as hidden/inert (counted for coverage reporting). */
  skippedHidden: number;
  /** Open shadow roots descended into (their content is included above). */
  shadowPierced: number;
}

/**
 * Shadow-piercing selector: light DOM plus every OPEN shadow root, in
 * document order (a shadow tree is visited immediately after its host, so
 * visual order is approximately preserved). Closed shadow roots are
 * unreachable by design and stay invisible — same as assistive technology.
 *
 * Why this exists: component frameworks (YouTube's polymer renderers, video
 * players, consent dialogs) mount their controls inside shadow DOM. A flat
 * document.querySelectorAll sees the page chrome but none of the content, so
 * "play the 1st video" had no target and the model asked irrelevant questions.
 */
export function queryDeep(
  root: ParentNode,
  selector: string,
  stats?: { pierced: number },
): Element[] {
  const out: Element[] = [];
  const walk = (node: ParentNode): void => {
    node.querySelectorAll(selector).forEach((el) => {
      out.push(el);
    });
    // Descend into EVERY open shadow root in this scope, whether or not the
    // host itself matched: content hosts are usually plain custom elements
    // (ytd-*, video-*) with no role or tabindex of their own.
    node.querySelectorAll("*").forEach((el) => {
      const shadow = (el as HTMLElement).shadowRoot ?? null;
      if (shadow !== null) {
        if (stats !== undefined) stats.pierced += 1;
        walk(shadow);
      }
    });
  };
  walk(root);
  return out;
}

/** Collects candidate interactive elements; role filtering happens downstream. */
export function collectInteractives(root: ParentNode): InteractiveSet {
  const stats = { pierced: 0 };
  const found = queryDeep(root, INTERACTIVE_SELECTOR, stats);
  const items: Element[] = [];
  let skippedHidden = 0;
  found.forEach((el) => {
    if ((el as HTMLElement).tabIndex === -1 && !isNativelyFocusable(el)) {
      return;
    }
    if (!isVisible(el)) {
      skippedHidden += 1;
      return;
    }
    const role = resolveRole(el);
    if (role === "none" || role === "presentation") return;
    if (WIDGET_ROLES.has(role) || isFocusableCandidate(el)) {
      items.push(el);
    }
  });
  return { items, skippedHidden, shadowPierced: stats.pierced };
}

function isNativelyFocusable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href");
  if (tag === "button" || tag === "select" || tag === "textarea") return true;
  if (tag === "input") {
    return (el.getAttribute("type") ?? "text").toLowerCase() !== "hidden";
  }
  if (tag === "summary") return true;
  return el.hasAttribute("contenteditable");
}

function isFocusableCandidate(el: Element): boolean {
  const tabindex = (el as HTMLElement).tabIndex;
  if (Number.isInteger(tabindex) && (tabindex as number) >= 0) return true;
  return isNativelyFocusable(el);
}

// --- Readable prose regions ---------------------------------------------------

/**
 * Containers that hold the readable content of a page. Articles, docs, and
 * long-form posts live in these; everything else is chrome or controls.
 */
const PROSE_SELECTOR = [
  "article",
  "main",
  "[role='article']",
  "[role='main']",
  "[role='document']",
  ".article-body",
  ".post-content",
  ".entry-content",
  "#content",
].join(",");

/** Prose block elements whose text is real content, not chrome. */
const PROSE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "li",
  "blockquote",
  "pre",
  "figcaption",
  "dd",
  "dt",
  "td",
  "th",
]);

export interface ProseRegion {
  /** Stable-ish handle used as the read target id (e.g. "r1"). */
  id: string;
  /** Accessible-ish label: the region's heading, else a role word. */
  label: string;
  text: string;
  chars: number;
}

function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as Element).hasAttribute === "function"
  );
}

/** Elements whose text is never read as prose (chrome, controls, media). */
function isProseNoise(el: Element): boolean {
  if (!isVisible(el)) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") {
    return true;
  }
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true;
  return false;
}

/**
 * Collects the readable prose of a page, in document order.
 *
 * The element registry only holds interactive widgets, so on an article page
 * it contained a couple of nav links and nothing else — the model was never
 * shown the body text it was being asked to read. Regions are emitted with
 * their heading so `read` has something meaningful to target.
 */
export function getProseRegions(root: ParentNode, limit = 6): ProseRegion[] {
  const containers: Element[] = [];
  const seen = new Set<Element>();
  queryDeep(root, PROSE_SELECTOR).forEach((el) => {
    // Keep only the outermost container so nested <main>/<article> do not
    // duplicate the same text.
    if (el.parentElement?.closest(PROSE_SELECTOR) != null) return;
    if (isProseNoise(el)) return;
    containers.push(el);
    seen.add(el);
  });
  // No semantic container: fall back to the root itself when it is an Element
  // (a Document/ShadowRoot has no visibility semantics of its own).
  if (containers.length === 0 && isElement(root) && isVisible(root)) {
    containers.push(root);
  }

  const regions: ProseRegion[] = [];
  for (const container of containers) {
    if (regions.length >= limit) break;
    const parts: string[] = [];
    queryDeep(container, "*").forEach((el) => {
      if (el.children.length > 0 && (el as HTMLElement).shadowRoot === null) return; // leaves only: text lives in leaves
      if (!PROSE_BLOCK_TAGS.has(el.tagName.toLowerCase())) return;
      if (isProseNoise(el)) return;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text !== "") parts.push(text);
    });
    const text = parts.join(" ").trim();
    if (text === "") continue;
    const heading =
      queryDeep(container, "h1,h2,h3,[role='heading']")[0]?.textContent?.trim() ??
      "";
    regions.push({
      id: `r${regions.length + 1}`,
      label: heading !== "" ? heading.replace(/\s+/g, " ") : container.tagName.toLowerCase(),
      text,
      chars: text.length,
    });
  }
  return regions;
}

/**
 * Best readable region for an element: when the element is a heading or a
 * small wrapper, the region that actually contains the prose. Lets `read` on
 * an <h1> return the article body rather than the headline text.
 */
export function resolveProseRegionFor(el: Element): Element | null {
  const match = el.closest(PROSE_SELECTOR);
  if (match !== null && isVisible(match)) return match;
  // Not inside a known container: climb to the nearest block ancestor with
  // real prose in it.
  let node: Element | null = el.parentElement;
  while (node !== null) {
    if (isProseNoise(node)) return null;
    if (PROSE_BLOCK_TAGS.has(node.tagName.toLowerCase()) || node.tagName.toLowerCase() === "div") {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length > 120) return node;
    }
    node = node.parentElement;
  }
  return null;
}

// --- Page structure ---------------------------------------------------------

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface LandmarkInfo {
  role: string;
  name: string;
}

export interface FormInfo {
  name: string;
  fieldCount: number;
}

export function getHeadings(root: ParentNode): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  queryDeep(root, "h1,h2,h3,h4,h5,h6,[role='heading']")
    .forEach((el) => {
      if (!isVisible(el)) return;
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
      if (text === "") return;
      const m = /^h([1-6])$/.exec(el.tagName.toLowerCase());
      const level =
        m?.[1] !== undefined
          ? Number(m[1])
          : Number(el.getAttribute("aria-level") ?? 2);
      out.push({ level, text: text.slice(0, 200) });
    });
  return out;
}

export function getLandmarks(root: ParentNode): LandmarkInfo[] {
  const out: LandmarkInfo[] = [];
  queryDeep(
    root,
    "nav,main,header,footer,aside,form,[role='navigation'],[role='main'],[role='complementary'],[role='contentinfo'],[role='banner'],[role='search'],[role='region']",
  )
    .forEach((el) => {
      if (!isVisible(el)) return;
      out.push({
        role: resolveRole(el),
        name: (el.getAttribute("aria-label") ?? "").slice(0, 120),
      });
    });
  return out;
}

export function getForms(root: ParentNode): FormInfo[] {
  const out: FormInfo[] = [];
  queryDeep(root, "form").forEach((el) => {
    if (!isVisible(el)) return;
    out.push({
      name: (
        el.getAttribute("aria-label") ??
        el.getAttribute("name") ??
        ""
      ).slice(0, 120),
      fieldCount: queryDeep(el, "input,select,textarea").length,
    });
  });
  return out;
}

export function getOpenDialogs(root: ParentNode): Element[] {
  const out: Element[] = [];
  queryDeep(root, "dialog[open],[role='dialog'],[role='alertdialog']").forEach((el) => {
    if (isVisible(el)) out.push(el);
  });
  return out;
}
