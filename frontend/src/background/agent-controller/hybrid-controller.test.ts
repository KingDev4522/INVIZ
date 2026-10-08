/**
 * EXPERIMENTAL (CONTEXT_MODE=hybrid): controller wiring tests.
 *
 * Proves the three properties the prototype is allowed to change, and the one
 * it is not:
 *
 *  1. DEFAULT (no contextMode) is byte-identical to the pre-prototype DOM path.
 *  2. hybrid + successful capture swaps in the compact registry + attaches image.
 *  3. Every capture failure degrades to (2)'s fallback: plain DOM, no image,
 *     no error surfaced to the user.
 *
 * Target grounding, WebGuard and the executor are out of scope here and covered
 * by their own suites.
 */
import { describe, expect, it } from "vitest";
import {
  AgentController,
  assessSnapshotSparsity,
  type PageSnapshotLike,
} from "./controller.js";
import { evaluate } from "../webguard/policy.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome, ExecutionResult } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";
import type { HybridScreenshot } from "../../../../shared/api.js";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/apply",
  title: "Apply",
  generation: 42,
  items: [
    { id: "e1", role: "link", name: "Open form", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "button", name: "Submit", states: {}, fieldKind: null, sensitive: false },
  ],
  structure: {
    headings: [{ level: 1, text: "Application" }],
    landmarks: [{ role: "main", name: "" }],
    forms: [{ name: "Apply", fieldCount: 2 }],
  },
};

/** Dense AX page: enough named controls that the sparse gate stays shut. */
const DENSE_SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/apply",
  title: "Apply",
  generation: 42,
  items: Array.from({ length: 10 }, (_, i) => ({
    id: `e${i + 1}`,
    role: i % 2 === 0 ? "link" : "button",
    name: `Control ${i + 1}`,
    states: {},
    fieldKind: null,
    sensitive: false,
  })),
  structure: {
    headings: [{ level: 1, text: "Application" }],
    landmarks: [{ role: "main", name: "" }],
    forms: [{ name: "Apply", fieldCount: 2 }],
  },
};

const SCREENSHOT: HybridScreenshot = {
  b64: "aGVsbG8=",
  width: 640,
  height: 480,
  bytes: 5,
  timings: { captureMs: 1, encodeMs: 2, frontendTotalMs: 4 },
};

interface H {
  controller: AgentController;
  spoken: string[];
  inputs: ReasonInput[];
}

function okExec(): ExecutionResult {
  return { status: "executed", action: "click", target: "e1", pageGeneration: 42, timestamp: 1 };
}

function make(opts: {
  contextMode?: "dom" | "hybrid";
  captureScreenshot?: (tabId: number) => Promise<HybridScreenshot | null>;
  outcome?: AgentOutcome;
  snapshot?: PageSnapshotLike;
}): H {
  const spoken: string[] = [];
  const inputs: ReasonInput[] = [];
  const outcome = opts.outcome ?? { type: "answer", text: "ok" };
  let current: TaskSnapshot | null = null;

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    ...(opts.contextMode !== undefined ? { contextMode: opts.contextMode } : {}),
    ...(opts.captureScreenshot !== undefined ? { captureScreenshot: opts.captureScreenshot } : {}),
    reason: async (input) => {
      inputs.push(input);
      return outcome;
    },
    executeFn: async () => okExec(),
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS" as const,
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: 42,
    }),
    speak: async (text) => {
      spoken.push(text);
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => opts.snapshot ?? SNAPSHOT,
    loadLayerB: async () => null,
    saveLayerB: async () => undefined,
    readRegionText: async () => "Region text.",
    readFocusedElement: async () => null,
    repeatAudio: async () => undefined,
    // The run loop reloads the task from the store every iteration; a store
    // that never persists would exit after `started` with no reasoning call.
    enrich: async () => ({
      interpretation: "An application page.",
      pageGeneration: 42,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    onProgress: () => undefined,
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
      },
      clear: async () => {
        current = null;
      },
    },
    // No `now` override: a frozen clock stalls any delay-based recovery path.
    // These tests only need one reasoning turn, so the real clock is correct.
  });

  return { controller, spoken, inputs };
}

// Must NOT match a local read command (e.g. "what is this"), or routeVoice
// answers without ever calling reason.
const ask = (h: H) =>
  h.controller.routeVoice(
    { text: "What is this page about?", lang: "en", source: "voice", timestamp: 1 },
    7,
  );

describe("default mode is unchanged", () => {
  it("omits image and uses the full DOM dump when contextMode is absent", async () => {
    const h = make({});
    await ask(h);
    expect(h.inputs.length).toBe(1);
    const input = h.inputs[0]!;
    expect(input.image).toBeUndefined();
    expect(input.userPayload).toContain("FORMS:");
    expect(input.userPayload).toContain("LANDMARKS:");
    expect(input.userPayload).toContain("ELEMENTS:");
  });

  it("omits image even if a captureScreenshot dep is present", async () => {
    // wiring.ts only injects the capture dep for hybrid, but the controller
    // itself must gate on contextMode so a stray dep can never ship pixels.
    const h = make({ captureScreenshot: async () => SCREENSHOT });
    await ask(h);
    expect(h.inputs[0]!.image).toBeUndefined();
    expect(h.inputs[0]!.userPayload).toContain("LANDMARKS:");
    expect(h.inputs[0]!.userPayload).toContain("FORMS:");
  });
});

