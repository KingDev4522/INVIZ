/**
 * Article search-to-open fast-path: "open the latest news article of India"
 * web-searches the user's own words and navigates straight to the best
 * observed result — zero reasoning calls, nothing hardcoded.
 */
import { describe, expect, it } from "vitest";
import {
  AgentController,
  extractArticleQuery,
  isArticleOpenGoal,
  type PageSnapshotLike,
} from "./controller.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { TaskSnapshot } from "../task-state/store.js";

describe("article-open goal detection (generic, no hardcoded topics)", () => {
  it("matches any topic, not current-page reads", () => {
    expect(isArticleOpenGoal("open the latest news article of India")).toBe(true);
    expect(isArticleOpenGoal("open a science article")).toBe(true);
    expect(isArticleOpenGoal("find a space article about black holes and open it")).toBe(true);
    expect(isArticleOpenGoal("read this article")).toBe(false);
    expect(isArticleOpenGoal("summarize this article")).toBe(false);
    expect(isArticleOpenGoal("open YouTube")).toBe(false);
  });
  it("extracts the user's own words as the query", () => {
    expect(extractArticleQuery("open the latest news article of India")).toContain("India");
    expect(extractArticleQuery("open a science article")).toBe("a science article");
  });
});

function build(results: Array<{ title: string; url: string; snippet: string }>) {
  const executed: string[] = [];
  const navUrls: string[] = [];
  const searches: string[] = [];
  const spoken: string[] = [];
  let current: TaskSnapshot | null = null;
  let reasonCalls = 0;
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => {
      reasonCalls += 1;
      return { type: "task_complete" } as AgentOutcome;
    },
    search: async (input) => {
      searches.push(input.query);
      return { results };
    },
    executeFn: async (action) => {
      executed.push(action.action);
      const p = action.parameters as { url?: unknown } | undefined;
      if (typeof p?.url === "string") navUrls.push(p.url);
      return { status: "executed", action: action.action, pageGeneration: 0, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS" as const,
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: 0,
    }),
    speak: async (t) => {
      spoken.push(t);
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async (): Promise<PageSnapshotLike | null> => null,
    loadLayerB: async () => null,
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
  return { controller, executed, navUrls, searches, spoken, reasonCalls: () => reasonCalls, current: () => current };
}

describe("article search-to-open fast-path", () => {
  it("searches the user's words and opens the observed article with zero reasoning", async () => {
    const b = build([
      { title: "India latest news - Example Times", url: "https://example.com/india-news", snippet: "An article about India news" },
    ]);
    await b.controller.routeVoice(
      { text: "open the latest news article of India", lang: "en", source: "voice", timestamp: 1 },
      7,
    );
    expect(b.searches).toHaveLength(1);
    expect(b.searches[0]).toContain("India");
    expect(b.navUrls).toEqual(["https://example.com/india-news"]);
    expect(b.reasonCalls()).toBe(0);
    expect(b.current()?.status).toBe("COMPLETE");
  }, 20000);
});
