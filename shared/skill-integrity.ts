/**
 * Skill integrity — REAL (Phase 4).
 *
 * A deterministic, dependency-free fingerprint of a skill's IMPLEMENTATION.
 * It exists to make one security rule structural: a trusted (or approved)
 * skill version must never be silently replaced by a different implementation
 * under the same id+version.
 *
 * The fingerprint covers ONLY the immutable implementation fields (identity,
 * description, inputs, capabilities, procedure, verification, recovery). The
 * mutable trust/rollout state — status, test status, timestamps, canary fields —
 * is deliberately EXCLUDED, so moving a skill through its lifecycle does not
 * change its identity, while changing its behaviour does.
 *
 * This is a change-detection checksum, not a cryptographic signature: it
 * detects accidental corruption and naive edits of a persisted skill, and is
 * used to refuse in-registry replacement of a trusted implementation. It does
 * not defend against an adversary who recomputes the hash.
 */
import type { Skill } from "./types.js";

/**
 * The implementation fields of a skill, canonicalized. Order is fixed by
 * construction so two logically-equal skills always serialize identically.
 */
export function canonicalSkillContent(skill: Skill): string {
  const content = {
    id: skill.id,
    namespace: skill.namespace,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    supportedIntents: normalizeStringArray(skill.supportedIntents),
    examples: normalizeStringArray(skill.examples),
    requiredInputs: (skill.requiredInputs ?? []).map((input) => ({
      name: input.name,
      description: input.description,
      required: input.required,
      type: input.type ?? null,
    })),
    requiredCapabilities: normalizeStringArray(skill.requiredCapabilities),
    procedure: (skill.procedure ?? []).map((step) => ({
      description: step.description,
      action: step.action,
      target: step.target ?? null,
      value: step.value ?? null,
      parameters: canonicalParameters(step.parameters),
      expect: step.expect ?? null,
      waitFor: step.waitFor ?? null,
      maxAttempts: step.maxAttempts ?? null,
    })),
    verificationCriteria: (skill.verificationCriteria ?? []).map((criterion) => ({
      description: criterion.description,
      type: criterion.type,
      target: criterion.target ?? null,
      value: criterion.value ?? null,
      state: criterion.state ?? null,
      stateValue: criterion.stateValue ?? null,
    })),
    recoveryStrategies: (skill.recoveryStrategies ?? []).map((strategy) => ({
      trigger: strategy.trigger,
      action: strategy.action,
      maxAttempts: strategy.maxAttempts,
      escalateOnExhaustion: strategy.escalateOnExhaustion,
    })),
  };
  return stableStringify(content);
}

/**
 * Deterministic 64-bit hex fingerprint (two independent 32-bit hashes joined).
 * Stable across runs and platforms — no Math.random, no Date, no crypto
 * dependency, no BigInt.
 */
export function skillContentHash(skill: Skill): string {
  return fingerprint64(canonicalSkillContent(skill));
}

/** Two 32-bit hashes concatenated into 16 hex chars. */
export function fingerprint64(input: string): string {
  const a = fnv1a32(input).toString(16).padStart(8, "0");
  const b = djb2_32(input).toString(16).padStart(8, "0");
  return a + b;
}

/** Classic 32-bit FNV-1a. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Classic 32-bit djb2, included so a collision in one lane is not a collision. */
export function djb2_32(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 33) + input.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * JSON with object keys sorted so logically-equal values serialize identically,
 * independent of property insertion order.
 */
export function stableStringify(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stringify(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stringify(record[k])}`)
    .join(",")}}`;
}

/** Parameters are free-form; canonicalize keys so hashing is order-stable. */
function canonicalParameters(
  parameters: Record<string, unknown> | undefined,
): string {
  if (parameters === undefined) return "null";
  return stableStringify(parameters);
}

function normalizeStringArray(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v));
}
