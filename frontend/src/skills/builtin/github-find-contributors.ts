/**
 * Skill: github_find_contributors (Phase 2).
 *
 * Intent: "find/check/list the contributors (or collaborators) of a GitHub
 * repository."
 *
 * Design constraints (from the phase brief):
 *  - No brittle CSS selectors and no dependence on one exact GitHub DOM. The
 *    resolver reasons over the semantic PageState it was handed.
 *  - "Contributors" and "Collaborators" are NOT assumed to be the same GitHub
 *    concept. A Contributors control is preferred; a Collaborators control is
 *    used only as a secondary signal and the distinction is recorded.
 *
 * Procedure (declarative, in priority order):
 *  1. If the verified page state already exposes a readable contributors
 *     region, read it (no navigation).
 *  2. Otherwise, if a Contributors (or, secondarily, Collaborators) control is
 *     present in the page state, click it.
 *  3. Otherwise, navigate deterministically to the repository's canonical
 *     contributors URL (derived from the repository URL, not the DOM).
 *
 * Resolution → existing actions: read | click | navigate.
 * Verification → existing expectation: text_present | navigation_completed.
 */
import type { Skill } from "../../../../shared/types.js";
import {
  excerpt,
  normalizedName,
  type SkillCatalogEntry,
  type SkillPageSnapshot,
  type SkillResolutionDraft,
  type SkillResolver,
} from "../plan.js";

const CONTRIBUTORS_RE = /contributors?|contributions?/i;
const COLLABORATORS_RE = /collaborators?/i;

/** A prose region that actually carries contributor information. */
function contributorsRegion(snapshot: SkillPageSnapshot): { id: string; text: string } | null {
  for (const region of snapshot.prose ?? []) {
    if (CONTRIBUTORS_RE.test(region.label)) return { id: region.id, text: region.text };
  }
  return null;
}

/** Links in the page state whose accessible name mentions the given concept. */
function conceptLinks(snapshot: SkillPageSnapshot, re: RegExp): string[] {
  return snapshot.items
    .filter((item) => item.role === "link" && re.test(item.name))
    .map((item) => item.id);
}

/**
 * Derives `https://github.com/{owner}/{repo}` from the current page URL or an
 * explicit override. Pure URL reasoning — never a selector.
 */
export function repoBaseUrl(pageUrl: string, override?: string): string | null {
  const candidate = override !== undefined && override.trim() !== "" ? override.trim() : pageUrl;
  const match = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(candidate);
  if (match === null) return null;
  const owner = match[1] ?? "";
  const repo = (match[2] ?? "").replace(/\.git$/i, "");
  if (owner === "" || repo === "") return null;
  return `https://github.com/${owner}/${repo}`;
}

