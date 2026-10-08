/**
 * Final security audit (Phase 7, PART 14 + PART 15).
 *
 * A repository-wide, assertion-based audit of the production code
 * (`frontend/src/**` and `shared/**`, excluding tests). Every pattern below was
 * reviewed BEFORE being asserted, and classified:
 *
 *   SAFE           — the pattern does not occur anywhere in production code.
 *   INTENTIONAL    — occurs only where explicitly allow-listed (comments,
 *                    tests, or a documented provider constant outside the
 *                    extension source tree).
 *   FALSE POSITIVE — a scanner artifact (e.g. a test fixture string).
 *   VULNERABILITY  — none found; any that had been found would be fixed here.
 *
 * This file does not delete or weaken anything: it pins the security posture so
 * a regression becomes a test failure.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../skills/registry.js";
import { registerBuiltinSkills } from "../skills/builtin/index.js";
import { planSkill, createSkillCatalog } from "../skills/plan.js";
import { validateSkill } from "../../../shared/skill-validation.js";
import { validateEpisode, EPISODE_SCHEMA_VERSION } from "../../../shared/episode.js";
import { validateMcpRequest, MCP_PROTOCOL_VERSION, MCP_TOOLS } from "../../../shared/mcp-protocol.js";
import { validateBridgeRequest, BRIDGE_PROTOCOL_VERSION } from "../../../shared/bridge-protocol.js";
import {
  chooseExecutionMode,
  DEFAULT_EXECUTION_POLICY,
  MAX_MCP_REQUEST_BYTES,
} from "../../../shared/execution.js";
import { validateStructuredAction } from "../../../shared/types.js";
import type { Skill } from "../../../shared/types.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(ROOT, "..", ".."); // frontend/

/** SAFE — these must never appear in production code. */
const FORBIDDEN: Array<{ name: string; needle: string }> = [
  { name: "arbitrary-eval", needle: "eval(" },
  { name: "dynamic-function", needle: "new Function(" },
  { name: "shell-execution", needle: "child_process" },
  { name: "sync-shell-exec", needle: "execSync" },
  { name: "sync-shell-spawn", needle: "spawnSync" },
  { name: "raw-cdp-debugger", needle: "chrome.debugger" },
  { name: "raw-cdp-evaluate", needle: "Runtime.evaluate" },
  { name: "raw-websocket", needle: "new WebSocket" },
  { name: "remote-debugging-flag", needle: "remote-debugging" },
  { name: "node-require", needle: "require(" },
  { name: "node-process", needle: "process." },
];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

function productionFiles(): string[] {
  const files = [...walk(path.join(PROJECT, "src")), ...walk(path.join(PROJECT, "..", "shared"))];
  return files.filter((f) => !f.endsWith(".test.ts"));
}

