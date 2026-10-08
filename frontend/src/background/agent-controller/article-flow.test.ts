/**
 * Article-reading and call-budget regressions (live-proven failures).
 *
 * 1. On an article page the serialized page carried no prose, so the model was
 *    asked to read content it had never been shown.
 * 2. A failed advisory /v1/enrich was retried on EVERY step, doubling the
 *    Qwen calls of a turn and triggering provider rate limits mid-voice-turn.
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const ARTICLE_PROSE =
  "A screen reader reads text aloud so people who cannot see the screen can navigate. " +
  "Assistive technology depends on semantic markup and a real document outline.";

const ARTICLE_SNAPSHOT: PageSnapshotLike = {
  url: "https://news.example.com/article",
  title: "Understanding Screen Readers",
  generation: 42,
  items: [{ id: "e1", role: "link", name: "World", states: {}, fieldKind: null, sensitive: false }],
  structure: {
    headings: [{ level: 1, text: "Understanding Screen Readers" }],
    landmarks: [{ role: "main", name: "" }],
    forms: [],
  },
  prose: [
    {
      id: "r1",
      label: "Understanding Screen Readers",
      text: ARTICLE_PROSE,
      chars: ARTICLE_PROSE.length,
    },
  ],
};

const voice = (text: string) => ({ text, lang: "en" as const, source: "voice" as const, timestamp: 1 });

interface Built {
  controller: AgentController;
  spoken: string[];
  reasonInputs: ReasonInput[];
  enrichCalls: number;
  readCalls: Array<{ target: string | undefined; maxChars: number }>;
  readText: string;
  status: () => TaskSnapshot["status"] | null;
}

async function build(opts: {
  outcomes: AgentOutcome[];
  snapshot?: PageSnapshotLike;
  enrichFails?: boolean;
  readText?: string;
}): Promise<Built> {
  const spoken: string[] = [];
  const reasonInputs: ReasonInput[] = [];
  const readCalls: Built["readCalls"] = [];
  let enrichCalls = 0;
  let current: TaskSnapshot | null = null;
  const queue = [...opts.outcomes];
  let now = 1_000_000;

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async (input: ReasonInput) => {
      reasonInputs.push(input);
      const next = queue.shift();
      if (next === undefined) return { type: "task_complete" } as AgentOutcome;
      return next;
    },
    enrich: async () => {
      enrichCalls += 1;
      if (opts.enrichFails === true) throw new Error("enrich 429 rate limited");
      return {
        interpretation: "An article about screen readers.",
        pageGeneration: 42,
        producedAt: now,
        provenance: "MODEL_INFERENCE" as const,
      };
    },
    executeFn: async () => ({
      status: "executed" as const,
      action: "click",
      target: "e1",
      pageGeneration: 42,
      timestamp: 1,
    }),
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
    loadSnapshot: async () => opts.snapshot ?? ARTICLE_SNAPSHOT,
    // Always stale, so the refresh policy asks for enrichment every step.
    loadLayerB: async () => null,
    saveLayerB: async () => undefined,
    readRegionText: async (_tabId, target, maxChars) => {
      readCalls.push({ target, maxChars });
      return opts.readText ?? ARTICLE_PROSE;
    },
    readFocusedElement: async () => null,
    repeatAudio: async () => undefined,
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
      },
      clear: async () => {
        current = null;
      },
    },
    now: () => now,
  });

  return {
    controller,
    spoken,
    reasonInputs,
    get enrichCalls() {
      return enrichCalls;
    },
    readCalls,
    readText: opts.readText ?? ARTICLE_PROSE,
    status: () => current?.status ?? null,
  } as Built;
}

describe("article prose reaches the model", () => {
  it("includes the page's readable text in the reasoning payload", async () => {
    const h = await build({ outcomes: [{ type: "answer", text: "It is about screen readers." }] });
    await h.controller.routeVoice(voice("read this article"), 7);
    const payload = h.reasonInputs[0]?.userPayload ?? "";
    expect(payload).toContain("PROSE");
    expect(payload).toContain("A screen reader reads text aloud");
    expect(payload).toContain('r1 "Understanding Screen Readers"');
  });

  it("includes real headings and landmarks, not empty placeholders", async () => {
    const h = await build({ outcomes: [{ type: "answer", text: "ok" }] });
    await h.controller.routeVoice(voice("what is this page"), 7);
    const payload = h.reasonInputs[0]?.userPayload ?? "";
    expect(payload).toContain("H1 Understanding Screen Readers");
    expect(payload).toContain("LANDMARKS: main");
  });

  it("routes a read action at the prose region and speaks the body", async () => {
    const h = await build({
      outcomes: [
        { type: "action", action: { action: "read", target: "r1" } },
        { type: "task_complete" },
      ],
    });
    await h.controller.routeVoice(voice("read this article out loud"), 7);
    expect(h.readCalls[0]?.target).toBe("r1");
    expect(h.spoken.join(" ")).toContain("A screen reader reads text aloud");
  });

  it("still works on a page with no prose", async () => {
    const bare: PageSnapshotLike = {
      url: "https://example.com/",
      title: "Home",
      generation: 1,
      items: [{ id: "e1", role: "button", name: "Go", states: {}, fieldKind: null, sensitive: false }],
    };
    const h = await build({
      snapshot: bare,
      outcomes: [{ type: "answer", text: "A landing page." }],
    });
    await h.controller.routeVoice(voice("what is this page"), 7);
    const payload = h.reasonInputs[0]?.userPayload ?? "";
    expect(payload).not.toContain("PROSE");
    expect(h.spoken.join(" ")).toContain("A landing page.");
  });
});

describe("failed enrichment is not retried every step", () => {
  it("calls enrich once across a multi-step turn when it fails", async () => {
    const h = await build({
      enrichFails: true,
      outcomes: [
        { type: "action", action: { action: "click", target: "e1" } },
        { type: "action", action: { action: "click", target: "e1" } },
        { type: "task_complete" },
      ],
    });
    await h.controller.routeVoice(voice("click through the page"), 7);
    // The retry-per-step bug made this equal to the step count.
    expect(h.enrichCalls).toBe(1);
    expect(h.reasonInputs.length).toBeGreaterThan(1);
  });

  it("still completes the task on Layer A alone when enrich fails", async () => {
    const h = await build({
      enrichFails: true,
      outcomes: [
        { type: "action", action: { action: "click", target: "e1" } },
        { type: "task_complete" },
      ],
    });
    await h.controller.routeVoice(voice("click the link"), 7);
    expect(h.status()).toBe("COMPLETE");
  });

  it("retries enrich for a new page generation", async () => {
    let generation = 42;
    const spoken: string[] = [];
    let current: TaskSnapshot | null = null;
    let enrichCalls = 0;
    const controller = new AgentController({
      backend: { url: "http://127.0.0.1:8787" },
      reason: async () => ({ type: "task_complete" }) as AgentOutcome,
      enrich: async () => {
        enrichCalls += 1;
        throw new Error("enrich unavailable");
      },
      executeFn: async () => ({
        status: "executed" as const,
        action: "click",
        target: "e1",
        pageGeneration: generation,
        timestamp: 1,
      }),
      verifyFn: async () => ({
        success: true,
        outcome: "VERIFIED_SUCCESS" as const,
        expected: {},
        observed: null,
        timedOut: false,
        pageGeneration: generation,
      }),
      speak: async (text) => {
        spoken.push(text);
      },
      stopAudio: async () => undefined,
      setAgentActive: async () => undefined,
      // The page changes generation between steps (navigation after a click).
      loadSnapshot: async () => ({ ...ARTICLE_SNAPSHOT, generation }),
      loadLayerB: async () => null,
      saveLayerB: async () => undefined,
      readRegionText: async () => ARTICLE_PROSE,
      readFocusedElement: async () => null,
      repeatAudio: async () => undefined,
      store: {
        load: async () => current,
        save: async (s) => {
          current = { ...s };
        },
        clear: async () => {
          current = null;
        },
      },
    });

    await controller.routeVoice(voice("click through"), 7);
    generation = 43;
    // First task finished; a fresh task on the new generation must re-ask.
    current = null;
    await controller.routeVoice(voice("click again"), 7);
    expect(enrichCalls).toBeGreaterThanOrEqual(2);
  });
});