/**
 * Skill → trusted pipeline integration tests (Phase 3).
 *
 * Proves a model-selected skill runs through the EXISTING pipeline
 * (WebGuard → executor → verification → PageState refresh) and that every
 * fail-closed / consent / budget / generation rule still holds. No chrome, no
 * network; PageState comes from deterministic fixtures.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { AgentController, type PageSnapshotLike } from "./controller.js";
import { evaluate } from "../webguard/policy.js";
import { SkillRegistry } from "../../skills/registry.js";
import {
  createSkillCatalog,
  type SkillCatalog,
  type SkillCatalogEntry,
  type SkillResolver,
} from "../../skills/plan.js";
import {
  createBuiltinCatalog,
  registerBuiltinSkills,
} from "../../skills/builtin/index.js";
import type {
  AgentOutcome,
  Skill,
  StructuredAction,
} from "../../../../shared/types.js";
import type { ReasonInput } from "../../ai/qwen-client.js";
import type { TaskSnapshot } from "../task-state/store.js";

// --- Fixtures ----------------------------------------------------------------

const PAGE: PageSnapshotLike = {
  url: "https://example.com/",
  title: "Example",
  generation: 42,
  items: [
    { id: "e1", role: "link", name: "More", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "button", name: "Submit Application", states: {}, fieldKind: null, sensitive: false },
  ],
};

const PROSE_PAGE: PageSnapshotLike = {
  url: "https://example.com/article",
  title: "Article",
  generation: 9,
  items: [{ id: "e1", role: "link", name: "Home", states: {}, fieldKind: null, sensitive: false }],
  prose: [{ id: "r1", label: "Main", text: "The readable body of the article.", chars: 32 }],
};

const GITHUB_REPO: PageSnapshotLike = {
  url: "https://github.com/example/project",
  title: "example/project",
  generation: 5,
  items: [
    { id: "e1", role: "link", name: "Code", states: {}, fieldKind: null, sensitive: false },
    { id: "e2", role: "link", name: "Contributors", states: {}, fieldKind: null, sensitive: false },
  ],
};

const GITHUB_CONTRIB: PageSnapshotLike = {
  url: "https://github.com/example/project/graphs/contributors",
  title: "Contributors",
  generation: 6,
  items: [{ id: "e1", role: "link", name: "Code", states: {}, fieldKind: null, sensitive: false }],
  prose: [
    {
      id: "r1",
      label: "Contributors",
      text: "Alice, Bob and Carol contributed to this repository.",
      chars: 51,
    },
  ],
};

// --- Harness -----------------------------------------------------------------

interface VerifyLike {
  success: boolean;
  outcome: "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "STALE_STATE" | "UNKNOWN";
  expected: unknown;
  observed: unknown;
  timedOut: boolean;
  pageGeneration: number;
}

interface H {
  controller: AgentController;
  spoken: string[];
  executed: StructuredAction[];
  guardCalls: Array<{ actionType: string; target?: string; generation: number }>;
  readCalls: Array<{ target?: string; maxChars: number }>;
  reasonPayloads: string[];
  verifyCalls: () => number;
  reasonCalls: () => number;
  current: () => TaskSnapshot | null;
  setSnapshot: (s: PageSnapshotLike) => void;
}

function baseSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "custom_skill",
    namespace: "custom",
    name: "Custom skill",
    version: "1.0.0",
    description: "A custom skill used by the Phase 3 integration tests.",
    supportedIntents: ["custom"],
    examples: ["do the custom thing"],
    status: "approved",
    testStatus: "passing",
    createdAt: 1_000_000,
    modifiedAt: 1_000_000,
    createdBy: "human",
    requiredInputs: [],
    requiredCapabilities: ["read_page"],
    procedure: [{ description: "read", action: "read", target: "r1" }],
    verificationCriteria: [{ description: "ok", type: "element_present", target: "e1" }],
    recoveryStrategies: [],
    testFilePaths: [],
    lastTestedAt: null,
    lastTestResult: null,
    canaryRolloutPercent: 0,
    canaryStartedAt: null,
    ...overrides,
  };
}

function runtimeWith(entries: SkillCatalogEntry[]): {
  skillRegistry: SkillRegistry;
  skillCatalog: SkillCatalog;
} {
  const skillRegistry = new SkillRegistry();
  for (const entry of entries) {
    const result = skillRegistry.register(entry.skill);
    if (!result.ok) throw new Error(`fixture did not register: ${result.errors.join("; ")}`);
  }
  return { skillRegistry, skillCatalog: createSkillCatalog(entries) };
}

function build(opts: {
  snapshot?: PageSnapshotLike;
  outcomes: AgentOutcome[] | (() => AgentOutcome);
  onExecute?: (action: StructuredAction) => void;
  verify?: () => VerifyLike;
  skillRegistry?: SkillRegistry;
  skillCatalog?: SkillCatalog;
  readText?: string;
}): H {
  let snapshot = opts.snapshot ?? PAGE;
  let current: TaskSnapshot | null = null;
  const spoken: string[] = [];
  const executed: StructuredAction[] = [];
  const guardCalls: H["guardCalls"] = [];
  const readCalls: H["readCalls"] = [];
  const reasonPayloads: string[] = [];
  let verifyCalls = 0;
  let reasonCalls = 0;
  const queue = Array.isArray(opts.outcomes) ? [...opts.outcomes] : null;

  const reason = async (input: ReasonInput): Promise<AgentOutcome> => {
    reasonPayloads.push(input.userPayload);
    reasonCalls += 1;
    if (queue !== null) {
      const next = queue.shift();
      if (next === undefined) throw new Error("reason queue empty");
      return next;
    }
    return (opts.outcomes as () => AgentOutcome)();
  };

  const controller = new AgentController({
    backend: { url: "http://127.0.0.1:8787" },
    reason,
    guardEvaluate: (action, ctx) => {
      guardCalls.push({
        actionType: action.action,
        ...(action.target !== undefined ? { target: action.target } : {}),
        generation: ctx.currentGeneration,
      });
      return evaluate(action, ctx);
    },
    executeFn: async (action) => {
      executed.push(action);
      opts.onExecute?.(action);
      return {
        status: "executed",
        action: action.action,
        target: action.target,
        pageGeneration: snapshot.generation,
        timestamp: 1,
      };
    },
    verifyFn: async () => {
      verifyCalls += 1;
      return (
        opts.verify?.() ?? {
          success: true,
          outcome: "VERIFIED_SUCCESS",
          expected: {},
          observed: null,
          timedOut: false,
          pageGeneration: snapshot.generation,
        }
      );
    },
    speak: async (text) => {
      spoken.push(text);
    },
    stopAudio: async () => undefined,
    setAgentActive: async () => undefined,
    loadSnapshot: async () => snapshot,
    loadLayerB: async () => ({
      interpretation: "x",
      pageGeneration: snapshot.generation,
      producedAt: Date.now(),
      provenance: "MODEL_INFERENCE" as const,
    }),
    saveLayerB: async () => undefined,
    readRegionText: async (_tabId, targetId, maxChars) => {
      readCalls.push({ ...(targetId !== undefined ? { target: targetId } : {}), maxChars });
      return opts.readText ?? "Region text for reading aloud.";
    },
    readFocusedElement: async () => null,
    repeatAudio: async () => undefined,
    ...(opts.skillRegistry !== undefined ? { skillRegistry: opts.skillRegistry } : {}),
    ...(opts.skillCatalog !== undefined ? { skillCatalog: opts.skillCatalog } : {}),
    store: {
      load: async () => current,
      save: async (s) => {
        current = { ...s };
      },
      clear: async () => {
        current = null;
      },
    },
    now: () => Date.now(),
  });

  return {
    controller,
    spoken,
    executed,
    guardCalls,
    readCalls,
    reasonPayloads,
    verifyCalls: () => verifyCalls,
    reasonCalls: () => reasonCalls,
    current: () => current,
    setSnapshot: (s) => {
      snapshot = s;
    },
  };
}

const voice = (text: string) => ({ text, lang: "en" as const, source: "voice" as const, timestamp: 1 });
const skillOutcome = (skillId: string, input: Record<string, string> = {}): AgentOutcome => ({
  type: "skill",
  skill: { skillId, input },
});

// --- A–H: skill selection runs the trusted pipeline --------------------------

describe("skill selection runs through the trusted pipeline", () => {
  it("clicks the Contributors control, observes the new page, then reads the region", async () => {
    let h!: H;
    h = build({
      snapshot: GITHUB_REPO,
      outcomes: [skillOutcome("github_find_contributors"), { type: "task_complete", text: "Done." }],
      onExecute: (action) => {
        if (action.action === "click") h.setSnapshot(GITHUB_CONTRIB);
      },
      readText: "Alice, Bob and Carol contributed to this repository.",
    });
    await h.controller.routeVoice(voice("Check the collaborators of this repo."), 7);

    // A/B/C: the skill was selected, resolved, and produced a valid action.
    expect(h.executed.map((a) => `${a.action}:${a.target ?? "-"}`)).toEqual(["click:e2"]);
    // D: the action went through WebGuard.
    expect(h.guardCalls.some((c) => c.actionType === "click" && c.target === "e2")).toBe(true);
    // F: the click was verified.
    expect(h.verifyCalls()).toBeGreaterThanOrEqual(1);
    // E/G/H: after observing the new page state, the skill read the region.
    expect(h.readCalls[0]?.target).toBe("r1");
    // The skill drove its own steps: the model ran only to select it + finish.
    expect(h.reasonCalls()).toBe(2);
    expect(h.current()?.status).toBe("COMPLETE");
    expect(h.current()?.completedActions).toBe(2);
  });

  it("reads a contributors region already present without any browser action", async () => {
    const h = build({
      snapshot: GITHUB_CONTRIB,
      outcomes: [skillOutcome("github_find_contributors"), { type: "task_complete" }],
      readText: "Alice, Bob and Carol contributed to this repository.",
    });
    await h.controller.routeVoice(voice("List the contributors."), 7);
    expect(h.executed.length).toBe(0);
    expect(h.readCalls[0]?.target).toBe("r1");
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("navigates to the canonical contributors URL when no control exists", async () => {
    const noControl: PageSnapshotLike = {
      ...GITHUB_REPO,
      items: [{ id: "e1", role: "link", name: "Code", states: {}, fieldKind: null, sensitive: false }],
    };
    let h!: H;
    h = build({
      snapshot: noControl,
      outcomes: [skillOutcome("github_find_contributors"), { type: "task_complete" }],
      onExecute: (action) => {
        if (action.action === "navigate") h.setSnapshot(GITHUB_CONTRIB);
      },
      readText: "Alice, Bob and Carol.",
    });
    await h.controller.routeVoice(voice("Find contributors."), 7);
    expect(h.executed[0]?.action).toBe("navigate");
    const params = h.executed[0]?.parameters as { url?: string } | undefined;
    expect(params?.url).toBe("https://github.com/example/project/graphs/contributors");
    expect(h.readCalls[0]?.target).toBe("r1");
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("advertises available skills in the model payload", async () => {
    const h = build({
      snapshot: PAGE,
      outcomes: [{ type: "task_complete" }],
    });
    await h.controller.routeVoice(voice("do nothing"), 7);
    const payload = h.reasonPayloads[0] ?? "";
    expect(payload).toContain("[AVAILABLE SKILLS]");
    expect(payload).toContain("github_find_contributors");
    expect(payload).toContain("generic_read_region");
  });
});

// --- I–M: fail closed --------------------------------------------------------

describe("skills fail closed", () => {
  it("I: an unknown skill never executes and recovers via existing semantics", async () => {
    const h = build({
      snapshot: PAGE,
      outcomes: () => skillOutcome("totally_unknown_skill"),
    });
    await h.controller.routeVoice(voice("run the unknown skill"), 7);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("J: a disabled skill never executes", async () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry);
    registry.setStatus("generic_read_region", "disabled");
    const h = build({
      snapshot: PROSE_PAGE,
      outcomes: () => skillOutcome("generic_read_region", { regionId: "r1" }),
      skillRegistry: registry,
      skillCatalog: createBuiltinCatalog(),
    });
    await h.controller.routeVoice(voice("read the region"), 7);
    expect(h.executed.length).toBe(0);
    expect(h.readCalls.length).toBe(0);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("K: a candidate skill never executes", async () => {
    const runtime = runtimeWith([
      {
        skill: baseSkill({ id: "custom_candidate", status: "candidate", testStatus: "untested" }),
        resolve: () => ({ status: "ready", actions: [{ action: "read", target: "r1" }] }),
      },
    ]);
    const h = build({
      snapshot: PROSE_PAGE,
      outcomes: () => skillOutcome("custom_candidate"),
      ...runtime,
    });
    await h.controller.routeVoice(voice("run the candidate"), 7);
    expect(h.readCalls.length).toBe(0);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("L: an invalid skill plan never executes", async () => {
    const resolve: SkillResolver = () => ({
      status: "ready",
      // click with no target — fails the closed StructuredAction schema.
      actions: [{ action: "click" }],
    });
    const runtime = runtimeWith([{ skill: baseSkill({ id: "custom_invalid" }), resolve }]);
    const h = build({ snapshot: PAGE, outcomes: () => skillOutcome("custom_invalid"), ...runtime });
    await h.controller.routeVoice(voice("run the invalid skill"), 7);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("M: a resolver exception becomes a controlled failure, not a crash", async () => {
    const resolve: SkillResolver = () => {
      throw new Error("boom");
    };
    const runtime = runtimeWith([{ skill: baseSkill({ id: "custom_throws" }), resolve }]);
    const h = build({ snapshot: PAGE, outcomes: () => skillOutcome("custom_throws"), ...runtime });
    await h.controller.routeVoice(voice("run the throwing skill"), 7);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("FAILED");
  });

  it("a skill that cannot start on this page produces a controlled failure", async () => {
    // github_find_contributors off GitHub → unsupported_page.
    const h = build({ snapshot: PAGE, outcomes: () => skillOutcome("github_find_contributors") });
    await h.controller.routeVoice(voice("find contributors"), 7);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("FAILED");
  });
});

// --- D/N: WebGuard & generation scope ---------------------------------------

describe("WebGuard and generation scope remain authoritative", () => {
  it("D: a skill action targeting an unknown element is blocked by WebGuard", async () => {
    const runtime = runtimeWith([
      {
        skill: baseSkill({ id: "custom_bad_target" }),
        resolve: () => ({ status: "ready", actions: [{ action: "click", target: "e99" }] }),
      },
    ]);
    const h = build({ snapshot: PAGE, outcomes: () => skillOutcome("custom_bad_target"), ...runtime });
    await h.controller.routeVoice(voice("click the phantom"), 7);
    expect(h.guardCalls.length).toBeGreaterThan(0);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("BLOCKED");
  });

  it("N: an element id absent from the current generation cannot execute", async () => {
    // The resolver may only emit ids from the page state it was handed; an id
    // from an obsolete generation is not in the current registry, so WebGuard
    // refuses it. The action is stamped with the CURRENT generation.
    const runtime = runtimeWith([
      {
        skill: baseSkill({ id: "custom_stale" }),
        resolve: () => ({ status: "ready", actions: [{ action: "focus", target: "e7" }] }),
      },
    ]);
    const h = build({ snapshot: PAGE, outcomes: () => skillOutcome("custom_stale"), ...runtime });
    await h.controller.routeVoice(voice("focus the stale element"), 7);
    expect(h.executed.length).toBe(0);
    expect(h.current()?.status).toBe("BLOCKED");
    // Every guard evaluation saw the live generation — no stale claim got through.
    expect(h.guardCalls.every((c) => c.generation === PAGE.generation)).toBe(true);
  });
});

// --- Q/P/R: consent, recovery, budgets ---------------------------------------

describe("consent, recovery and budgets still govern skill actions", () => {
  it("Q: a skill-generated submit click still requires explicit consent", async () => {
    const runtime = runtimeWith([
      {
        skill: baseSkill({ id: "custom_submit" }),
        resolve: () => ({ status: "ready", actions: [{ action: "click", target: "e2" }] }),
      },
    ]);
    const h = build({
      snapshot: PAGE,
      outcomes: [skillOutcome("custom_submit"), { type: "task_complete" }],
      ...runtime,
    });
    await h.controller.routeVoice(voice("Submit the application."), 7);
    expect(h.current()?.status).toBe("WAITING_FOR_CONFIRMATION");
    expect(h.executed.length).toBe(0);
    await h.controller.routeVoice(voice("yes"), 7);
    expect(h.executed.map((a) => `${a.action}:${a.target ?? "-"}`)).toEqual(["click:e2"]);
    expect(h.current()?.status).toBe("COMPLETE");
  });

  it("P: a skill whose action keeps failing exhausts the existing recovery budget", async () => {
    const runtime = runtimeWith([
      {
        skill: baseSkill({ id: "custom_fail" }),
        resolve: () => ({ status: "ready", actions: [{ action: "click", target: "e1" }] }),
      },
    ]);
    const h = build({
      snapshot: PAGE,
      outcomes: () => skillOutcome("custom_fail"),
      verify: () => ({
        success: false,
        outcome: "VERIFIED_FAILURE",
        expected: {},
        observed: null,
        timedOut: false,
        pageGeneration: PAGE.generation,
      }),
      ...runtime,
    });
    await h.controller.routeVoice(voice("keep trying"), 7);
    expect(h.executed.length).toBe(4); // 1 attempt + 3 recoveries, never a 5th
    expect(h.current()?.status).toBe("FAILED");
  });

  it("R: a skill loop is bounded by the existing action budget", async () => {
    const runtime = runtimeWith([
      {
        skill: baseSkill({ id: "custom_loopy" }),
        resolve: () => ({ status: "ready", actions: [{ action: "click", target: "e1" }] }),
      },
    ]);
    const h = build({ snapshot: PAGE, outcomes: [skillOutcome("custom_loopy")], ...runtime });
    await h.controller.routeVoice(voice("loop forever"), 7);
    expect(h.executed.length).toBe(25); // MAX_ACTIONS_PER_TASK
    expect(h.current()?.status).toBe("LIMIT_REACHED");
  });
});

// --- O: direct actions are untouched ----------------------------------------

describe("direct AgentOutcome is unaffected", () => {
  it("O: a plain action outcome still executes exactly as before", async () => {
    const h = build({
      snapshot: PAGE,
      outcomes: [
        { type: "action", action: { action: "click", target: "e1", pageGeneration: 42 } },
        { type: "task_complete", text: "Done." },
      ],
    });
    await h.controller.routeVoice(voice("click More"), 7);
    expect(h.executed.map((a) => `${a.action}:${a.target ?? "-"}`)).toEqual(["click:e1"]);
    expect(h.current()?.status).toBe("COMPLETE");
  });
});
