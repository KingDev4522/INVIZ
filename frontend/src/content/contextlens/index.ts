/**
 * ContextLens orchestrator — REAL (PRD 6.1).
 * Builds the Raw Page State (Layer A foundation) from live DOM:
 * identity → interactive registry → structure → skipped-region accounting.
 * AI semantic state (Layer B) is filled by Phase 4 enrichment.
 */
import {
  collectInteractives,
  extractStates,
  getForms,
  getHeadings,
  getLandmarks,
  getOpenDialogs,
  getProseRegions,
  resolveProseRegionFor,
  resolveRole,
  type HeadingInfo,
  type LandmarkInfo,
  type FormInfo,
  type ProseRegion,
} from "../dom-extractor.js";
import {
  classifyField,
  computeAccessibleName,
} from "../aria-extractor.js";
import { ElementRegistry, type RegistryItem } from "../element-registry.js";

export interface RawPageState {
  url: string;
  title: string;
  generation: number;
  elementCount: number;
  structure: {
    headings: HeadingInfo[];
    landmarks: LandmarkInfo[];
    forms: FormInfo[];
    openDialogs: number;
  };
  /** Readable prose regions (article bodies). Without these the model cannot
   *  answer or read anything on a content page — the registry holds only
   *  interactive widgets. */
  prose: ProseRegion[];
  /**
   * Coverage accounting. `shadow` counts open shadow roots descended into
   * (their content IS included above) — not skipped content. Closed shadow
   * roots are unreachable by design and cannot be counted from outside.
   */
  skipped: { hidden: number; frames: number; shadow: number };
  extractedAt: number;
}

export class ContextLens {
  readonly registry = new ElementRegistry();
  private elementToId = new Map<Element, string>();
  private lastProse: ProseRegion[] = [];

  /** Full extraction + registry rebuild. Returns the new generation. */
  extract(doc: Document = document): RawPageState {
    const { items, skippedHidden, shadowPierced } = collectInteractives(doc);
    const regItems: RegistryItem[] = items.map((element) => {
      const role = resolveRole(element);
      const { name } = computeAccessibleName(element, doc);
      const states = extractStates(element, role);
      const field = classifyField(element);
      return { element, role, name, states, field };
    });
    const generation = this.registry.rebuild(regItems);

    this.elementToId = new Map<Element, string>();
    for (const entry of this.registry.snapshot()) {
      const live = regItems.find((_, index) => `e${index + 1}` === entry.id)
        ?.element;
      if (live !== undefined) this.elementToId.set(live, entry.id);
    }

    this.lastProse = getProseRegions(doc);

    let frames = 0;
    doc.querySelectorAll("iframe,frame,embed,object").forEach(() => {
      frames += 1;
    });

    return {
      url: location.href,
      title: doc.title,
      generation,
      elementCount: regItems.length,
      structure: {
        headings: getHeadings(doc),
        landmarks: getLandmarks(doc),
        forms: getForms(doc),
        openDialogs: getOpenDialogs(doc).length,
      },
      prose: this.lastProse,
      skipped: { hidden: skippedHidden, frames, shadow: shadowPierced },
      extractedAt: Date.now(),
    };
  }

  /** Registry identity for a live element (announcement/executor use). */
  identify(el: Element): { elementId: string | null; generation: number } {
    return {
      elementId: this.elementToId.get(el) ?? null,
      generation: this.registry.currentGeneration,
    };
  }

  /**
   * Readable container for an element. A heading maps to the article body it
   * introduces, so "read this" on an <h1> yields the article rather than the
   * headline. Falls back to the element itself when no prose region matches.
   */
  proseFor(el: Element): Element {
    return resolveProseRegionFor(el) ?? el;
  }

  /** Prose regions captured by the most recent extract(). */
  proseRegions(): ProseRegion[] {
    return this.lastProse;
  }
}
