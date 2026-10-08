/**
 * Freshness policy tests (PRD 6.4 §1.4, PRD 3 §30).
 * Minor churn never qualifies; meaningful triggers qualify only when the
 * interpretation is absent, mismatched, or stale. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { needsRefresh } from "./refresh-policy.js";
import type { LayerB } from "./api.js";
import { LAYER_B_FRESHNESS_TTL_MS } from "./constants.js";

function fresh(gen: number, now: number): LayerB {
  return {
    interpretation: "A job application page.",
    pageGeneration: gen,
    producedAt: now - 1000,
    provenance: "MODEL_INFERENCE",
  };
}

describe("needsRefresh", () => {
  it("minor churn never qualifies", () => {
    expect(needsRefresh("minor", null, 3, 0)).toBe(false);
    expect(needsRefresh("minor", fresh(3, 0), 3, 1_000_000)).toBe(false);
  });

  it("meaningful triggers qualify when interpretation is absent or mismatched", () => {
    expect(needsRefresh("route", null, 3, 0)).toBe(true);
    expect(needsRefresh("modal", fresh(2, 0), 3, 1000)).toBe(true);
    expect(needsRefresh("results", { ...fresh(3, 0), interpretation: "" }, 3, 1000)).toBe(true);
  });

  it("fresh same-generation Layer B is left alone", () => {
    const now = 50_000;
    for (const trigger of ["route", "modal", "form-structure", "results", "counts", "busy", "root", "bfcache"] as const) {
      expect(needsRefresh(trigger, fresh(3, now - 1000), 3, now)).toBe(false);
    }
  });

  it("stale Layer B re-qualifies on meaningful triggers", () => {
    const now = LAYER_B_FRESHNESS_TTL_MS + 60_000;
    expect(needsRefresh("results", fresh(3, 0), 3, now)).toBe(true);
    expect(needsRefresh("minor", fresh(3, 0), 3, now)).toBe(false);
  });
});
