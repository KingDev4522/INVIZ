/**
 * Element registry: generation-scoped eNN → live DOM element mapping
 * (PRD 6.1 §1.2; PRD 3 §26–28; PRD 4 §10–11).
 * IDs are valid only within their page generation. Live references stay in
 * content-script memory; only metadata crosses contexts.
 */

import type { FieldInfo } from "./dom-extractor.js";

export interface RegistryEntry {
  id: string;
  generation: number;
  element: Element;
  role: string;
  name: string;
  states: Record<string, string | boolean | number>;
  field: FieldInfo | null;
}

export type ResolveResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; code: "STALE_TARGET" | "ELEMENT_NOT_FOUND" };

export interface RegistryItem {
  element: Element;
  role: string;
  name: string;
  states: Record<string, string | boolean | number>;
  field: FieldInfo | null;
}

export class ElementRegistry {
  private generation = 0;
  private entries = new Map<string, RegistryEntry>();

  get currentGeneration(): number {
    return this.generation;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Rebuilds the registry from a fresh extraction; invalidates all old IDs. */
  rebuild(items: RegistryItem[]): number {
    this.generation += 1;
    this.entries.clear();
    items.forEach((item, index) => {
      const id = `e${index + 1}`;
      this.entries.set(id, { ...item, id, generation: this.generation });
    });
    return this.generation;
  }

  resolve(id: string, generation: number): ResolveResult {
    if (!/^e\d+$/.test(id)) {
      return { ok: false, code: "ELEMENT_NOT_FOUND" };
    }
    if (generation !== this.generation) {
      return { ok: false, code: "STALE_TARGET" };
    }
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { ok: false, code: "ELEMENT_NOT_FOUND" };
    }
    if (!entry.element.isConnected) {
      return { ok: false, code: "STALE_TARGET" };
    }
    return { ok: true, entry };
  }

  /** Snapshot metadata for PageState (no live references cross contexts). */
  snapshot(): Array<{
    id: string;
    role: string;
    name: string;
    states: Record<string, string | boolean | number>;
    fieldKind: string | null;
    sensitive: boolean;
  }> {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      role: e.role,
      name: e.name,
      states: e.states,
      fieldKind: e.field?.kind ?? null,
      sensitive: e.field?.sensitive ?? false,
    }));
  }
}
