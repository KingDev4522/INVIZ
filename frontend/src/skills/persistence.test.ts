/**
 * Skill persistence tests (Phase 4).
 * Proves persistence is validated, bounded, fail-closed, and can only restore
 * trust state — never smuggle a different implementation or lose a disable.
 * No chrome, no network (MemorySkillStore).
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_BYTES,
  MAX_PERSISTED_SKILLS,
  MemorySkillStore,
  SKILL_STORE_SCHEMA_VERSION,
  attachPersistence,
  loadRegistryFromStore,
  persistRegistry,
  serializeSkills,
} from "./persistence.js";
import { SkillRegistry } from "./registry.js";
import { registerBuiltinSkills } from "./builtin/index.js";
import type { Skill } from "../../../shared/types.js";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "custom_skill",
    namespace: "custom",
    name: "Custom skill",
    version: "1.0.0",
    description: "A custom skill used by the persistence tests.",
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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Phase 4 persistence — round trip", () => {
  it("survives persistence and reload as an executable skill", async () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "approved" }));
    const store = new MemorySkillStore();
    const saved = await persistRegistry(store, reg);
    expect(saved.ok).toBe(true);

    const reg2 = new SkillRegistry();
    const loaded = await loadRegistryFromStore(store, reg2);
    expect(loaded.registered).toBe(1);
    expect(loaded.rejected).toEqual([]);
    expect(reg2.get("custom_skill")?.description).toContain("custom skill");
    expect(reg2.isExecutable("custom_skill")).toBe(true);
  });

  it("persists a disabled state across reload (kill-switch survives)", async () => {
    const reg = new SkillRegistry();
    reg.register(skill({ status: "disabled" }));
    const store = new MemorySkillStore();
    await persistRegistry(store, reg);

    const reg2 = new SkillRegistry();
    await loadRegistryFromStore(store, reg2);
    expect(reg2.get("custom_skill")?.status).toBe("disabled");
    expect(reg2.isExecutable("custom_skill")).toBe(false);
  });

  it("round-trips the three built-in skills and their trust overlays", async () => {
    const reg = new SkillRegistry();
    registerBuiltinSkills(reg);
    reg.setStatus("generic_read_region", "disabled");
    const store = new MemorySkillStore();
    await persistRegistry(store, reg);

    const reg2 = new SkillRegistry();
    registerBuiltinSkills(reg2);
    const loaded = await loadRegistryFromStore(store, reg2);
    expect(loaded.applied).toBe(3);
    expect(loaded.rejected).toEqual([]);
    expect(reg2.get("generic_read_region")?.status).toBe("disabled");
    expect(reg2.isExecutable("generic_read_region")).toBe(false);
    expect(reg2.isExecutable("github_find_contributors")).toBe(true);
    expect(reg2.isExecutable("generic_find_element")).toBe(true);
  });
});

describe("Phase 4 persistence — fail-closed loading", () => {
  it("rejects an invalid persisted skill and does not register it", async () => {
    const store = new MemorySkillStore();
    await store.save(
      JSON.stringify({
        schemaVersion: SKILL_STORE_SCHEMA_VERSION,
        savedAt: 1,
        records: [{ contentHash: "deadbeefdeadbeef", status: "approved", skill: { id: "bad id" } }],
      }),
    );
    const reg = new SkillRegistry();
    const loaded = await loadRegistryFromStore(store, reg);
    expect(loaded.registered).toBe(0);
    expect(loaded.rejected.length).toBeGreaterThan(0);
    expect(reg.size).toBe(0);
  });

  it("rejects a record whose content hash does not match its implementation", async () => {
    const reg = new SkillRegistry();
    reg.register(skill());
    const store = new MemorySkillStore();
    await persistRegistry(store, reg);

    const file = JSON.parse((await store.load()) as string);
    file.records[0].skill.procedure = [
      { description: "evil", action: "read", target: "r9" },
    ];
    await store.save(JSON.stringify(file));

    const reg2 = new SkillRegistry();
    const loaded = await loadRegistryFromStore(store, reg2);
    expect(loaded.registered).toBe(0);
    expect(loaded.rejected.some((r) => r.includes("hash mismatch"))).toBe(true);
  });

  it("refuses to overwrite a built-in implementation via a tampered file", async () => {
    const reg = new SkillRegistry();
    registerBuiltinSkills(reg);
    const store = new MemorySkillStore();
    await persistRegistry(store, reg);

    const file = JSON.parse((await store.load()) as string);
    const record = file.records.find(
      (r: { skill: Skill }) => r.skill.id === "github_find_contributors",
    );
    record.skill.procedure = [{ description: "evil", action: "read", target: "e1" }];
    await store.save(JSON.stringify(file));

    const reg2 = new SkillRegistry();
    registerBuiltinSkills(reg2);
    const loaded = await loadRegistryFromStore(store, reg2);
    expect(loaded.rejected.some((r) => r.includes("hash mismatch"))).toBe(true);
    // The registered built-in implementation is untouched.
    expect(reg2.getVersion("github_find_contributors", "1.0.0")?.version).toBe("1.0.0");
  });

  it("rejects an unsupported schema version", async () => {
    const store = new MemorySkillStore();
    await store.save(JSON.stringify({ schemaVersion: 999, savedAt: 1, records: [] }));
    const reg = new SkillRegistry();
    const loaded = await loadRegistryFromStore(store, reg);
    expect(loaded.rejected.some((r) => r.includes("schema version"))).toBe(true);
  });

  it("rejects an oversized persisted file", async () => {
    const store = new MemorySkillStore();
    await store.save("x".repeat(MAX_PERSISTED_BYTES + 1));
    const reg = new SkillRegistry();
    const loaded = await loadRegistryFromStore(store, reg);
    expect(loaded.rejected.some((r) => r.includes("byte bound"))).toBe(true);
  });

  it("rejects malformed JSON", async () => {
    const store = new MemorySkillStore();
    await store.save("{not json");
    const reg = new SkillRegistry();
    const loaded = await loadRegistryFromStore(store, reg);
    expect(loaded.rejected.some((r) => r.includes("valid JSON"))).toBe(true);
  });
});

describe("Phase 4 persistence — bounds & mutation hook", () => {
  it("drops surplus skills past the count bound instead of failing", () => {
    const many: Skill[] = [];
    for (let i = 0; i < MAX_PERSISTED_SKILLS + 3; i++) {
      many.push(skill({ id: `skill_${i}` }));
    }
    const { saved, skipped } = serializeSkills(many);
    expect(saved).toBe(MAX_PERSISTED_SKILLS);
    expect(skipped.length).toBe(3);
  });

  it("persists on every registry mutation when attached", async () => {
    const reg = new SkillRegistry();
    const store = new MemorySkillStore();
    const handle = attachPersistence(store, reg);
    reg.register(skill());
    await flush();
    expect(handle.lastError()).toBeNull();
    const reloaded = new SkillRegistry();
    await loadRegistryFromStore(store, reloaded);
    expect(reloaded.get("custom_skill")).not.toBeNull();
    handle.detach();
  });
});
