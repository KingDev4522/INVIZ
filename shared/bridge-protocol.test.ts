/**
 * Bridge protocol tests (Phase 7, PART 3/4/16).
 * Proves the external protocol is versioned, typed and fail-closed: unknown
 * versions/capabilities, malformed args, stale generations, unauthorized tasks,
 * oversized payloads and malformed replies are all rejected.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { MAX_BRIDGE_MESSAGE_BYTES } from "./execution.js";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL_VERSION,
  bridgeCapabilityToAction,
  isBridgeCapability,
  validateBridgeRequest,
  validateBridgeResponse,
  type BridgeRequest,
} from "./bridge-protocol.js";

const TASK = "task_1";

function ctx(overrides: Partial<Parameters<typeof validateBridgeRequest>[1]> = {}) {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    authorizedTaskIds: new Set<string>([TASK]),
    currentGeneration: 5,
    ...overrides,
  };
}

function req(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: "r1",
    taskId: TASK,
    capability: "click",
    args: { target: "e2" },
    pageGeneration: 5,
    ...overrides,
  };
}

describe("capability catalog", () => {
  it("exposes only capabilities that map to existing INVIZ semantics", () => {
    expect(BRIDGE_CAPABILITIES.length).toBe(14);
    for (const cap of BRIDGE_CAPABILITIES) expect(isBridgeCapability(cap)).toBe(true);
    expect(isBridgeCapability("execute_javascript")).toBe(false);
    expect(isBridgeCapability("cdp")).toBe(false);
    expect(isBridgeCapability("shell")).toBe(false);
    expect(isBridgeCapability("")).toBe(false);
    expect(isBridgeCapability(42)).toBe(false);
  });

  it("projects action capabilities onto StructuredActions", () => {
    const action = bridgeCapabilityToAction("click", { target: "e2" }, 5);
    expect(action).toEqual({ action: "click", target: "e2", pageGeneration: 5 });
    expect(bridgeCapabilityToAction("read_region", { target: "r1" }, 5)?.action).toBe("read");
    // Observation capabilities produce no action at all.
    expect(bridgeCapabilityToAction("get_page_state", {}, 5)).toBeNull();
    expect(bridgeCapabilityToAction("observe", {}, 5)).toBeNull();
    expect(bridgeCapabilityToAction("wait_for", {}, 5)).toBeNull();
  });
});

describe("validateBridgeRequest — fail closed", () => {
  it("accepts a well-formed request", () => {
    const out = validateBridgeRequest(req(), ctx());
    expect(out.ok).toBe(true);
    expect(out.value?.capability).toBe("click");
  });

  it("rejects an unknown protocol version", () => {
    const out = validateBridgeRequest(req({ protocolVersion: 99 }), ctx());
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("unsupported_protocol");
  });

  it("rejects an unknown capability", () => {
    const out = validateBridgeRequest(req({ capability: "eval" }), ctx());
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("unknown_capability");
  });

  it("rejects an unauthorized task id", () => {
    const out = validateBridgeRequest(req({ taskId: "evil" }), ctx());
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("unauthorized_task");
  });

  it("rejects a stale page generation", () => {
    const out = validateBridgeRequest(req({ pageGeneration: 4 }), ctx());
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("stale_generation");
  });

  it("rejects malformed payloads", () => {
    expect(validateBridgeRequest(null, ctx()).errorCode).toBe("malformed");
    expect(validateBridgeRequest("x", ctx()).errorCode).toBe("malformed");
    expect(
      validateBridgeRequest(req({ requestId: "" }), ctx()).errorCode,
    ).toBe("invalid_args");
  });

  it("rejects action args that fail the closed StructuredAction schema", () => {
    // click without a target
    const noTarget = validateBridgeRequest(req({ args: {} }), ctx());
    expect(noTarget.ok).toBe(false);
    expect(noTarget.errorCode).toBe("invalid_args");

    // smuggled field
    const smuggled = validateBridgeRequest(
      req({ args: { target: "e2", script: "alert(1)" } }),
      ctx(),
    );
    expect(smuggled.ok).toBe(false);

    // dangerous navigation scheme
    const jsUrl = validateBridgeRequest(
      req({
        capability: "navigate",
        args: { parameters: { url: "javascript:alert(1)" } },
      }),
      ctx(),
    );
    expect(jsUrl.ok).toBe(false);
  });

  it("accepts a grounding node descriptor and keeps it out of the action", () => {
    const out = validateBridgeRequest(
      req({ args: { target: "e2", node: { role: "button", name: "Submit" } } }),
      ctx(),
    );
    expect(out.ok).toBe(true);
    expect((out.value?.args as Record<string, unknown>)["node"]).toEqual({
      role: "button",
      name: "Submit",
    });
    // The node never leaks into the closed StructuredAction schema.
    expect(bridgeCapabilityToAction("click", out.value?.args ?? {}, 5)).toEqual({
      action: "click",
      target: "e2",
      pageGeneration: 5,
    });
  });

  it("rejects malformed node descriptors", () => {
    for (const node of [
      "Submit",
      { role: "", name: "x" },
      { role: "button" },
      { role: "button", name: "x".repeat(201) },
    ]) {
      const out = validateBridgeRequest(
        req({ args: { target: "e2", node } }),
        ctx(),
      );
      expect(out.ok).toBe(false);
      expect(out.errorCode).toBe("invalid_args");
    }
  });

  it("rejects unknown argument keys (never silently drops them)", () => {
    const out = validateBridgeRequest(
      req({ capability: "get_page_state", args: { script: "alert(1)" } }),
      ctx(),
    );
    expect(out.ok).toBe(false);
    expect(out.errors.join(" ")).toContain("unknown argument");
  });

  it("rejects an oversized request", () => {
    const big = req({ args: { target: "e2", pad: "x".repeat(MAX_BRIDGE_MESSAGE_BYTES) } });
    const out = validateBridgeRequest(big, ctx());
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("oversized");
  });

  it("rejects when the task set is empty (nothing authorized by default)", () => {
    const out = validateBridgeRequest(req(), ctx({ authorizedTaskIds: new Set() }));
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("unauthorized_task");
  });
});

describe("validateBridgeResponse — malformed replies are never trusted", () => {
  const expectArgs = { requestId: "r1", protocolVersion: BRIDGE_PROTOCOL_VERSION };

  it("accepts a well-formed success", () => {
    const out = validateBridgeResponse(
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: "r1",
        ok: true,
        observation: { kind: "result" },
      },
      expectArgs,
    );
    expect(out.ok).toBe(true);
    expect(out.value?.ok).toBe(true);
  });

  it("rejects a request-id or version mismatch", () => {
    expect(
      validateBridgeResponse(
        { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: "other", ok: true, observation: { kind: "result" } },
        expectArgs,
      ).ok,
    ).toBe(false);
    expect(
      validateBridgeResponse(
        { protocolVersion: 2, requestId: "r1", ok: true, observation: { kind: "result" } },
        expectArgs,
      ).errorCode,
    ).toBe("unsupported_protocol");
  });

  it("rejects a success without an observation, or an unknown kind", () => {
    expect(
      validateBridgeResponse(
        { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: "r1", ok: true },
        expectArgs,
      ).ok,
    ).toBe(false);
    expect(
      validateBridgeResponse(
        {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId: "r1",
          ok: true,
          observation: { kind: "run_shell" },
        },
        expectArgs,
      ).ok,
    ).toBe(false);
  });

  it("bounds returned text and items", () => {
    const out = validateBridgeResponse(
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: "r1",
        ok: true,
        observation: {
          kind: "region",
          text: "y".repeat(100_000),
          items: Array.from({ length: 500 }, (_, i) => ({
            id: `e${i}`,
            role: "link",
            name: "n".repeat(1000),
          })),
        },
      },
      expectArgs,
    );
    expect(out.ok).toBe(true);
    expect(out.value?.observation?.text!.length).toBeLessThanOrEqual(4000);
    expect((out.value?.observation?.items ?? []).length).toBeLessThanOrEqual(60);
  });

  it("normalizes an unknown failure code instead of trusting it", () => {
    const out = validateBridgeResponse(
      {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: "r1",
        ok: false,
        errorCode: "totally_made_up",
      },
      expectArgs,
    );
    expect(out.ok).toBe(true);
    expect(out.value?.errorCode).toBe("internal");
  });
});
