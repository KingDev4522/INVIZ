/**
 * Web-search flow tests: the model alone decides to search (no command
 * parsing, no buttons). Results feed the next reasoning step, which answers
 * from them or navigates to one of their URLs.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { SearchResultItem } from "../../../../shared/api.js";
import type { TaskSnapshot } from "../task-state/store.js";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/",
  title: "Example",
  generation: 1,
  items: [],
};

const RESULTS: SearchResultItem[] = [
  { title: "First Pizza Place", url: "https://example.com/1", snippet: "Great crust." },
  { title: "Second Pizza Place", url: "https://example.com/2", snippet: "Wood fired." },
];

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
  turnId: "turn_search_1",
});

interface Built {
  controller: AgentController;
  spoken: string[];
  reasonInputs: ReasonInput[];
  searches: string[];
  navigated: string[];
}

function build(outcomes: AgentOutcome[], searchResults: SearchResultItem[] = RESULTS): Built {
  const spoken: string[] = [];
  const reasonInputs: ReasonInput[] = [];
  const searches: string[] = [];
  const navigated: string[] = [];
  let current: TaskSnapshot | null = null;
  const queue = [...outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async (input: ReasonInput) => {
      reasonInputs.push(input);
      const next = queue.shift();
      if (next === undefined) return { type: "task_complete" } as AgentOutcome;
      return next;
    },
    search: async (input) => {
      searches.push(input.query);
      return { results: searchResults };
    },
    enrich: async () => ({
      interpretation: "An example page.",
      pageGeneration: 1,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (action) => {
      const params = action.parameters as { url?: unknown } | undefined;
      if (typeof params?.url === "string") navigated.push(params.url);
      return { status: "executed", action: action.action, pageGeneration: 1, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS" as const,
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: 1,
    }),
    speak: async (text) => {
      spoken.push(text);
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => ({
      interpretation: "cached",
      pageGeneration: 1,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
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
  return { controller, spoken, reasonInputs, searches, navigated };
}

describe("model-driven web_search", () => {
  it("feeds results into the next reasoning step and speaks a summary", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "pizza" } } },
      { type: "answer", text: "Two great options." },
    ]);
    await built.controller.routeVoice(voice("find me pizza"), 3);
    expect(built.searches).toEqual(["pizza"]);
    expect(built.reasonInputs.length).toBe(2);
    expect(built.reasonInputs[1]?.userPayload).toContain("First Pizza Place");
    expect(built.spoken.some((s) => s.includes("Found 2 results"))).toBe(true);
  });

  it("lets the model navigate to a searched URL with existing actions", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "pizza" } } },
      {
        type: "action",
        action: {
          action: "navigate",
          pageGeneration: 1,
          parameters: { url: "https://example.com/2" },
        },
      },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("find me pizza and open a good place"), 3);
    expect(built.searches).toEqual(["pizza"]);
    expect(built.navigated).toEqual(["https://example.com/2"]);
  });

  it("refuses a navigational search (open-site goal) without spending Tavily", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "youtube" } } },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("open youtube"), 3);
    expect(built.searches).toEqual([]);
  });

  it("refuses a duplicate search with the same query", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "pizza" } } },
      { type: "action", action: { action: "web_search", parameters: { query: "  Pizza! " } } },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("find me pizza"), 3);
    expect(built.searches).toEqual(["pizza"]);
  });

  it("caps searches per task and reuses observations instead", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "pizza" } } },
      { type: "action", action: { action: "web_search", parameters: { query: "pizza toppings" } } },
      { type: "action", action: { action: "web_search", parameters: { query: "pizza history" } } },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("find me pizza"), 3);
    expect(built.searches).toEqual(["pizza", "pizza toppings"]);
  });
});