export const githubFindContributorsSkill: Skill = {
  id: "github_find_contributors",
  namespace: "github",
  name: "Find repository contributors",
  version: "1.0.0",
  description:
    "Locate and read a GitHub repository's contributors using the " +
    "repository's own verified navigation, preferring a Contributors control " +
    "and falling back to the canonical contributors URL. Distinguishes the " +
    "Contributors concept from Collaborators rather than assuming they match.",
  supportedIntents: [
    "find contributors",
    "list contributors",
    "check collaborators",
    "who contributed to this repo",
    "contributors of this repository",
  ],
  examples: [
    "Check the collaborators of this GitHub repository.",
    "Who contributed to this repository?",
  ],
  status: "approved",
  testStatus: "passing",
  createdAt: 1_700_000_000_000,
  modifiedAt: 1_700_000_000_000,
  createdBy: "human",
  requiredInputs: [
    {
      name: "repoUrl",
      description:
        "Optional repository URL. Defaults to the current page when it is already a GitHub repository page.",
      required: false,
      type: "url",
    },
  ],
  requiredCapabilities: ["read_page", "find_element", "click", "navigate"],
  procedure: [
    {
      description:
        "Reach the repository's contributors view: click a Contributors " +
        "control when the verified page state exposes one, otherwise navigate " +
        "to the canonical contributors URL.",
      action: "navigate",
      parameters: { derive: "contributors_url" },
      waitFor: "navigation",
      expect: { type: "navigation_completed" },
      maxAttempts: 2,
    },
    {
      description: "Read the contributors listing from the resulting page.",
      action: "read",
      parameters: { derive: "contributors_region" },
      waitFor: "stable",
      maxAttempts: 1,
    },
  ],
  verificationCriteria: [
    {
      description: "The repository's contributors view is open (the URL moved).",
      type: "navigation_completed",
    },
    {
      description: "Contributor information is present and readable on the page.",
      type: "text_present",
      value: "Contributors",
    },
  ],
  recoveryStrategies: [
    {
      trigger: "element_not_found",
      action: "Fall back to navigating to the canonical /graphs/contributors URL.",
      maxAttempts: 2,
      escalateOnExhaustion: true,
    },
    {
      trigger: "navigation_failed",
      action: "Re-derive the repository base URL and retry navigation once.",
      maxAttempts: 1,
      escalateOnExhaustion: true,
    },
    {
      trigger: "verification_failed",
      action: "Re-read the page state to check whether a contributors region appeared.",
      maxAttempts: 2,
      escalateOnExhaustion: true,
    },
  ],
  testFilePaths: ["src/skills/builtin/builtin.test.ts"],
  lastTestedAt: null,
  lastTestResult: null,
  canaryRolloutPercent: 0,
  canaryStartedAt: null,
};

export const resolveGithubFindContributors: SkillResolver = (snapshot, inputs) => {
  const override = typeof inputs.repoUrl === "string" ? inputs.repoUrl : undefined;
  const base = repoBaseUrl(snapshot.url, override);
  if (base === null) {
    return {
      status: "unsupported_page",
      reason: "the current page is not a GitHub repository page",
    };
  }

  // 1) The contributors listing is already on the page — read it directly.
  const region = contributorsRegion(snapshot);
  if (region !== null && region.text.trim() !== "") {
    const draft: SkillResolutionDraft = {
      status: "ready",
      actions: [{ action: "read", target: region.id, parameters: { max_chars: 4000 } }],
      verification: [
        {
          description: "The contributors listing is readable on this page",
          type: "text_present",
          value: excerpt(region.text, 60),
        },
      ],
      result: {
        regionId: region.id,
        note: "contributors region already present; read it without navigating",
      },
    };
    return draft;
  }

  // 2) A Contributors control is present — click it. Collaborators is a
  //    distinct concept, so it is only used when no Contributors link exists.
  const contributors = conceptLinks(snapshot, CONTRIBUTORS_RE);
  const collaborators = conceptLinks(snapshot, COLLABORATORS_RE);
  const chosen = contributors[0] ?? collaborators[0];
  if (chosen !== undefined) {
    const usingCollaborators = contributors.length === 0;
    const draft: SkillResolutionDraft = {
      status: "ready",
      actions: [
        {
          action: "click",
          target: chosen,
          expect: { type: "navigation_completed" },
        },
      ],
      verification: [
        {
          description: "The contributors view opens",
          type: "navigation_completed",
        },
      ],
      result: {
        targetId: chosen,
        note: usingCollaborators
          ? "no Contributors control found; opened the Collaborators view instead"
          : "opened the Contributors view",
      },
    };
    return draft;
  }

  // 3) No control — deterministic navigation to the canonical contributors URL.
  const url = `${base}/graphs/contributors`;
  const draft: SkillResolutionDraft = {
    status: "ready",
    actions: [
      { action: "navigate", parameters: { url }, expect: { type: "navigation_completed" } },
    ],
    verification: [
      { description: "The canonical contributors page opens", type: "navigation_completed" },
    ],
    result: {
      url,
      note: "no contributors control found; navigated to the canonical contributors URL",
    },
  };
  return draft;
};

export const githubFindContributors: SkillCatalogEntry = {
  skill: githubFindContributorsSkill,
  resolve: resolveGithubFindContributors,
};
