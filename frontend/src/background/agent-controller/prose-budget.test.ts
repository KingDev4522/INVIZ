/**
 * Prose gating + token-budget regressions (live-measured).
 *
 * Measured: a reasoning call costs ~1071 input tokens without page prose and
 * ~3400 with a full article, against an ~8000-token/minute budget shared by
 * every key on the account. Sending the whole article on every navigation turn
 * spent a third of the budget per click and caused constant "too many
 * requests".
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

const ARTICLE =
  "A screen reader reads text aloud so people who cannot see the screen can navigate. ".repeat(20);

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/article",
  title: "Understanding Screen Readers",
  generation: 42,
  items: [
    { id: "e1", role: "link", name: "World", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "button", name: "Search", states: {}, fieldKind: null, sensitive: false },
  ],
  structure: {
    headings: [{ level: 1, text: "Understanding Screen Readers" }],
    landmarks: [{ role: "main", name: "" }],
    forms: [],
  },
  prose: [
    { id: "r1", label: "Understanding Screen Readers", text: ARTICLE, chars: ARTICLE.length },
  ],
};

async function payloadFor(goal: string): Promise<string> {
  const payloads: string[] = [];
  let current: TaskSnapshot | null = null;
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async (input: ReasonInput) => {
      payloads.push(input.userPayload);
      return { type: "task_complete" } as AgentOutcome;
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
    speak: async () => undefined,
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => ({
      interpretation: "x",
      pageGeneration: 42,
      producedAt: Date.now(),
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
    readRegionText: async () => ARTICLE,
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
  await controller.routeVoice(
    { text: goal, lang: "en", source: "voice", timestamp: 1 },
    7,
  );
  return payloads[0] ?? "";
}

describe("navigation turns do not pay for the whole article", () => {
  it("omits page prose for a plain click goal", async () => {
    const payload = await payloadFor("click the search button");
    expect(payload).not.toContain("PROSE");
  });

  it("omits page prose for typing into a field", async () => {
    const payload = await payloadFor("type ada@example.com in the email field");
    expect(payload).not.toContain("PROSE");
  });

  it("omits page prose for submitting", async () => {
    const payload = await payloadFor("submit the application");
    expect(payload).not.toContain("PROSE");
  });

  it("still sends the element list, so navigation can work", async () => {
    const payload = await payloadFor("click the search button");
    expect(payload).toContain("e2 button");
    expect(payload).toContain("H1 Understanding Screen Readers");
  });
});

describe("content turns still get the prose", () => {
  it("includes prose when the user asks to read", async () => {
    expect(await payloadFor("read this article out loud")).toContain("PROSE");
  });

  it("includes prose when the user asks for a summary", async () => {
    expect(await payloadFor("summarize this page")).toContain("PROSE");
  });

  it("includes prose for a what-does-this-page question", async () => {
    expect(await payloadFor("what does this page do?")).toContain("PROSE");
  });

  it("trims the prose it does send, so one call cannot blow the budget", async () => {
    const payload = await payloadFor("summarize this article");
    // The full article is ~1400 chars; the interactive budget is 1200.
    expect(payload.length).toBeLessThan(4000);
    expect(payload).toContain("PROSE");
  });

  it("advertises the region id so the model can read the full text", async () => {
    const payload = await payloadFor("read this article");
    expect(payload).toContain('r1 "Understanding Screen Readers"');
  });
});