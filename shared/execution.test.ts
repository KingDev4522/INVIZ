/**
 * Execution Router tests (Phase 7, PART 16 — EXECUTION).
 * Proves external execution is policy-gated, defaults to LOCAL, and can never
 * be selected automatically or by the model alone.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  chooseExecutionMode,
  type ExecutionPolicy,
} from "./execution.js";

describe("chooseExecutionMode", () => {
  it("defaults to LOCAL with no policy at all", () => {
    expect(chooseExecutionMode(DEFAULT_EXECUTION_POLICY, { taskId: "t1" })).toEqual({
      mode: "local",
      reason: "external_not_permitted",
    });
    expect(chooseExecutionMode({}, { taskId: "t1" }).mode).toBe("local");
  });

  it("never escalates just because policy allows external", () => {
    const policy: ExecutionPolicy = { allowExternal: true };
    expect(chooseExecutionMode(policy, { taskId: "t1" })).toEqual({
      mode: "local",
      reason: "no_external_preference",
    });
  });

  it("requires the task to be on the allow-list", () => {
    const policy: ExecutionPolicy = {
      allowExternal: true,
      preference: "external",
      externalTaskIds: new Set(["t_allowed"]),
    };
    expect(chooseExecutionMode(policy, { taskId: "t_other" }).mode).toBe("local");
    expect(chooseExecutionMode(policy, { taskId: "t_other" }).reason).toBe(
      "task_not_allowed",
    );
    expect(chooseExecutionMode(policy, { taskId: "t_allowed" })).toEqual({
      mode: "external",
      reason: "explicit_external",
    });
  });

  it("selects external only with explicit policy + explicit preference", () => {
    const policy: ExecutionPolicy = {
      allowExternal: true,
      preference: "external",
      externalTaskIds: new Set(["t1"]),
    };
    expect(chooseExecutionMode(policy, { taskId: "t1" }).mode).toBe("external");
  });

  it("ignores an external preference when policy forbids it", () => {
    const policy: ExecutionPolicy = { allowExternal: false, preference: "external" };
    expect(chooseExecutionMode(policy, { taskId: "t1" }).mode).toBe("local");
  });

  it("is deterministic (same inputs, same decision)", () => {
    const policy: ExecutionPolicy = { allowExternal: true, preference: "external" };
    const a = chooseExecutionMode(policy, { taskId: "t1" });
    const b = chooseExecutionMode(policy, { taskId: "t1" });
    expect(a).toEqual(b);
  });
});

describe("resource bounds", () => {
  it("bounds bridge messages, MCP requests, retries and execution time", async () => {
    const mod = await import("./execution.js");
    expect(mod.MAX_BRIDGE_MESSAGE_BYTES).toBeGreaterThan(0);
    expect(mod.MAX_BRIDGE_MESSAGE_BYTES).toBeLessThanOrEqual(1024 * 1024);
    expect(mod.MAX_MCP_REQUEST_BYTES).toBeGreaterThan(0);
    expect(mod.MAX_MCP_REQUEST_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(mod.BRIDGE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(mod.BRIDGE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(mod.MAX_BRIDGE_TEXT_CHARS).toBeGreaterThan(0);
    expect(mod.MAX_MCP_RESULT_ITEMS).toBeGreaterThan(0);
    expect(mod.MAX_MCP_RESULT_ITEMS).toBeLessThanOrEqual(60);
  });

  it("keeps the existing task budgets intact", async () => {
    const c = await import("./constants.js");
    expect(c.MAX_ACTIONS_PER_TASK).toBe(25);
    expect(c.MAX_RECOVERY_ATTEMPTS_PER_ACTION).toBe(3);
    expect(c.MAX_QWEN_CALLS_PER_TASK).toBe(30);
    expect(c.MAX_TASK_DURATION_MS).toBeGreaterThan(0);
    expect(c.MAX_EPISODES).toBeGreaterThan(0);
    expect(c.MAX_EPISODE_ACTIONS).toBeGreaterThan(0);
  });
});