describe("PART 14 — no arbitrary execution surface in production code", () => {
  it("has zero forbidden execution / CDP / shell / socket patterns", () => {
    const hits: string[] = [];
    for (const file of productionFiles()) {
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // Comment lines are documentation, not executable surface.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const pattern of FORBIDDEN) {
          if (line.includes(pattern.needle)) {
            hits.push(`${path.relative(PROJECT, file)}:${i + 1} [${pattern.name}]`);
          }
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("never registers a second action vocabulary", () => {
    // The only ActionType list lives in shared/types.ts; skills and the bridge
    // both validate against it rather than declaring their own.
    expect(
      validateSkill({
        id: "x_skill",
        namespace: "x",
        name: "x",
        version: "1.0.0",
        description: "x",
        supportedIntents: ["x"],
        examples: ["x"],
        status: "candidate",
        testStatus: "untested",
        createdAt: 1,
        modifiedAt: 1,
        createdBy: "human",
        requiredInputs: [],
        requiredCapabilities: ["read_page"],
        procedure: [{ description: "run", action: "exec_shell" as unknown as "read" }],
        verificationCriteria: [],
        recoveryStrategies: [],
        testFilePaths: [],
        lastTestedAt: null,
        lastTestResult: null,
        canaryRolloutPercent: 0,
        canaryStartedAt: null,
      } as unknown as Skill).valid,
    ).toBe(false);
  });

  it("rejects every unsafe verb at the StructuredAction schema", () => {
    for (const verb of ["eval", "execute_javascript", "cdp", "shell", "run", "import"]) {
      expect(validateStructuredAction({ action: verb }).ok).toBe(false);
    }
  });
});

describe("PART 15 — data-flow boundaries", () => {
  it("page content, model output, skills, episodes and MCP are all untrusted until validated", () => {
    expect(validateSkill(null).valid).toBe(false);
    expect(validateStructuredAction(null).ok).toBe(false);
    expect(validateEpisode(null).valid).toBe(false);
    expect(
      validateMcpRequest({ protocolVersion: MCP_PROTOCOL_VERSION, requestId: "m", tool: "rm" }, {
        protocolVersion: MCP_PROTOCOL_VERSION,
      }).ok,
    ).toBe(false);
    expect(
      validateBridgeRequest(
        { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: "b", taskId: "t", capability: "eval" },
        { protocolVersion: BRIDGE_PROTOCOL_VERSION, authorizedTaskIds: new Set(["t"]) },
      ).ok,
    ).toBe(false);
  });

  it("Browser Harness is optional: the default policy can never leave LOCAL", () => {
    expect(chooseExecutionMode(DEFAULT_EXECUTION_POLICY, { taskId: "t1" }).mode).toBe("local");
    expect(chooseExecutionMode({ allowExternal: true }, { taskId: "t1" }).mode).toBe("local");
    expect(
      chooseExecutionMode({ allowExternal: true, preference: "external" }, { taskId: "t1" }).mode,
    ).toBe("external");
  });

  it("MCP exposes only the documented safe tools", () => {
    for (const forbidden of [
      "execute_javascript",
      "raw_cdp",
      "shell",
      "filesystem",
      "get_credentials",
      "modify_webguard",
      "modify_verification",
      "modify_trust_policy",
    ]) {
      expect(MCP_TOOLS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("the registry cannot be tricked into trusting a candidate", () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry);
    // No path exists from candidate to trusted in one hop.
    expect(
      registry.register({
        id: "gen_skill",
        namespace: "gen",
        name: "Gen",
        version: "1.0.0",
        description: "generated",
        supportedIntents: ["gen"],
        examples: ["gen"],
        status: "candidate",
        testStatus: "untested",
        createdAt: 1,
        modifiedAt: 1,
        createdBy: "candidate_generator",
        requiredInputs: [],
        requiredCapabilities: ["read_page"],
        procedure: [{ description: "read", action: "read", target: "r1" }],
        verificationCriteria: [{ description: "ok", type: "text_present" }],
        recoveryStrategies: [],
        testFilePaths: [],
        lastTestedAt: null,
        lastTestResult: null,
        canaryRolloutPercent: 0,
        canaryStartedAt: null,
      }).ok,
    ).toBe(true);
    expect(registry.isExecutable("gen_skill")).toBe(false);
    expect(registry.setStatus("gen_skill", "trusted", { canaryComplete: true }).ok).toBe(false);
    expect(registry.setStatus("gen_skill", "approved", { approver: "x" }).ok).toBe(false);
  });

  it("a plan can only come from a registered, executable skill", () => {
    const registry = new SkillRegistry();
    const plan = planSkill({
      registry,
      catalog: createSkillCatalog([]),
      skillId: "anything",
      snapshot: { url: "https://x.example/", title: "x", generation: 1, items: [] },
    });
    expect(plan.status).toBe("unknown_skill");
    expect(plan.actions).toEqual([]);
  });

  it("budgets, bounds and secret redaction remain in force", async () => {
    const c = await import("../../../shared/constants.js");
    expect(c.MAX_ACTIONS_PER_TASK).toBe(25);
    expect(c.MAX_RECOVERY_ATTEMPTS_PER_ACTION).toBe(3);
    expect(c.MAX_QWEN_CALLS_PER_TASK).toBe(30);
    expect(c.MAX_EPISODES).toBeLessThanOrEqual(100);
    expect(c.MAX_EPISODE_ACTIONS).toBeLessThanOrEqual(c.MAX_ACTIONS_PER_TASK + 5);
    expect(MAX_MCP_REQUEST_BYTES).toBeLessThanOrEqual(64 * 1024);

    const { redactSecretText, REDACTED } = await import("../../../shared/redact.js");
    expect(redactSecretText("password=hunter2")).toContain(REDACTED);
    expect(redactSecretText("password=hunter2")).not.toContain("hunter2");
    expect(validateEpisode({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      episodeId: "ep_1",
      taskId: "t1",
      createdAt: 1,
      recordedAt: 1,
      goal: "pay with 4111111111111111",
      goalLang: "en",
      pageUrl: "",
      pageTitle: "",
      pageGenerations: [1],
      selectedSkill: null,
      actions: [],
      recoveryEvents: 0,
      finalOutcomeType: null,
      finalOutcomeText: null,
      finalStatus: "COMPLETE",
      success: true,
      completedActions: 0,
      registrySnapshot: [],
    }).valid).toBe(false); // un-redacted card number never persists
  });
});
