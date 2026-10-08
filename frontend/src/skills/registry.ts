/**
 * Skill Registry — REAL (Phase 1, hardened in Phase 4).
 *
 * A versioned, trust-aware catalog of reusable browser skills. Holds skill
 * metadata (never executable code); skills describe procedures in terms of the
 * existing INVIZ ActionType vocabulary.
 *
 * Security invariants enforced here:
 *  - A candidate skill is NEVER executable and can never silently become
 *    trusted (lifecycle transitions are gated, see canTransition()).
 *  - A newly registered skill never silently replaces an existing
 *    approved/trusted/canary skill: same-id+version registration is rejected
 *    unless the caller explicitly opts in, and a DIFFERENT implementation under
 *    the same trusted id+version is refused outright (Phase 4 content hash).
 *  - A new VERSION never inherits trust: registering an approved/canary/trusted
 *    version of an already-known skill is refused unless an explicit approval
 *    warrant is supplied (Phase 4).
 *  - Execution is governed by an explicit policy: `tested` and `canary` only
 *    run when policy allows them; `disabled` never runs (Phase 4).
 *  - Only validated skills enter the registry (validateSkill).
 */
import type {
  Skill,
  SkillFilter,
  SkillStatus,
  SkillSummary,
} from "../../../shared/types.js";
import { validateSkill } from "../../../shared/skill-validation.js";
import { skillContentHash } from "../../../shared/skill-integrity.js";

export interface SkillRegistrationResult {
  ok: boolean;
  skill?: Skill;
  errors: string[];
  warnings: string[];
}

export interface SkillRegisterOptions {
  /** Replace an existing entry with the same id+version. Default false. */
  replace?: boolean;
  /**
   * Allow replacement of an approved/canary/trusted skill. Default false.
   * NOTE: even when true, replacement with a DIFFERENT implementation under the
   * same id+version is still refused — this flag only permits refreshing the
   * trust/rollout state of the same implementation.
   */
  allowTrustedReplacement?: boolean;
  /**
   * Explicit approval warrant required to register an approved/canary/trusted
   * NEW VERSION of an already-known skill. Without it, such a registration is
   * refused (trust never inherits across versions).
   */
  approval?: { approver: string };
}

/**
 * Allowed trust-state transitions.
 *
 * Lifecycle: candidate → tested → approved → canary → trusted.
 * Any state → disabled (manual override). disabled → candidate is allowed so
 * a disabled skill can be re-worked. No transition may skip a gate, so a
 * generated candidate can never jump straight to trusted.
 */
const TRANSITIONS: Readonly<Record<SkillStatus, readonly SkillStatus[]>> = {
  candidate: ["tested", "disabled"],
  tested: ["approved", "candidate", "disabled"],
  approved: ["canary", "trusted", "tested", "disabled"],
  canary: ["trusted", "approved", "disabled"],
  trusted: ["disabled"],
  disabled: ["candidate", "tested"],
};

