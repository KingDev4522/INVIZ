/**
 * Skill: generic_read_region (Phase 2).
 *
 * Intent: "read/summarize a specific semantic region of the current page."
 *
 * Procedure (declarative): read the prose region named in the verified page
 * state. The resolver validates that the requested region (rNN) actually
 * exists and is non-empty in the CURRENT PageState before producing anything;
 * it never scrapes arbitrary HTML and never guesses.
 *
 * Resolution → existing actions:
 *   read  → targets the region handle advertised in PageState PROSE.
 * Verification → existing expectation:
 *   text_present → the region's own text is observable in the rendered page.
 */
import type { Skill } from "../../../../shared/types.js";
import {
  excerpt,
  isRegionHandle,
  type SkillCatalogEntry,
  type SkillResolutionDraft,
  type SkillResolver,
} from "../plan.js";

export const genericReadRegionSkill: Skill = {
  id: "generic_read_region",
  namespace: "generic",
  name: "Read a page region",
  version: "1.0.0",
  description:
    "Read the content of a specific semantic prose region (rNN) advertised " +
    "in the verified page state. Fails closed when the region is missing or empty.",
  supportedIntents: [
    "read this region",
    "read the article",
    "read the main content",
    "read region r1",
    "summarize this section",
  ],
  examples: ["Read the main content of this page.", "Read region r1."],
  status: "approved",
  testStatus: "passing",
  createdAt: 1_700_000_000_000,
  modifiedAt: 1_700_000_000_000,
  createdBy: "human",
  requiredInputs: [
    {
      name: "regionId",
      description: "The prose region handle (rNN) advertised in the page state.",
      required: true,
      type: "region_id",
    },
  ],
  requiredCapabilities: ["read_page"],
  procedure: [
    {
      description: "Read the prose region requested by the caller.",
      action: "read",
      parameters: { derive: "requested_region" },
      waitFor: "stable",
      maxAttempts: 1,
    },
  ],
  verificationCriteria: [
    {
      description: "The requested region's content is present and readable on the page.",
      type: "text_present",
    },
  ],
  recoveryStrategies: [
    {
      trigger: "verification_failed",
      action: "Re-read the page state to check whether a readable region is now available.",
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

export const resolveGenericReadRegion: SkillResolver = (snapshot, inputs) => {
  const raw = inputs.regionId;
  const regionId = typeof raw === "string" ? raw.trim() : "";
  if (regionId === "") {
    return { status: "missing_input", reason: "regionId is required (e.g. \"r1\")" };
  }
  if (!isRegionHandle(regionId)) {
    return {
      status: "missing_input",
      reason: `regionId "${regionId}" is not a region handle (expected rNN)`,
    };
  }
  const region = (snapshot.prose ?? []).find((r) => r.id === regionId);
  if (region === undefined) {
    return { status: "not_found", reason: `region ${regionId} is not present on this page` };
  }
  const text = region.text.replace(/\s+/g, " ").trim();
  if (text === "") {
    return { status: "not_found", reason: `region ${regionId} has no readable text` };
  }

  const draft: SkillResolutionDraft = {
    status: "ready",
    actions: [
      {
        action: "read",
        target: regionId,
        parameters: { max_chars: 4000 },
      },
    ],
    verification: [
      {
        description: `Region ${regionId} content is present on the page`,
        type: "text_present",
        value: excerpt(text, 60),
      },
    ],
    result: { regionId, note: `${text.length} characters of readable text` },
  };
  return draft;
};

export const genericReadRegion: SkillCatalogEntry = {
  skill: genericReadRegionSkill,
  resolve: resolveGenericReadRegion,
};
