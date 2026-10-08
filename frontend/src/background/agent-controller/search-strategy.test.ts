/**
 * Search Strategy + Result-Type Routing tests (additive layer).
 * A result's next action depends on goal + result type — "found a URL" is
 * never equivalent to "completed the task."
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  classifyResultType,
  domainOf,
  isSearchOnlyGoal,
  routeGoalResult,
  selectSearchStrategies,
} from "./search-strategy.js";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { AgentOutcome } from "../../../../shared/types.js";
import type { SearchResultItem } from "../../../../shared/api.js";
import type { TaskSnapshot } from "../task-state/store.js";

describe("strategy selection (§2)", () => {
  it("'Search YouTube for Baby' → site_specific + video", () => {
    expect(selectSearchStrategies("Search YouTube for Baby.", "page")).toEqual([
      "site_specific",
      "video",
    ]);
  });
  it("'Find a video of Baby by Justin Bieber' → video (any media site)", () => {
    expect(selectSearchStrategies("Find a video of Baby by Justin Bieber.", "none")).toEqual([
      "video",
    ]);
  });
  it("'Search for Tesla' → general_web", () => {
    expect(selectSearchStrategies("Search for Tesla.", "browser")).toEqual(["general_web"]);
  });
  it("'Find the official Tesla website' → general_web", () => {
    expect(selectSearchStrategies("Find the official Tesla website.", "none")).toEqual([
      "general_web",
    ]);
  });
  it("'Find images of the Eiffel Tower' → image", () => {
    expect(selectSearchStrategies("Find images of the Eiffel Tower.", "none")).toEqual(["image"]);
  });
  it("'Find today's news about Tesla' → news", () => {
    expect(selectSearchStrategies("Find today's news about Tesla.", "none")).toEqual(["news"]);
  });
  it("research question → research", () => {
    expect(selectSearchStrategies("Who is the CEO of Tesla?", "web_research")).toEqual([
      "research",
    ]);
  });
  it("document goal → document", () => {
    expect(
      selectSearchStrategies("Find the Tesla user manual pdf.", "none"),
    ).toEqual(["document"]);
  });
  it("navigation intent selects no strategy", () => {
    expect(selectSearchStrategies("Open Tesla.com.", "navigation")).toEqual([]);
  });
});

describe("result-type classification (§3, multi-signal, never URL-only)", () => {
  it("classifies a full-evidence video result as VIDEO", () => {
    expect(
      classifyResultType({
        title: "Baby – Justin Bieber (Official Music Video)",
        domain: "youtube.com",
        url: "https://www.youtube.com/watch?v=abc123",
        duration: "4:12",
        surroundingText: "50M views • 10 years ago",
      }),
    ).toBe("VIDEO");
  });
  it("a bare video-site URL with no media evidence is WEBSITE, not VIDEO", () => {
    expect(
      classifyResultType({
        domain: "youtube.com",
        url: "https://www.youtube.com/@tesla",
      }),
    ).toBe("WEBSITE");
  });
  it("classifies audio evidence as AUDIO even with an overlapping word", () => {
    expect(
      classifyResultType({
        title: "Tesla Daily Podcast",
        domain: "open.spotify.com",
        url: "https://open.spotify.com/episode/xyz",
        surroundingText: "Listen to the latest episode",
      }),
    ).toBe("AUDIO");
  });
  it("classifies image-role + thumbnail evidence as IMAGE", () => {
    expect(
      classifyResultType({
        title: "Eiffel Tower at night",
        role: "img",
        hasThumbnail: true,
        surroundingText: "Photo 1920x1080",
      }),
    ).toBe("IMAGE");
  });
  it("classifies labeled news with recency as NEWS", () => {
    expect(
      classifyResultType({
        title: "Tesla earnings beat estimates",
        labels: "News",
        surroundingText: "Reported 2 hours ago",
      }),
    ).toBe("NEWS");
  });
  it("classifies a pdf URL as DOCUMENT", () => {
    expect(
      classifyResultType({
        title: "Model 3 Owner's Manual",
        url: "https://www.tesla.com/sites/default/files/manual.pdf",
      }),
    ).toBe("DOCUMENT");
  });
  it("classifies priced results as PRODUCT", () => {
    expect(
      classifyResultType({
        title: "Tesla Model Y",
        surroundingText: "Price $44,990. Add to cart",
      }),
    ).toBe("PRODUCT");
  });
  it("classifies article-role results as ARTICLE", () => {
    expect(
      classifyResultType({
        title: "How Tesla builds batteries",
        role: "article",
      }),
    ).toBe("ARTICLE");
  });
  it("classifies an official homepage as WEBSITE", () => {
    expect(
      classifyResultType({
        title: "Tesla – Official Site",
        url: "https://www.tesla.com/",
      }),
    ).toBe("WEBSITE");
  });
  it("returns OTHER with no evidence, WEBSITE with only a link", () => {
    expect(classifyResultType({})).toBe("OTHER");
    expect(classifyResultType({ url: "https://example.com/page" })).toBe("WEBSITE");
  });
  it("domainOf never throws and strips www", () => {
    expect(domainOf("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(domainOf("not a url [[[")).toBe("");
    expect(domainOf("")).toBe("");
  });
});

describe("goal + result-type routing (§4, §5)", () => {
  it("'Find Baby and play it' + VIDEO → open_and_play (URL is not playback)", () => {
    const routing = routeGoalResult("Find Baby and play it.", "VIDEO");
    expect(routing.continuation).toBe("open_and_play");
    expect(routing.directive).toContain("verify actual playback");
  });
  it("'Find the Tesla website' + WEBSITE → open_matching_result", () => {
    const routing = routeGoalResult("Find the Tesla website.", "WEBSITE");
    expect(routing.continuation).toBe("open_matching_result");
    expect(routing.directive).toContain("never invent a URL");
  });
  it("'Find the link to the Baby video' + VIDEO → return_link (no open/play)", () => {
    const routing = routeGoalResult("Find the link to the Baby video.", "VIDEO");
    expect(routing.continuation).toBe("return_link");
    expect(routing.directive).toContain("Do not open or play");
  });
  it("bare 'Search for Tesla' → search_complete", () => {
    expect(routeGoalResult("Search for Tesla.").continuation).toBe("search_complete");
    expect(isSearchOnlyGoal("Search for Tesla.")).toBe(true);
  });
  it("'Search for Tesla and open …' is NOT search-only → open_matching_result", () => {
    expect(isSearchOnlyGoal("Search for Tesla and open the official website.")).toBe(false);
    expect(
      routeGoalResult("Search for Tesla and open the official website.").continuation,
    ).toBe("open_matching_result");
  });
  it("'Open the first result' → open_first_result", () => {
    expect(routeGoalResult("Open the first result.").continuation).toBe("open_first_result");
  });
  it("news goal → read_and_answer (URL alone never completes)", () => {
    const routing = routeGoalResult("Find today's news about Tesla.", "NEWS");
    expect(routing.continuation).toBe("read_and_answer");
  });
  it("image goal → read_and_answer without generic navigation", () => {
    const routing = routeGoalResult("Find images of the Eiffel Tower.", "IMAGE");
    expect(routing.continuation).toBe("read_and_answer");
    expect(routing.directive).toContain("Do not auto-navigate");
  });
});

// --- Controller integration (additive wiring) --------------------------------

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
  turnId: "turn_strategy_1",
});

interface Built {
  controller: AgentController;
  executed: string[];
  searches: string[];
  saved: TaskSnapshot[];
}

function build(outcomes: AgentOutcome[], searchResults: SearchResultItem[] = []): Built {
  const executed: string[] = [];
  const searches: string[] = [];
  const saved: TaskSnapshot[] = [];
  let current: TaskSnapshot | null = null;
  const queue = [...outcomes];
  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason: async () => {
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
  return { controller, executed, searches, saved };
}

const last = (built: Built): TaskSnapshot | undefined => built.saved[built.saved.length - 1];

describe("controller strategy wiring", () => {
  it("search+open goal records strategies and pending open_matching_result routing", async () => {
    const built = build([{ type: "task_complete" }]);
    await built.controller.routeVoice(voice("Search for Tesla and open the official website."), 3);
    expect(built.executed[0]).toBe("browser_search");
    const task = last(built);
    expect(task?.searchStrategies).toEqual(["general_web"]);
    expect(task?.pendingResultRouting?.continuation).toBe("open_matching_result");
    expect(task?.lastVerifiedResult ?? "").toContain("[strategy: general_web]");
  });
  it("search-only goal owes no follow-up (pending routing is null)", async () => {
    const built = build([{ type: "task_complete" }]);
    await built.controller.routeVoice(voice("Search for Tesla."), 3);
    const task = last(built);
    expect(task?.pendingResultRouting).toBeNull();
  });
  it("a verified follow-up action consumes the pending routing", async () => {
    const built = build([
      {
        type: "action",
        action: {
          action: "navigate",
          pageGeneration: 7,
          parameters: { url: "https://www.tesla.com/" },
        },
      },
      { type: "task_complete" },
    ]);
    await built.controller.routeVoice(voice("Search for Tesla and open the official website."), 3);
    expect(built.executed).toEqual(["browser_search", "navigate"]);
    expect(last(built)?.pendingResultRouting).toBeNull();
  });
  it("web research observations carry result types + routing without breaking Tavily flow", async () => {
    const built = build(
      [
        { type: "action", action: { action: "web_search", parameters: { query: "pizza" } } },
        { type: "answer", text: "Two great options." },
      ],
      [
        { title: "Best Pizza Recipe", url: "https://example.com/recipe", snippet: "A great guide." },
        { title: "Pizza Place", url: "https://example.com/", snippet: "Official site." },
      ],
    );
    await built.controller.routeVoice(voice("find me pizza"), 3);
    expect(built.searches).toEqual(["pizza"]);
    const task = last(built);
    expect(task?.lastVerifiedResult ?? "").toContain("[result types:");
    expect(task?.searchStrategies).toEqual(["research"]);
  });
  it("video goal records open_and_play routing after browser search", async () => {
    const built = build([{ type: "task_complete" }]);
    await built.controller.routeVoice(voice("Search for Baby by Justin Bieber and play it."), 3);
    const task = last(built);
    expect(task?.searchStrategies).toEqual(["video"]);
    expect(task?.pendingResultRouting?.continuation).toBe("open_and_play");
  });
});
