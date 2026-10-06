/**
 * Skill: generic_find_element (Phase 2).
 *
 * Intent: "find a page element matching a semantic description (role and/or
 * accessible name)."
 *
 * The resolver matches ONLY over the semantic PageState the model already
 * receives — role, accessible name, and the generation-scoped id. It never
 * uses CSS selectors, XPath, or JavaScript. When several elements match it
 * applies deterministic disambiguation (exact accessible-name equality beats a
 * substring match) and, if still ambiguous, returns a controlled `ambiguous`
 * result instead of choosing blindly.
 *
 * Resolution → existing actions:
 *   focus → the resolved element id, so the located element becomes current.
 * Verification → existing expectation:
 *   focused_element → the resolved target now holds focus.
 */
import type { Skill } from "../../../../shared/types.js";
import {
  normalizedName,
  type SkillCatalogEntry,
  type SkillResolutionDraft,
  type SkillResolver,
} from "../plan.js";

export const genericFindElementSkill: Skill = {
  id: "generic_find_element",
  namespace: "generic",
  name: "Find an element",
  version: "1.0.0",
  description:
    "Locate a page element by semantic role and/or accessible name in the " +
    "verified page state, returning its generation-scoped id and focusing it. " +
    "Refuses to choose when several elements match equally.",
  supportedIntents: [
    "find the button",
    "where is the link",
    "locate the field",
    "find element named",
    "take me to the search box",
  ],
  examples: ["Find the login button.", "Where is the search box?"],
  status: "approved",
  testStatus: "passing",
  createdAt: 1_700_000_000_000,
  modifiedAt: 1_700_000_000_000,
  createdBy: "human",
  requiredInputs: [
    {
      name: "name",
      description: "Accessible name or semantic description to match.",
      required: false,
      type: "string",
    },
    {
      name: "role",
      description: "ARIA role to constrain the match (e.g. button, link, textbox).",
      required: false,
      type: "string",
    },
  ],
  requiredCapabilities: ["read_page", "find_element", "focus"],
  procedure: [
    {
      description:
        "Focus the element whose role and accessible name match the description.",
      action: "focus",
      parameters: { derive: "semantic_match" },
      waitFor: "stable",
      maxAttempts: 1,
    },
  ],
  verificationCriteria: [
    {
      description: "The matched element receives focus.",
      type: "focused_element",
    },
  ],
  recoveryStrategies: [
    {
      trigger: "element_not_found",
      action:
        "Re-read the page state and retry the semantic match once before escalating.",
      maxAttempts: 1,
      escalateOnExhaustion: true,
    },
  ],
  testFilePaths: ["src/skills/builtin/builtin.test.ts"],
  lastTestedAt: null,
  lastTestResult: null,
  canaryRolloutPercent: 0,
  canaryStartedAt: null,
};

export const resolveGenericFindElement: SkillResolver = (snapshot, inputs) => {
  const roleRaw = typeof inputs.role === "string" ? inputs.role.trim().toLowerCase() : "";
  const nameRaw =
    typeof inputs.name === "string"
      ? inputs.name
      : typeof inputs.description === "string"
        ? inputs.description
        : "";
  const needle = normalizedName(nameRaw);

  if (roleRaw === "" && needle === "") {
    return {
      status: "missing_input",
      reason: "provide a role and/or a name/description to match",
    };
  }

  const matches = snapshot.items.filter((item) => {
    if (roleRaw !== "" && item.role.toLowerCase() !== roleRaw) return false;
    if (needle === "") return true;
    const name = normalizedName(item.name);
    return name === needle || name.includes(needle);
  });

  if (matches.length === 0) {
    return { status: "not_found", reason: "no element matched the description" };
  }

  // Deterministic disambiguation: exact accessible-name equality wins over a
  // substring match. No randomness, no ordering bias.
  const exact = matches.filter((item) => needle !== "" && normalizedName(item.name) === needle);
  const pool = exact.length > 0 ? exact : matches;

  if (pool.length > 1) {
    return {
      status: "ambiguous",
      reason: `${pool.length} elements matched; refusing to choose one`,
      result: { candidates: pool.map((item) => item.id) },
    };
  }

  const target = pool[0];
  if (target === undefined) {
    return { status: "not_found", reason: "no element matched the description" };
  }

  const draft: SkillResolutionDraft = {
    status: "ready",
    actions: [
      {
        action: "focus",
        target: target.id,
        expect: { type: "focused_element", target: target.id },
      },
    ],
    verification: [
      {
        description: "The matched element receives focus",
        type: "focused_element",
        target: target.id,
      },
    ],
    result: { targetId: target.id, note: `matched ${target.role} "${target.name}"` },
  };
  return draft;
};

export const genericFindElement: SkillCatalogEntry = {
  skill: genericFindElementSkill,
  resolve: resolveGenericFindElement,
};
