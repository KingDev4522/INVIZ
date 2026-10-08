/**
 * PageState session persistence (PRD 6 §4.6; PRD 4 §12–13).
 * Owned by the service worker: content scripts hold live references and send
 * metadata snapshots; this store persists them per-tab in
 * chrome.storage.session (in-memory, 10MB quota, dies on browser close).
 * Layer B policy shell included; enrichment fills it in Phase 4 (PRD 6.4).
 */
import {
  LAYER_B_FRESHNESS_TTL_MS,
  PAGE_STATE_TAB_CAP_BYTES,
  pageStateKey,
} from "../../../shared/constants.js";
import { logger } from "../../../shared/logger.js";

export interface PageSnapshotItem {
  id: string;
  role: string;
  name: string;
  states: Record<string, string | boolean | number>;
  fieldKind: string | null;
  sensitive: boolean;
}

export interface StoredPageState {
  tabId: number;
  url: string;
  title: string;
  generation: number;
  items: PageSnapshotItem[];
  skipped: { hidden: number; frames: number; shadow: number };
  savedAt: number;
  /** True when items were truncated to fit the per-tab cap. */
  truncated: boolean;
}

export interface LayerBShell {
  generation: number;
  producedAt: number; // 0 = empty (Phase 0–3)
  interpretation: null;
  provenance: "MODEL_INFERENCE";
}

export const layerBPolicy = {
  ttlMs: LAYER_B_FRESHNESS_TTL_MS,
  empty(generation: number): LayerBShell {
    return {
      generation,
      producedAt: 0,
      interpretation: null,
      provenance: "MODEL_INFERENCE",
    };
  },
  /** Empty-or-stale Layer B is excluded from every consumer (PRD 3 §30). */
  isFresh(entry: LayerBShell | null, now: number = Date.now()): boolean {
    if (entry === null || entry.interpretation === null) return false;
    return now - entry.producedAt < this.ttlMs;
  },
};

const MAX_TRACKED_TABS = 10;

async function touchLru(tabId: number): Promise<void> {
  const key = "page:lru";
  const stored = await chrome.storage.session.get(key);
  const lru = (stored[key] as number[] | undefined) ?? [];
  const next = [tabId, ...lru.filter((t) => t !== tabId)].slice(0, MAX_TRACKED_TABS);
  const evicted = lru.filter((t) => !next.includes(t));
  await chrome.storage.session.set({ [key]: next });
  for (const tab of evicted) {
    await chrome.storage.session.remove(pageStateKey(tab));
  }
  if (evicted.length > 0) {
    logger.debug("pagestate: evicted tabs", { evicted: String(evicted.length) });
  }
}

/**
 * Stores one tab's snapshot, enforcing the 1MB per-tab cap by truncating
 * items from the tail (least significant last) and recording the cut.
 */
export async function storePageState(
  state: StoredPageState,
): Promise<{ stored: boolean; truncated: boolean }> {
  let items = state.items;
  let truncated = false;
  let raw = JSON.stringify({ ...state, items });
  if (raw.length > PAGE_STATE_TAB_CAP_BYTES) {
    // Binary-search the largest fitting prefix to avoid O(n) re-serializing.
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (JSON.stringify({ ...state, items: items.slice(0, mid) }).length <= PAGE_STATE_TAB_CAP_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    items = items.slice(0, lo);
    truncated = true;
    raw = JSON.stringify({ ...state, items });
    logger.warn("pagestate: snapshot truncated to fit cap", {
      tabId: String(state.tabId),
      keptItems: String(items.length),
    });
  }
  await chrome.storage.session.set({
    [pageStateKey(state.tabId)]: { ...state, items, truncated },
  });
  await touchLru(state.tabId);
  void raw;
  return { stored: true, truncated };
}

export async function loadPageState(tabId: number): Promise<StoredPageState | null> {
  const stored = await chrome.storage.session.get(pageStateKey(tabId));
  const state = stored[pageStateKey(tabId)] as StoredPageState | undefined;
  return state ?? null;
}
