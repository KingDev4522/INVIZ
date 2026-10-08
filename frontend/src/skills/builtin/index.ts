/**
 * Built-in skill catalog + registration (Phase 2).
 *
 * The three first-party skills ship as trusted TypeScript modules (metadata +
 * pure resolver), NOT as model-generated or dynamically loaded code. They are
 * registered through the SAME Phase 1 SkillRegistry and must satisfy the same
 * validation — there is no parallel registry and no bypass.
 *
 * Trust: these are first-party, authored and reviewed by the INVIZ team, so
 * they are registered as `approved` (executable, but NOT auto-promoted to
 * `trusted`). Canary promotion to `trusted` remains an explicit, gated step
 * owned by the future promotion pipeline (Phase 4+); registering them here
 * does not grant trust automatically.
 */
import type { SkillCatalog, SkillCatalogEntry } from "../plan.js";
import { createSkillCatalog } from "../plan.js";
import type { SkillRegistry } from "../registry.js";
import { genericFindElement } from "./generic-find-element.js";
import { genericReadRegion } from "./generic-read-region.js";
import { githubFindContributors } from "./github-find-contributors.js";

export const BUILTIN_SKILLS: readonly SkillCatalogEntry[] = [
  githubFindContributors,
  genericReadRegion,
  genericFindElement,
];

/** Fresh catalog of the built-in skills. */
export function createBuiltinCatalog(): SkillCatalog {
  return createSkillCatalog(BUILTIN_SKILLS);
}

export interface RegisterBuiltinResult {
  registered: string[];
  errors: string[];
}

/**
 * Registers every built-in skill into the given registry. A skill that fails
 * Phase 1 validation is reported and skipped — never force-registered.
 */
export function registerBuiltinSkills(registry: SkillRegistry): RegisterBuiltinResult {
  const registered: string[] = [];
  const errors: string[] = [];
  for (const entry of BUILTIN_SKILLS) {
    const result = registry.register(entry.skill);
    if (result.ok) {
      registered.push(entry.skill.id);
    } else {
      errors.push(`${entry.skill.id}: ${result.errors.join("; ")}`);
    }
  }
  return { registered, errors };
}
