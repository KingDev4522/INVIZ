/**
 * Layer-B freshness policy (PRD 3 §30). Pure and deterministic — safe on
 * either side of the frontend/backend boundary. The frontend decides WHEN to
 * call /v1/enrich; the backend only executes enrichment.
 */
import { LAYER_B_FRESHNESS_TTL_MS } from "./constants.js";
import type { LayerB } from "./api.js";

/**
 * Page-change trigger vocabulary, mirrored from the frontend observer
 * (frontend/src/content/page-observer.ts). String-typed deliberately.
 */
export type PageChangeTrigger =
  | "full-navigation"
  | "route"
  | "modal"
  | "counts"
  | "form-structure"
  | "results"
  | "busy"
  | "root"
  | "bfcache"
  | "minor";

const MEANINGFUL_TRIGGERS: ReadonlySet<PageChangeTrigger> = new Set([
  "route",
  "modal",
  "form-structure",
  "results",
  "counts",
  "busy",
  "root",
  "bfcache",
]);

/**
 * Should Layer B be (re)built for this trigger? Minor churn never qualifies.
 * Meaningful triggers qualify only when there is no usable interpretation:
 * absent, generation-mismatched, or older than the freshness TTL.
 */
export function needsRefresh(
  trigger: PageChangeTrigger,
  layerB: LayerB | null,
  currentGeneration: number,
  nowMs: number = Date.now(),
): boolean {
  if (!MEANINGFUL_TRIGGERS.has(trigger)) return false;
  if (layerB === null) return true;
  if (layerB.pageGeneration !== currentGeneration) return true;
  if (layerB.interpretation === "") return true;
  return nowMs - layerB.producedAt >= LAYER_B_FRESHNESS_TTL_MS;
}
