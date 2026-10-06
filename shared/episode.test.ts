/**
 * Episode model tests (Phase 5).
 * Proves an episode is bounded, validated, deterministically redacted, and can
 * never be mistaken for an executable Skill.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  EPISODE_SCHEMA_VERSION,
  redactEpisode,
  safePageUrl,
  validateEpisode,
  type Episode,
} from "./episode.js";
import { validateSkill } from "./skill-validation.js";
import type { EpisodeActionRecord } from "./episode.js";

function actionRecord(
  overrides: Partial<EpisodeActionRecord> = {},
): EpisodeActionRecord {
  return {
    index: 0,
    action: { action: "click", target: "e2", pageGeneration: 5 },
    pageGeneration: 5,
    status: "executed",
    verification: {
      success: true,
      outcome: "VERIFIED_SUCCESS",
      timedOut: false,
      pageGeneration: 5,
    },
    ...overrides,
  };
}

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: "ep_task_1",
    taskId: "task_1",
    createdAt: 1_000_000,
    recordedAt: 1_001_000,
    goal: "Find the contributors of this repository",
    goalLang: "en",
    pageUrl: "https://github.com/example/project?session_token=abcd1234",
    pageTitle: "example/project",
    pageGenerations: [5, 6],
    selectedSkill: null,
    actions: [actionRecord()],
    recoveryEvents: 1,
    finalOutcomeType: "task_complete",
    finalOutcomeText: "Done.",
    finalStatus: "COMPLETE",
    success: true,
    completedActions: 1,
    registrySnapshot: [
      { skillId: "generic_read_region", version: "1.0.0", status: "approved" },
    ],
    ...overrides,
  };
}

describe("validateEpisode", () => {
  it("accepts a well-formed episode", () => {
    const result = validateEpisode(episode());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a non-object", () => {
    expect(validateEpisode("nope").valid).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    expect(validateEpisode(episode({ schemaVersion: 99 })).valid).toBe(false);
  });

  it("rejects an action whose verb is not an existing ActionType", () => {
    const bad = episode({
      actions: [
        actionRecord({
          action: { action: "eval" as unknown as "click" },
        }),
      ],
    });
    const result = validateEpisode(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("ActionType");
  });

  it("rejects a malformed action record", () => {
    const bad = episode({
      actions: [
        actionRecord({
          status: "definitely_ran" as unknown as EpisodeActionRecord["status"],
        }),
      ],
    });
    expect(validateEpisode(bad).valid).toBe(false);
  });

  it("rejects an invalid final status", () => {
    expect(
      validateEpisode(episode({ finalStatus: "PASSED" as never })).valid,
    ).toBe(false);
  });

  it("rejects an episode carrying an un-redacted card number", () => {
    const bad = episode({ goal: "buy with 4111111111111111 please" });
    const result = validateEpisode(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("card number");
  });

  it("rejects an episode with more actions than the bound", () => {
    const many = Array.from({ length: 40 }, (_, i) => actionRecord({ index: i }));
    expect(validateEpisode(episode({ actions: many })).valid).toBe(false);
  });
});

describe("redactEpisode", () => {
  it("strips query and fragment from the page URL", () => {
    const out = redactEpisode(episode());
    expect(out.pageUrl).toBe("https://github.com/example/project");
    expect(out.pageUrl).not.toContain("abcd1234");
  });

  it("masks typed and selected values outright", () => {
    const out = redactEpisode(
      episode({
        actions: [
          actionRecord({
            action: { action: "type", target: "e5", value: "hunter2" },
          }),
        ],
      }),
    );
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(out.actions[0]?.action.value).toBe("[REDACTED]");
    // Structure is preserved: which field, which action, which generation.
    expect(out.actions[0]?.action.target).toBe("e5");
    expect(out.actions[0]?.action.action).toBe("type");
  });

  it("masks secrets written into the goal", () => {
    const out = redactEpisode(episode({ goal: "login with password=hunter2 now" }));
    expect(out.goal).not.toContain("hunter2");
    expect(out.goal).toContain("[REDACTED]");
  });

  it("masks bearer tokens and JWTs in free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefgh";
    const out = redactEpisode(
      episode({ goal: `send authorization: Bearer ${jwt} over`, pageTitle: jwt }),
    );
    expect(out.goal).not.toContain("eyJzdWIi");
    expect(out.pageTitle).not.toContain("eyJzdWIi");
  });

  it("is idempotent (safe to redact twice)", () => {
    const once = redactEpisode(episode());
    expect(redactEpisode(once)).toEqual(once);
  });
});

describe("safePageUrl", () => {
  it("removes query and fragment", () => {
    expect(safePageUrl("https://a.example/x?a=1#b")).toBe("https://a.example/x");
  });
  it("returns empty string for an unparseable url", () => {
    expect(safePageUrl("not a url")).toBe("");
  });
});

describe("an episode is not a Skill (never executable)", () => {
  it("fails Skill validation because it has no procedure or trust status", () => {
    const result = validateSkill(episode());
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/id:|status:|procedure:/);
  });
});
