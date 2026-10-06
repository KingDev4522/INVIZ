/**
 * Built-in skill tests (Phase 2).
 * Covers metadata validation, registration/lookup, input validation, plan
 * generation, ActionType compatibility, verification criteria, missing/
 * ambiguous/generation handling, and the GitHub fixtures A–E. Everything runs
 * against fixtures — no live GitHub, no chrome, no network.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../registry.js";
import { createBuiltinCatalog, registerBuiltinSkills, BUILTIN_SKILLS } from "./index.js";
import { planSkill, type SkillPageSnapshot } from "../plan.js";
import { validateSkill } from "../../../../shared/skill-validation.js";
import { ACTION_TYPES, validateStructuredAction, type Skill } from "../../../../shared/types.js";
import {
  evaluateExpectation,
  type VerifyFacts,
} from "../../verification/verification-engine.js";

const REPO_URL = "https://github.com/example/project";
const GITHUB_SKILL = "github_find_contributors";
const READ_SKILL = "generic_read_region";
const FIND_SKILL = "generic_find_element";

type SnapshotItem = SkillPageSnapshot["items"][number];

function snap(overrides: Partial<SkillPageSnapshot> = {}): SkillPageSnapshot {
  return {
    url: REPO_URL,
    title: "example/project",
    generation: 7,
    items: [],
    structure: { headings: [], landmarks: [], forms: [] },
    ...overrides,
  };
}

function item(
  id: string,
  role: string,
  name: string,
  extra: Partial<SnapshotItem> = {},
): SnapshotItem {
  return { id, role, name, states: {}, fieldKind: null, sensitive: false, ...extra };
}

function region(id: string, label: string, text: string) {
  return { id, label, text, chars: text.length };
}

function freshRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  const { errors } = registerBuiltinSkills(registry);
  expect(errors).toEqual([]);
  return registry;
}

function plan(skillId: string, snapshot: SkillPageSnapshot, inputs?: Record<string, string>) {
  return planSkill({
    registry: freshRegistry(),
    catalog: createBuiltinCatalog(),
    skillId,
    snapshot,
    ...(inputs !== undefined ? { inputs } : {}),
  });
}

function facts(overrides: Partial<VerifyFacts> = {}): VerifyFacts {
  return {
    urlBefore: REPO_URL,
    urlNow: REPO_URL,
    targetPresent: null,
    activeMatches: null,
    dialogOpen: false,
    textFound: null,
    fieldFilled: null,
    stateMatches: null,
    generationChanged: false,
    ...overrides,
  };
}

// --- Metadata, registration, lookup -----------------------------------------

describe("built-in skill metadata & registration", () => {
  it("every built-in skill passes Phase 1 validation", () => {
    for (const entry of BUILTIN_SKILLS) {
      const result = validateSkill(entry.skill);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it("registers all three skills through the Phase 1 registry", () => {
    const registry = new SkillRegistry();
    const { registered, errors } = registerBuiltinSkills(registry);
    expect(errors).toEqual([]);
    expect(registered.sort()).toEqual([FIND_SKILL, GITHUB_SKILL, READ_SKILL].sort());
    expect(registry.size).toBe(3);
  });

  it("looks up each skill and treats them as executable (approved, not auto-trusted)", () => {
    const registry = freshRegistry();
    for (const id of [GITHUB_SKILL, READ_SKILL, FIND_SKILL]) {
      const skill = registry.get(id);
      expect(skill).not.toBeNull();
      expect(registry.isExecutable(id)).toBe(true);
    }
    // First-party skills are approved, never silently promoted to trusted.
    expect(registry.get(GITHUB_SKILL)?.status).toBe("approved");
  });

  it("declares verification criteria on every skill", () => {
    for (const entry of BUILTIN_SKILLS) {
      expect(entry.skill.verificationCriteria.length).toBeGreaterThan(0);
    }
  });
});

// --- GitHub fixtures A–E -----------------------------------------------------

describe("github_find_contributors", () => {
  it("A: repository page exposing a Contributors control → clicks it", () => {
    const page = snap({
      items: [item("e1", "link", "Code"), item("e2", "link", "Contributors"), item("e3", "link", "Issues")],
    });
    const result = plan(GITHUB_SKILL, page);
    expect(result.status).toBe("ready");
    expect(result.actions[0]?.action).toBe("click");
    expect(result.actions[0]?.target).toBe("e2");
    expect(result.result.targetId).toBe("e2");
  });

  it("A: contributors page exposing a readable region → reads it instead of navigating", () => {
    const page = snap({
      url: `${REPO_URL}/graphs/contributors`,
      items: [item("e1", "link", "Code")],
      prose: [region("r1", "Contributors", "Alice, Bob and Carol contributed to this repository.")],
    });
    const result = plan(GITHUB_SKILL, page);
    expect(result.status).toBe("ready");
    expect(result.actions[0]?.action).toBe("read");
    expect(result.actions[0]?.target).toBe("r1");
    expect(result.result.regionId).toBe("r1");
  });

  it("B: repository page with no contributors control → navigates to the canonical URL", () => {
    const page = snap({ items: [item("e1", "link", "Code"), item("e2", "link", "Issues")] });
    const result = plan(GITHUB_SKILL, page);
    expect(result.status).toBe("ready");
    expect(result.actions[0]?.action).toBe("navigate");
    const params = result.actions[0]?.parameters as { url?: string } | undefined;
    expect(params?.url).toBe(`${REPO_URL}/graphs/contributors`);
  });

  it("C: page state changes after navigation → a different plan is produced", () => {
    const repo = plan(GITHUB_SKILL, snap({ items: [item("e2", "link", "Contributors")] }));
    const contributors = plan(
      GITHUB_SKILL,
      snap({
        url: `${REPO_URL}/graphs/contributors`,
        prose: [region("r1", "Contributors", "Alice, Bob and Carol.")],
      }),
    );
    expect(repo.actions[0]?.action).not.toBe(contributors.actions[0]?.action);
  });

  it("D: verification succeeds when contributor information is present", () => {
    const result = plan(
      GITHUB_SKILL,
      snap({
        url: `${REPO_URL}/graphs/contributors`,
        prose: [region("r1", "Contributors", "Alice, Bob and Carol contributed.")],
      }),
    );
    const criterion = result.verification[0];
    expect(criterion?.type).toBe("text_present");
    if (criterion?.type === "text_present") {
      expect(evaluateExpectation(criterion, facts({ textFound: true }))).toBe("VERIFIED_SUCCESS");
    }
    // The navigation path verifies by URL change.
    const nav = plan(GITHUB_SKILL, snap({ items: [item("e1", "link", "Code")] }));
    const navCriterion = nav.verification[0];
    expect(navCriterion?.type).toBe("navigation_completed");
    if (navCriterion !== undefined) {
      expect(
        evaluateExpectation(navCriterion, facts({ urlNow: `${REPO_URL}/graphs/contributors` })),
      ).toBe("VERIFIED_SUCCESS");
    }
  });

  it("E: verification does not succeed when the expected information is absent", () => {
    const read = plan(
      GITHUB_SKILL,
      snap({
        url: `${REPO_URL}/graphs/contributors`,
        prose: [region("r1", "Contributors", "Alice, Bob and Carol contributed.")],
      }),
    );
    const readCriterion = read.verification[0];
    if (readCriterion !== undefined) {
      // Absence is "not yet observable" (PENDING) until the poll times out,
      // at which point the controller treats the timeout as failure.
      expect(evaluateExpectation(readCriterion, facts({ textFound: false }))).not.toBe(
        "VERIFIED_SUCCESS",
      );
    }
    const nav = plan(GITHUB_SKILL, snap({ items: [item("e1", "link", "Code")] }));
    const navCriterion = nav.verification[0];
    if (navCriterion !== undefined) {
      expect(evaluateExpectation(navCriterion, facts())).not.toBe("VERIFIED_SUCCESS");
    }
  });

  it("distinguishes Contributors from Collaborators (prefers Contributors)", () => {
    const both = snap({
      items: [item("e1", "link", "Collaborators"), item("e2", "link", "Contributors")],
    });
    expect(plan(GITHUB_SKILL, both).actions[0]?.target).toBe("e2");
  });

  it("falls back to the Collaborators control only when no Contributors control exists", () => {
    const only = snap({ items: [item("e1", "link", "Collaborators")] });
    const result = plan(GITHUB_SKILL, only);
    expect(result.actions[0]?.action).toBe("click");
    expect(result.actions[0]?.target).toBe("e1");
    expect(result.result.note ?? "").toContain("Collaborators");
  });

  it("returns a controlled unsupported_page result off GitHub", () => {
    expect(plan(GITHUB_SKILL, snap({ url: "https://example.com/" })).status).toBe(
      "unsupported_page",
    );
  });

  it("accepts an explicit repoUrl override", () => {
    const result = plan(GITHUB_SKILL, snap({ url: "https://example.com/" }), {
      repoUrl: "https://github.com/acme/widgets",
    });
    expect(result.status).toBe("ready");
    const params = result.actions[0]?.parameters as { url?: string } | undefined;
    expect(params?.url).toBe("https://github.com/acme/widgets/graphs/contributors");
  });

  it("never depends on brittle selectors — targets are handles or http(s) URLs", () => {
    const cases = [
      snap({ items: [item("e2", "link", "Contributors")] }),
      snap({ items: [item("e1", "link", "Code")] }),
      snap({
        url: `${REPO_URL}/graphs/contributors`,
        prose: [region("r1", "Contributors", "Alice, Bob, Carol.")],
      }),
    ];
    for (const page of cases) {
      const result = plan(GITHUB_SKILL, page);
      for (const action of result.actions) {
        if (action.target !== undefined) {
          expect(/^[er]\d+$/.test(action.target)).toBe(true);
        }
        const params = action.parameters as { url?: string } | undefined;
        if (params?.url !== undefined) {
          expect(params.url.startsWith("https://github.com/")).toBe(true);
        }
      }
    }
  });
});

// --- generic_read_region -----------------------------------------------------

describe("generic_read_region", () => {
  const page = snap({
    prose: [region("r1", "Main content", "Hello world. This is the article body.")],
  });

  it("A: reads an existing region and verifies it", () => {
    const result = plan(READ_SKILL, page, { regionId: "r1" });
    expect(result.status).toBe("ready");
    expect(result.actions[0]?.action).toBe("read");
    expect(result.actions[0]?.target).toBe("r1");
    expect(result.result.regionId).toBe("r1");
    expect(result.verification[0]?.type).toBe("text_present");
    expect(result.verification[0]?.value).toBeTruthy();
  });

  it("B: a missing region fails closed", () => {
    const result = plan(READ_SKILL, page, { regionId: "r9" });
    expect(result.status).toBe("not_found");
    expect(result.actions).toEqual([]);
  });

  it("C: an empty region fails closed", () => {
    const result = plan(READ_SKILL, snap({ prose: [region("r1", "Main", "")] }), {
      regionId: "r1",
    });
    expect(result.status).toBe("not_found");
    expect(result.actions).toEqual([]);
  });

  it("rejects a malformed or missing regionId as missing_input", () => {
    expect(plan(READ_SKILL, page, { regionId: "foo" }).status).toBe("missing_input");
    expect(plan(READ_SKILL, page, {}).status).toBe("missing_input");
  });

  it("D: verification succeeds once the region content is observable", () => {
    const result = plan(READ_SKILL, page, { regionId: "r1" });
    const criterion = result.verification[0];
    if (criterion !== undefined) {
      expect(evaluateExpectation(criterion, facts({ textFound: true }))).toBe("VERIFIED_SUCCESS");
      expect(evaluateExpectation(criterion, facts({ textFound: false }))).not.toBe(
        "VERIFIED_SUCCESS",
      );
    }
  });
});

// --- generic_find_element ----------------------------------------------------

describe("generic_find_element", () => {
  const page = snap({
    items: [
      item("e1", "button", "Log in"),
      item("e2", "textbox", "Email"),
      item("e3", "link", "Search"),
      item("e4", "link", "Search results"),
    ],
  });

  it("A: resolves a unique semantic match and focuses it", () => {
    const result = plan(FIND_SKILL, page, { role: "button", name: "log in" });
    expect(result.status).toBe("ready");
    expect(result.result.targetId).toBe("e1");
    expect(result.actions[0]?.action).toBe("focus");
    expect(result.actions[0]?.target).toBe("e1");
    expect(result.verification[0]?.type).toBe("focused_element");
    expect(result.verification[0]?.target).toBe("e1");
  });

  it("B: reports not_found when nothing matches", () => {
    const result = plan(FIND_SKILL, page, { name: "checkout" });
    expect(result.status).toBe("not_found");
    expect(result.actions).toEqual([]);
  });

  it("C: refuses to choose between equally ambiguous matches", () => {
    const ambiguous = snap({
      items: [item("e1", "button", "Close"), item("e2", "button", "Close")],
    });
    const result = plan(FIND_SKILL, ambiguous, { role: "button", name: "close" });
    expect(result.status).toBe("ambiguous");
    expect(result.result.candidates).toEqual(["e1", "e2"]);
    expect(result.actions).toEqual([]);
  });

  it("uses deterministic disambiguation: exact name beats substring", () => {
    const result = plan(FIND_SKILL, page, { role: "link", name: "Search" });
    expect(result.status).toBe("ready");
    expect(result.result.targetId).toBe("e3");
  });

  it("requires at least a role or a name", () => {
    expect(plan(FIND_SKILL, page, {}).status).toBe("missing_input");
  });

  it("D: returns the generation-scoped id and stamps the current generation", () => {
    const gen = snap({
      generation: 99,
      items: [item("e5", "button", "Submit")],
    });
    const result = plan(FIND_SKILL, gen, { name: "submit" });
    expect(result.status).toBe("ready");
    expect(result.pageGeneration).toBe(99);
    expect(result.actions[0]?.pageGeneration).toBe(99);
    expect(gen.items.map((i) => i.id)).toContain(result.result.targetId);
  });
});

// --- Cross-cutting safety ----------------------------------------------------

describe("generated actions are safe by construction", () => {
  it("every generated action uses an existing ActionType and passes the closed schema", () => {
    const registry = freshRegistry();
    const catalog = createBuiltinCatalog();
    const snapshots: Array<[string, SkillPageSnapshot, Record<string, string> | undefined]> = [
      [GITHUB_SKILL, snap({ items: [item("e2", "link", "Contributors")] }), undefined],
      [GITHUB_SKILL, snap({ items: [item("e1", "link", "Code")] }), undefined],
      [
        GITHUB_SKILL,
        snap({ url: `${REPO_URL}/graphs/contributors`, prose: [region("r1", "Contributors", "A, B, C.")] }),
        undefined,
      ],
      [READ_SKILL, snap({ prose: [region("r1", "Main", "Body text.")] }), { regionId: "r1" }],
      [FIND_SKILL, snap({ items: [item("e1", "button", "Log in")] }), { name: "log in" }],
    ];
    let actionCount = 0;
    for (const [skillId, snapshot, inputs] of snapshots) {
      const result = planSkill({
        registry,
        catalog,
        skillId,
        snapshot,
        ...(inputs !== undefined ? { inputs } : {}),
      });
      expect(result.status).toBe("ready");
      expect(result.verification.length).toBeGreaterThan(0);
      for (const action of result.actions) {
        actionCount += 1;
        expect(ACTION_TYPES).toContain(action.action);
        expect(validateStructuredAction(action).ok).toBe(true);
      }
    }
    expect(actionCount).toBeGreaterThan(0);
  });

  it("fails closed for an unknown skill id", () => {
    const result = planSkill({
      registry: freshRegistry(),
      catalog: createBuiltinCatalog(),
      skillId: "not_a_real_skill",
      snapshot: snap(),
    });
    expect(result.status).toBe("unknown_skill");
    expect(result.actions).toEqual([]);
  });

  it("fails closed for a disabled skill", () => {
    const registry = freshRegistry();
    const disabled = registry.setStatus(READ_SKILL, "disabled");
    expect(disabled.ok).toBe(true);
    const result = planSkill({
      registry,
      catalog: createBuiltinCatalog(),
      skillId: READ_SKILL,
      snapshot: snap({ prose: [region("r1", "Main", "Body text.")] }),
      inputs: { regionId: "r1" },
    });
    expect(result.status).toBe("not_executable");
    expect(result.actions).toEqual([]);
  });
});

// --- Static integrity of the skill sources -----------------------------------

describe("skill sources contain no arbitrary execution surface", () => {
  // Scan the whole skills module (built-ins + planner + registry), not just
  // the builtin directory.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
    { name: "cdp-debugger", re: /chrome\.debugger/ },
    { name: "cdp-runtime-evaluate", re: /Runtime\.evaluate/ },
    { name: "child-process", re: /child_process/ },
    { name: "shell-exec", re: /execSync|spawnSync/ },
    { name: "eval", re: /\beval\(/ },
    { name: "new-function", re: /new Function\(/ },
    { name: "dom-query", re: /querySelector|getElementById/ },
    { name: "dom-document", re: /\bdocument\./ },
    { name: "inner-html", re: /innerHTML/ },
  ];

  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) yield full;
    }
  }

  it("has no CDP, shell, eval, or DOM access in any skill module", () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return; // skip comments
        for (const pattern of FORBIDDEN) {
          if (pattern.re.test(line)) {
            hits.push(`${path.relative(ROOT, file)}:${i + 1} [${pattern.name}]`);
          }
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
