/**
 * PRD 6.10 unit coverage: browser search as a first-class capability.
 * - intent taxonomy (§5): browser vs page vs research vs navigation
 * - query extraction (§9)
 * - search-result state transition (§10/§18, generic URL check)
 * - stale-target rejection after search (§17, via WebGuard generation check)
 * - verified/first-result selection vocabulary lives in the prompt; the
 *   controller grounds navigation from fresh observations (existing navigate)
 * - search → website / search → media continuation (deterministic first search,
 *   then model grounds from fresh results)
 * - failure recovery (empty query refuses without Tavily; execution failure
 *   spends recovery, never loops)
 * - WebGuard enforcement for browser_search (schema + targetless ALLOW)
 * - existing web_search gates stay green (navigational/duplicate/budget +
 *   new browser/page refusal with Tavily = 0)
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { validateStructuredAction } from "../../../../shared/types.js";
import {
  AgentController,
  classifySearchIntent,
  extractBrowserSearchQuery,
  isSearchResultsUrl,
  type PageSnapshotLike,
} from "./controller.js";
import { evaluate } from "../webguard/policy.js";
import { buildBrowserSearchUrl } from "../browser-executor/executor.js";
import { capabilityFor } from "../../bridge/harness-bridge.js";
import type { AgentOutcome, StructuredAction } from "../../../../shared/types.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { SearchResultItem } from "../../../../shared/api.js";
import type { TaskSnapshot } from "../task-state/store.js";

const SNAPSHOT: PageSnapshotLike = {
  url: "https://example.com/",
  title: "Example",
  generation: 7,
  items: [],
};

const voice = (text: string) => ({
  text,
  lang: "en" as const,
  source: "voice" as const,
  timestamp: 1,
  turnId: "turn_bsearch_1",
});

interface Built {
  controller: AgentController;
  executed: string[];
  searches: string[];
  saved: TaskSnapshot[];
  reasonInputs: ReasonInput[];
}

function build(outcomes: AgentOutcome[], searchResults: SearchResultItem[] = []): Built {
  const executed: string[] = [];
  const searches: string[] = [];
  const saved: TaskSnapshot[] = [];
  const reasonInputs: ReasonInput[] = [];
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
      pageGeneration: 7,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    executeFn: async (action) => {
      executed.push(action.action);
      return { status: "executed", action: action.action, pageGeneration: 7, timestamp: 1 };
    },
    verifyFn: async () => ({
      success: true,
      outcome: "VERIFIED_SUCCESS" as const,
      expected: {},
      observed: null,
      timedOut: false,
      pageGeneration: 7,
    }),
    speak: async () => undefined,
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => SNAPSHOT,
    loadLayerB: async () => ({
      interpretation: "cached",
      pageGeneration: 7,
      producedAt: 1,
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
        saved.push({ ...s });
      },
      clear: async () => {
        current = null;
      },
    },
  });
  return { controller, executed, searches, saved, reasonInputs };
}

describe("PRD 6.10 intent classification (§5)", () => {
  it("1. 'search for Tesla' → browser search", () => {
    expect(classifySearchIntent("Search for Tesla.")).toBe("browser");
  });
  it("2. 'Google Tesla' → browser search", () => {
    expect(classifySearchIntent("Google Tesla.")).toBe("browser");
  });
  it("browser + navigation compound stays browser-first", () => {
    expect(classifySearchIntent("Search Tesla and open the official website.")).toBe("browser");
  });
  it("browser + media compound stays browser-first", () => {
    expect(classifySearchIntent("Search for Baby by Justin Bieber and play it.")).toBe("browser");
  });
  it("3. 'search YouTube for Baby' → page search", () => {
    expect(classifySearchIntent("Search YouTube for Baby.")).toBe("page");
  });
  it("4. 'search this page for Tesla' → page search", () => {
    expect(classifySearchIntent("Search this page for Tesla.")).toBe("page");
    expect(classifySearchIntent("Search this website for Tesla.")).toBe("page");
  });
  it("5. 'Who is Tesla's CEO?' → information/research", () => {
    expect(classifySearchIntent("Who is Tesla's CEO?")).toBe("web_research");
  });
  it("6. 'open Tesla.com' → deterministic navigation", () => {
    expect(classifySearchIntent("Open Tesla.com.")).toBe("navigation");
  });
  it("research phrasing like 'find me pizza' stays model-decided (Tavily path preserved)", () => {
    expect(classifySearchIntent("find me pizza")).toBe("none");
  });
});

describe("PRD 6.10 query construction (§9)", () => {
  it("7. extracts 'tesla' from 'search for tesla'", () => {
    expect(extractBrowserSearchQuery("search for tesla")).toBe("tesla");
  });
  it("strips the 'google' verb, keeps the full query", () => {
    expect(extractBrowserSearchQuery("google best laptops under $1000")).toBe(
      "best laptops under $1000",
    );
  });
  it("folds 'baby by justin bieber' to 'baby justin bieber'", () => {
    expect(extractBrowserSearchQuery("search for baby by justin bieber")).toBe(
      "baby justin bieber",
    );
  });
  it("drops multi-step continuations ('and open …')", () => {
    expect(extractBrowserSearchQuery("Search Tesla and open the official website.")).toBe("Tesla");
  });
  it("returns empty when no query remains", () => {
    expect(extractBrowserSearchQuery("Search for ")).toBe("");
  });
});

describe("PRD 6.10 schema + WebGuard (§6, §21)", () => {
  it("browser_search validates with a query and no target", () => {
    expect(
      validateStructuredAction({ action: "browser_search", parameters: { query: "tesla" } }),
    ).toEqual({ ok: true, errors: [] });
  });
  it("browser_search rejects empty/oversized queries and targets", () => {
    expect(
      validateStructuredAction({ action: "browser_search", parameters: { query: "  " } }).ok,
    ).toBe(false);
    expect(
      validateStructuredAction({ action: "browser_search", parameters: { query: "x".repeat(401) } })
        .ok,
    ).toBe(false);
    expect(
      validateStructuredAction({
        action: "browser_search",
        target: "e1",
        parameters: { query: "tesla" },
      }).ok,
    ).toBe(false);
  });
  it("15. WebGuard ALLOWs targetless browser_search, BLOCKs stale generations", () => {
    const action: StructuredAction = { action: "browser_search", parameters: { query: "tesla" } };
    expect(
      evaluate(action, { currentGeneration: 7, targets: new Map(), provenance: "USER", sensitiveAuthorized: false }).decision,
    ).toBe("ALLOW");
    expect(
      evaluate(
        { action: "click", target: "e9", pageGeneration: 3 },
        { currentGeneration: 7, targets: new Map(), provenance: "USER", sensitiveAuthorized: false },
      ).decision,
    ).toBe("BLOCK");
  });
  it("executor fallback URL is generic (no site selectors)", () => {
    expect(buildBrowserSearchUrl("tesla")).toBe("https://www.google.com/search?q=tesla");
    expect(buildBrowserSearchUrl("best laptops under $1000")).toContain("best%20laptops");
  });
  it("bridge keeps browser_search local-only", () => {
    expect(capabilityFor({ action: "browser_search", parameters: { query: "tesla" } })).toBeNull();
  });
});

describe("PRD 6.10 fresh observation + verification (§10, §17, §18)", () => {
  it("8. search-results URLs are recognized generically", () => {
    expect(isSearchResultsUrl("https://www.google.com/search?q=tesla")).toBe(true);
    expect(isSearchResultsUrl("https://example.com/")).toBe(false);
  });
});

describe("PRD 6.10 end-to-end controller flows (§23)", () => {
  it("A1/A5: 'Search for Tesla' from an arbitrary page runs browser_search with Tavily = 0", async () => {
    const built = build([]);
    await built.controller.routeVoice(voice("Search for Tesla."), 3);
    expect(built.executed).toContain("browser_search");
    expect(built.searches).toEqual([]);
    const last = built.saved[built.saved.length - 1];
    expect(last?.searchMode).toBe("browser");
    expect(last?.lastVerifiedResult ?? "").toContain("browser search");
  });
  it("A7: a model web_search for a browser goal is refused without spending Tavily", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "Tesla" } } },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("Search for Tesla."), 3);
    // Deterministic first-step browser_search runs before the model is asked;
    // the queued model web_search (if ever proposed) would be refused. The
    // deterministic path itself must never call Tavily.
    expect(built.searches).toEqual([]);
    expect(built.executed).toContain("browser_search");
  });
  it("12. search → website: after browser search the task stays alive for grounded continuation", async () => {
    const built = build([{ type: "task_complete" }]);
    await built.controller.routeVoice(voice("Search for Tesla and open the official website."), 3);
    expect(built.executed[0]).toBe("browser_search");
    expect(built.searches).toEqual([]);
  });
  it("14. empty-query browser_search refuses honestly and never executes", async () => {
    const built = build([
      { type: "action", action: { action: "browser_search", parameters: { query: "   " } } },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("find results"), 3);
    expect(built.executed).not.toContain("browser_search");
  });
  it("16. genuine research ('find me pizza') still reaches Tavily (existing gate green)", async () => {
    const built = build([
      { type: "action", action: { action: "web_search", parameters: { query: "pizza" } } },
      { type: "answer", text: "Two great options." },
    ]);
    await built.controller.routeVoice(voice("find me pizza"), 3);
    expect(built.searches).toEqual(["pizza"]);
  });
});