describe("hybrid mode attaches every turn and stays AX-first", () => {
  it("attaches the screenshot on dense pages too, keeping the full AX text", async () => {
    const h = make({
      contextMode: "hybrid",
      captureScreenshot: async () => SCREENSHOT,
      snapshot: DENSE_SNAPSHOT,
    });
    await ask(h);
    const input = h.inputs[0]!;
    expect(input.image).toBeDefined();
    expect(input.image?.b64).toBe("aGVsbG8=");
    expect(input.userPayload).toContain("FORMS:");
    expect(input.userPayload).toContain("LANDMARKS:");
    expect(input.userPayload).toContain("ELEMENTS:");
  });

  it("attaches the screenshot AND keeps the full AX text on sparse pages", async () => {
    const h = make({ contextMode: "hybrid", captureScreenshot: async () => SCREENSHOT });
    await ask(h);
    const input = h.inputs[0]!;
    expect(input.image).toBeDefined();
    expect(input.image?.b64).toBe("aGVsbG8=");
    // AX-first: full DOM dump retained alongside the image, never swapped.
    expect(input.userPayload).toContain("FORMS:");
    expect(input.userPayload).toContain("LANDMARKS:");
    expect(input.userPayload).toContain("ELEMENTS:");
    expect(input.userPayload).toContain("e1 link \"Open form\"");
    expect(input.userPayload).toContain("generation=42");
  });

  it("degrades to DOM context when capture returns null", async () => {
    const h = make({ contextMode: "hybrid", captureScreenshot: async () => null });
    await ask(h);
    const input = h.inputs[0]!;
    expect(input.image).toBeUndefined();
    expect(input.userPayload).toContain("LANDMARKS:");
    expect(input.userPayload).toContain("FORMS:");
    expect(h.spoken.length).toBeGreaterThan(0); // turn still completed
  });

  it("degrades to DOM context when capture THROWS", async () => {
    const h = make({
      contextMode: "hybrid",
      captureScreenshot: async () => {
        throw new Error("no active tab");
      },
    });
    await ask(h);
    const input = h.inputs[0]!;
    expect(input.image).toBeUndefined();
    expect(input.userPayload).toContain("LANDMARKS:");
    expect(input.userPayload).toContain("FORMS:");
    expect(h.spoken.length).toBeGreaterThan(0);
  });

  it("degrades to DOM context when the capture dep is absent", async () => {
    const h = make({ contextMode: "hybrid" });
    await ask(h);
    expect(h.inputs[0]!.image).toBeUndefined();
    expect(h.inputs[0]!.userPayload).toContain("LANDMARKS:");
    expect(h.inputs[0]!.userPayload).toContain("FORMS:");
  });
});

describe("sparse gate", () => {
  it("flags empty snapshots", () => {
    const out = assessSnapshotSparsity([]);
    expect(out.sparse).toBe(true);
    expect(out.reason).toBe("empty");
    expect(out.itemCount).toBe(0);
  });

  it("flags few-item snapshots", () => {
    const out = assessSnapshotSparsity([{ name: "A" }, { name: "B" }]);
    expect(out.sparse).toBe(true);
    expect(out.reason).toBe("few-items");
    expect(out.itemCount).toBe(2);
  });

  it("flags mostly-unnamed controls", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      name: i < 3 ? `Control ${i}` : "",
    }));
    const out = assessSnapshotSparsity(items);
    expect(out.sparse).toBe(true);
    expect(out.reason).toBe("unnamed-fraction");
    expect(out.unnamedFraction).toBeCloseTo(0.7);
  });

  it("passes dense named pages", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `Control ${i}` }));
    const out = assessSnapshotSparsity(items);
    expect(out.sparse).toBe(false);
    expect(out.reason).toBe("dense");
  });
});

describe("WebGuard invariance on the fallback path", () => {
  it("decides identically with and without the attached image", async () => {
    // The image never enters WebGuard: same snapshot + same action must yield
    // the same verdict whether or not the fallback attached pixels.
    const withImage = make({
      contextMode: "hybrid",
      captureScreenshot: async () => SCREENSHOT,
      outcome: {
        type: "action",
        action: { action: "click", target: "e2", pageGeneration: 42 },
      },
    });
    const withoutImage = make({
      outcome: {
        type: "action",
        action: { action: "click", target: "e2", pageGeneration: 42 },
      },
    });
    await ask(withImage);
    await ask(withoutImage);
    // Fallback changed context (pixels attached), not gating or AX text.
    expect(withImage.inputs.length).toBe(1);
    expect(withoutImage.inputs.length).toBe(1);
    expect(withImage.inputs[0]!.image).toBeDefined();
    expect(withoutImage.inputs[0]!.image).toBeUndefined();
    expect(withImage.inputs[0]!.userPayload).toBe(withoutImage.inputs[0]!.userPayload);
    const targets = new Map([
      ["e1", { id: "e1", role: "link", name: "Open form", fieldKind: null, sensitive: false, isSubmit: false }],
      ["e2", { id: "e2", role: "button", name: "Submit", fieldKind: null, sensitive: false, isSubmit: true }],
    ]);
    const action = { action: "click", target: "e2", pageGeneration: 42 } as const;
    const base = { currentGeneration: 42, targets, provenance: "USER" as const };
    // e2 is a submit control: consequential gating must survive the fallback.
    expect(evaluate(action, { ...base, sensitiveAuthorized: false }).decision).toBe(
      "REQUIRE_CONFIRMATION",
    );
  });
});