export function canTransition(from: SkillStatus, to: SkillStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** Statuses that are past the candidate gate but can still be withheld. */
const TRUST_QUALIFIED: ReadonlySet<SkillStatus> = new Set<SkillStatus>([
  "tested",
  "approved",
  "canary",
  "trusted",
]);

/**
 * Deterministic execution policy. `approved`/`trusted` execute by default;
 * `tested` and `canary` require explicit opt-in. `disabled`/`candidate` never
 * execute regardless of policy.
 */
export interface SkillExecutionPolicy {
  /** Trust-qualified statuses allowed to execute without further opt-in. */
  executableStatuses: readonly SkillStatus[];
  /** Allow skills in the explicit `canary` rollout state to execute. */
  allowCanary: boolean;
}

export const DEFAULT_SKILL_EXECUTION_POLICY: SkillExecutionPolicy = {
  executableStatuses: ["approved", "trusted"],
  allowCanary: false,
};

/**
 * A read-only view of the registry at a point in time. A plan holds one of
 * these so a registry mutation mid-execution cannot silently change the meaning
 * of an already-created plan (Phase 4 snapshot semantics).
 */
export interface SkillRegistryView {
  get(id: string): Skill | null;
  getVersion(id: string, version: string): Skill | null;
  versions(id: string): string[];
  isEnabled(id: string): boolean;
  isExecutable(id: string): boolean;
}

export interface SkillRegistryOptions {
  now?: () => number;
  executionPolicy?: SkillExecutionPolicy;
}

function toSummary(skill: Skill): SkillSummary {
  return {
    id: skill.id,
    namespace: skill.namespace,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    status: skill.status,
    testStatus: skill.testStatus,
    supportedIntents: [...skill.supportedIntents],
    requiredCapabilities: [...skill.requiredCapabilities],
  };
}

function matchesFilter(skill: Skill, filter: SkillFilter): boolean {
  if (filter.namespace !== undefined && skill.namespace !== filter.namespace) {
    return false;
  }
  if (filter.status !== undefined) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(skill.status)) return false;
  }
  if (
    filter.requiresCapability !== undefined &&
    !skill.requiredCapabilities.includes(filter.requiresCapability)
  ) {
    return false;
  }
  if (filter.search !== undefined) {
    const needle = filter.search.trim().toLowerCase();
    if (needle !== "") {
      const haystack = [
        skill.id,
        skill.name,
        skill.description,
        ...skill.supportedIntents,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
  }
  return true;
}

/**
 * Parses a MAJOR.MINOR.PATCH version into comparable parts.
 * Returns null when the string is not SemVer — the registry refuses to order
 * versions it cannot understand rather than guessing.
 */
export function parseVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** SemVer-ish comparison: negative if a<b, 0 if equal, positive if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) {
    throw new Error(`cannot compare non-SemVer versions: "${a}", "${b}"`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function highestVersion(versions: Map<string, Skill>): Skill | null {
  let best: Skill | null = null;
  for (const skill of versions.values()) {
    if (best === null || compareVersions(skill.version, best.version) > 0) {
      best = skill;
    }
  }
  return best;
}

function executableUnderPolicy(
  status: SkillStatus,
  policy: SkillExecutionPolicy,
): boolean {
  if (!TRUST_QUALIFIED.has(status)) return false;
  if (status === "canary") return policy.allowCanary;
  return policy.executableStatuses.includes(status);
}

/**
 * In-memory, versioned skill catalog.
 *
 * One entry per (id, version). `get(id)` returns the ACTIVE version of that
 * skill — the pinned rollback target if one is set, otherwise the highest
 * known version. `getVersion(id, version)` returns a specific one.
 */
export class SkillRegistry implements SkillRegistryView {
  /** id → version → skill */
  private byId = new Map<string, Map<string, Skill>>();
  /** id → content hash of the implementation currently registered. */
  private fingerprints = new Map<string, string>();
  /** id → explicitly selected (rolled-back) version. */
  private activeVersion = new Map<string, string>();
  private readonly now: () => number;
  private readonly policy: SkillExecutionPolicy;
  private listeners = new Set<() => void>();

  constructor(options: SkillRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.policy = options.executionPolicy ?? DEFAULT_SKILL_EXECUTION_POLICY;
  }

  /** The active execution policy (for advertising/tests). */
  get executionPolicy(): SkillExecutionPolicy {
    return this.policy;
  }

  /**
   * Registers a validated skill. Rejects malformed skills outright, refuses to
   * silently overwrite an existing version, refuses a different implementation
   * under a trusted version, and refuses a new version that would inherit trust.
   */
  register(skill: Skill, opts: SkillRegisterOptions = {}): SkillRegistrationResult {
    const validation = validateSkill(skill);
    if (!validation.valid) {
      return { ok: false, errors: validation.errors, warnings: validation.warnings };
    }
    const versions = this.byId.get(skill.id);
    const existing = versions?.get(skill.version);

    // --- New-version trust guard: trust never inherits across versions. ---
    const isNewVersion = versions !== undefined && existing === undefined;
    if (
      isNewVersion &&
      (skill.status === "approved" ||
        skill.status === "canary" ||
        skill.status === "trusted") &&
      (opts.approval === undefined || opts.approval.approver.trim() === "")
    ) {
      return {
        ok: false,
        errors: [
          `${skill.id}@${skill.version}: a new version must not inherit trust — ` +
            `register as candidate/tested, or pass an explicit approval warrant`,
        ],
        warnings: validation.warnings,
      };
    }

    if (existing !== undefined) {
      if (opts.replace !== true) {
        return {
          ok: false,
          errors: [`skill ${skill.id}@${skill.version} already registered`],
          warnings: validation.warnings,
        };
      }
      const protectedExisting =
        existing.status === "trusted" ||
        existing.status === "approved" ||
        existing.status === "canary";
      if (protectedExisting && opts.allowTrustedReplacement !== true) {
        return {
          ok: false,
          errors: [
            `refusing to silently replace ${existing.status} skill ` +
              `${skill.id}@${skill.version}`,
          ],
          warnings: validation.warnings,
        };
      }
      // Even with an explicit replacement permit, a DIFFERENT implementation may
      // not masquerade under the same id+version (Phase 4 integrity).
      const key = `${skill.id}@${skill.version}`;
      const existingHash = this.fingerprints.get(key);
      const newHash = skillContentHash(skill);
      if (existingHash !== undefined && existingHash !== newHash) {
        return {
          ok: false,
          errors: [
            `refusing to replace ${existing.status} skill ${skill.id}@${skill.version} ` +
              `with a different implementation`,
          ],
          warnings: validation.warnings,
        };
      }
    }

    const stored: Skill = { ...skill, modifiedAt: this.now() };
    if (versions === undefined) {
      this.byId.set(skill.id, new Map([[skill.version, stored]]));
    } else {
      versions.set(skill.version, stored);
    }
    this.fingerprints.set(`${skill.id}@${skill.version}`, skillContentHash(stored));
    this.emit();
    return { ok: true, skill: stored, errors: [], warnings: validation.warnings };
  }

  /**
   * Applies a persisted trust/rollout state to an EXISTING id+version without
   * running lifecycle gates. The caller MUST have validated the skill and
   * confirmed the implementation hash matches (Phase 4 reload path). This never
   * creates a version and never changes the implementation.
   */
  applyPersistedState(skill: Skill): { ok: boolean; error?: string; skill?: Skill } {
    const existing = this.byId.get(skill.id)?.get(skill.version);
    if (existing === undefined) {
      return { ok: false, error: `no such version ${skill.id}@${skill.version}` };
    }
    const key = `${skill.id}@${skill.version}`;
    const expected = this.fingerprints.get(key);
    const actual = skillContentHash(skill);
    if (expected !== undefined && expected !== actual) {
      return {
        ok: false,
        error: `${skill.id}@${skill.version}: persisted implementation does not match`,
      };
    }
    const updated: Skill = {
      ...existing,
      status: skill.status,
      testStatus: skill.testStatus,
      canaryRolloutPercent: skill.canaryRolloutPercent,
      canaryStartedAt: skill.canaryStartedAt,
      modifiedAt: this.now(),
    };
    this.byId.get(skill.id)?.set(skill.version, updated);
    this.emit();
    return { ok: true, skill: updated };
  }

  /** Highest-version skill for an id, or the pinned version if one is set. */
  get(id: string): Skill | null {
    const versions = this.byId.get(id);
    if (versions === undefined || versions.size === 0) return null;
    const pinned = this.activeVersion.get(id);
    if (pinned !== undefined) {
      const skill = versions.get(pinned);
      if (skill !== undefined) return skill;
    }
    return highestVersion(versions);
  }

  /** A specific version of a skill, or null. */
  getVersion(id: string, version: string): Skill | null {
    return this.byId.get(id)?.get(version) ?? null;
  }

  /** All registered versions of a skill, oldest → newest. */
  versions(id: string): string[] {
    const versions = this.byId.get(id);
    if (versions === undefined) return [];
    return [...versions.keys()].sort((a, b) => compareVersions(a, b));
  }

  /** Every skill, one entry per id (the active version). */
  list(filter: SkillFilter = {}): SkillSummary[] {
    const out: SkillSummary[] = [];
    for (const id of this.byId.keys()) {
      const skill = this.get(id);
      if (skill !== null && matchesFilter(skill, filter)) out.push(toSummary(skill));
    }
    return out;
  }

  /** Discovery: alias of list(), reads as "what can the agent use". */
  discover(filter: SkillFilter = {}): SkillSummary[] {
    return this.list(filter);
  }

  /**
   * True when the skill exists and has not been manually disabled (the
   * kill-switch). "Enabled" is orthogonal to trust: a candidate is enabled
   * (present, not disabled) yet still NOT executable — see isExecutable().
   */
  isEnabled(id: string): boolean {
    const skill = this.get(id);
    return skill !== null && skill.status !== "disabled";
  }

  /**
   * The authoritative execution gate: exists AND its status is permitted by the
   * current execution policy. `candidate`/`disabled` are never executable;
   * `tested` and `canary` require explicit policy opt-in.
   */
  isExecutable(id: string): boolean {
    const skill = this.get(id);
    if (skill === null) return false;
    return executableUnderPolicy(skill.status, this.policy);
  }

  /**
   * Moves a skill through its trust lifecycle. Transitions are gated:
   * candidate → tested requires passing tests; tested → approved requires an
   * explicit approver; approved → trusted and canary → trusted require canary
   * completion. No path allows candidate → trusted.
   */
  setStatus(
    id: string,
    to: SkillStatus,
    opts: {
      version?: string;
      approver?: string;
      canaryComplete?: boolean;
      canaryRolloutPercent?: number;
      canaryStartedAt?: number;
    } = {},
  ): { ok: boolean; error?: string; skill?: Skill } {
    const current =
      opts.version !== undefined ? this.getVersion(id, opts.version) : this.get(id);
    if (current === null) return { ok: false, error: `unknown skill ${id}` };
    if (!canTransition(current.status, to)) {
      return {
        ok: false,
        error: `illegal transition ${current.status} → ${to} for ${id}`,
      };
    }
    if (to === "tested" && current.testStatus !== "passing") {
      return { ok: false, error: `${id}: cannot become tested with failing/untested tests` };
    }
    if (to === "approved" && (opts.approver === undefined || opts.approver.trim() === "")) {
      return { ok: false, error: `${id}: approval requires an approver` };
    }
    if (to === "trusted" && opts.canaryComplete !== true) {
      return { ok: false, error: `${id}: trusted requires completed canary rollout` };
    }
    const rollout: Partial<Skill> = {};
    if (to === "canary") {
      rollout.canaryRolloutPercent =
        opts.canaryRolloutPercent ?? current.canaryRolloutPercent;
      rollout.canaryStartedAt = opts.canaryStartedAt ?? this.now();
    }
    const updated: Skill = {
      ...current,
      status: to,
      modifiedAt: this.now(),
      ...rollout,
    };
    const versions = this.byId.get(id);
    if (versions === undefined) return { ok: false, error: `unknown skill ${id}` };
    versions.set(current.version, updated);
    this.emit();
    return { ok: true, skill: updated };
  }

  /**
   * Rolls a skill back to a previously registered version by making that
   * version the ACTIVE one again. Operates only at the version-selection layer:
   * it never mutates a skill definition, WebGuard, ActionType or Verification.
   */
  rollback(
    id: string,
    toVersion: string,
  ): { ok: boolean; error?: string; skill?: Skill } {
    const target = this.getVersion(id, toVersion);
    if (target === null) {
      return { ok: false, error: `no version ${toVersion} for ${id}` };
    }
    if (target.status === "disabled") {
      return { ok: false, error: `version ${toVersion} of ${id} is disabled` };
    }
    this.activeVersion.set(id, toVersion);
    this.emit();
    return { ok: true, skill: target };
  }

  /** Clears a rollback pin, returning to "highest version wins". */
  clearRollback(id: string): void {
    this.activeVersion.delete(id);
    this.emit();
  }

  /** Every registered skill version (for persistence export). */
  exportSkills(): Skill[] {
    const out: Skill[] = [];
    for (const versions of this.byId.values()) {
      for (const skill of versions.values()) out.push({ ...skill });
    }
    return out;
  }

  /**
   * Captures an immutable, policy-frozen view of the current active versions.
   * A plan built from this view is unaffected by later registry mutations.
   */
  snapshot(): SkillRegistryView {
    const captured = new Map<string, Skill>();
    for (const id of this.byId.keys()) {
      const skill = this.get(id);
      if (skill !== null) captured.set(id, { ...skill });
    }
    const policy = this.policy;
    return {
      get: (id) => captured.get(id) ?? null,
      getVersion: (id, version) => {
        const skill = captured.get(id);
        return skill !== undefined && skill.version === version ? skill : null;
      },
      versions: (id) => {
        const skill = captured.get(id);
        return skill !== null && skill !== undefined ? [skill.version] : [];
      },
      isEnabled: (id) => {
        const skill = captured.get(id);
        return skill !== undefined && skill.status !== "disabled";
      },
      isExecutable: (id) => {
        const skill = captured.get(id);
        if (skill === undefined) return false;
        return executableUnderPolicy(skill.status, policy);
      },
    };
  }

  /** Subscribes to registry mutations (used by the persistence layer). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never break a registry mutation.
      }
    }
  }

  /** Number of distinct skill ids registered. */
  get size(): number {
    return this.byId.size;
  }
}
