/**
 * Browser Harness bridge — REAL (Phase 7, OPTIONAL).
 *
 * An external executor that lives OUTSIDE the trusted MV3 core. It speaks only
 * the versioned typed capability protocol; it never exposes CDP, never opens a
 * socket itself (the transport is injected and owned by the host process), and
 * never evaluates arbitrary JavaScript.
 *
 * The bridge does NOT decide safety. INVIZ already ran validateStructuredAction,
 * WebGuard, consent and the budgets before calling it. This module only:
 * maps an already-authorized StructuredAction onto a capability, sends one
 * bounded request, validates the reply, and reports a result. There is exactly
 * ONE attempt — no retries, no escalation, no hidden queue.
 *
 * Failure is always safe: unavailable, timeout, malformed or unsupported all
 * surface as a failed ExecutionResult so the controller falls back to local
 * execution or uses its existing recovery semantics.
 */
import {
  BRIDGE_PROTOCOL_VERSION,
  bridgeCapabilityToAction,
  isBridgeCapability,
  validateBridgeResponse,
  type BridgeCapability,
  type BridgeRequest,
  type BridgeResponse,
} from "../../../shared/bridge-protocol.js";
import { BRIDGE_TIMEOUT_MS } from "../../../shared/execution.js";
import { logger } from "../../../shared/logger.js";
import type {
  ActionType,
  ExecutionResult,
  StructuredAction,
} from "../../../shared/types.js";

export interface ExternalExecuteContext {
  tabId: number;
  pageGeneration: number;
  /** Required: the bridge authorizes per task. */
  taskId: string;
  /**
   * Extension-side element grounding (role + name from the live snapshot).
   * The eNN target id is meaningless outside the tab, so the host resolves
   * this descriptor against the real accessibility tree instead. Absent for
   * targetless actions (navigate, web_search, …).
   */
  node?: { role: string; name: string };
  /**
   * Page URL the extension acted on. The host drives the shared Chrome
   * instance (its own tab handles), so it attaches to the tab with this URL
   * before acting — never some other tab the user has open.
   */
  url?: string;
}

/** The optional external execution port the Execution Router selects. */
export interface ExternalExecutor {
  readonly kind: string;
  execute(
    action: StructuredAction,
    ctx: ExternalExecuteContext,
  ): Promise<ExecutionResult>;
}

/** Transport owned by the host process — never constructed inside MV3. */
export interface BridgeTransport {
  send(request: BridgeRequest): Promise<unknown>;
}

/** Action types with an external capability; null = must run locally. */
const ACTION_CAPABILITY: Readonly<Record<ActionType, BridgeCapability | null>> = {
  click: "click",
  type: "type",
  focus: "focus",
  select: "select",
  scroll: "scroll",
  press_key: "press_key",
  navigate: "navigate",
  go_back: "go_back",
  go_forward: "go_forward",
  read: "read_region",
  web_search: null, // local-only: backend search, not a browser operation
  browser_search: null, // local-only: chrome.search / tabs.update in SW context
  open_tab: null,
  close_tab: null,
};

function failed(
  action: StructuredAction,
  ctx: ExternalExecuteContext,
  errorCode: string,
): ExecutionResult {
  return {
    status: "failed",
    action: action.action,
    target: action.target,
    pageGeneration: ctx.pageGeneration,
    timestamp: Date.now(),
    errorCode,
  };
}

export interface BrowserHarnessBridgeOptions {
  transport: BridgeTransport;
  protocolVersion?: number;
  timeoutMs?: number;
  /**
   * Task authorization (defence in depth — the router already gated this).
   * An empty set authorizes nothing; a predicate lets the host decide without
   * knowing generated task ids up front.
   */
  authorizedTaskIds: ReadonlySet<string> | ((taskId: string) => boolean);
  /** Current PageState generation; stale requests are refused. */
  currentGeneration?: () => number;
  now?: () => number;
}

export class BrowserHarnessBridge implements ExternalExecutor {
  readonly kind = "browser_harness";
  private readonly transport: BridgeTransport;
  private readonly protocolVersion: number;
  private readonly timeoutMs: number;
  private readonly authorizedTaskIds: ReadonlySet<string> | ((taskId: string) => boolean);
  private readonly currentGeneration: () => number | undefined;
  private counter = 0;

  private taskAuthorized(taskId: string): boolean {
    return typeof this.authorizedTaskIds === "function"
      ? this.authorizedTaskIds(taskId)
      : this.authorizedTaskIds.has(taskId);
  }

  constructor(opts: BrowserHarnessBridgeOptions) {
    this.transport = opts.transport;
    this.protocolVersion = opts.protocolVersion ?? BRIDGE_PROTOCOL_VERSION;
    this.timeoutMs = opts.timeoutMs ?? BRIDGE_TIMEOUT_MS;
    this.authorizedTaskIds = opts.authorizedTaskIds;
    this.currentGeneration = opts.currentGeneration ?? (() => undefined);
  }

  /** Single attempt. Never retries, never escalates, never throws. */
  async execute(
    action: StructuredAction,
    ctx: ExternalExecuteContext,
  ): Promise<ExecutionResult> {
    const capability = ACTION_CAPABILITY[action.action];
    if (capability === null || !isBridgeCapability(capability)) {
      // Not expressible externally — the router falls back to LOCAL.
      return failed(action, ctx, "BRIDGE_UNSUPPORTED_CAPABILITY");
    }
    if (!this.taskAuthorized(ctx.taskId)) {
      return failed(action, ctx, "BRIDGE_TASK_NOT_AUTHORIZED");
    }

    this.counter += 1;
    const request: BridgeRequest = {
      protocolVersion: this.protocolVersion,
      requestId: `bh_${ctx.taskId}_${this.counter}`,
      taskId: ctx.taskId,
      capability,
      ...(ctx.url !== undefined ? { url: ctx.url } : {}),
      args: {
        ...(action.target !== undefined ? { target: action.target } : {}),
        ...(action.value !== undefined ? { value: action.value } : {}),
        ...(action.parameters !== undefined ? { parameters: action.parameters } : {}),
        ...(action.expect !== undefined ? { expect: action.expect } : {}),
        ...(ctx.node !== undefined ? { node: { role: ctx.node.role, name: ctx.node.name } } : {}),
      },
      pageGeneration: ctx.pageGeneration,
    };

    const outcome = await this.sendOnce(request);
    if (outcome.kind === "timeout") return failed(action, ctx, "BRIDGE_TIMEOUT");
    if (outcome.kind === "error") return failed(action, ctx, "BRIDGE_UNAVAILABLE");
    const raw = outcome.value;

    const checked = validateBridgeResponse(raw, {
      requestId: request.requestId,
      protocolVersion: this.protocolVersion,
    });
    if (!checked.ok || checked.value === undefined) {
      logger.warn("bridge: malformed response rejected", {
        requestId: request.requestId,
        errors: checked.errors,
      });
      return failed(action, ctx, "BRIDGE_MALFORMED_RESPONSE");
    }
    if (!checked.value.ok) {
      return failed(action, ctx, `BRIDGE_${(checked.value.errorCode ?? "internal").toUpperCase()}`);
    }
    return {
      status: "executed",
      action: action.action,
      target: action.target,
      pageGeneration: ctx.pageGeneration,
      timestamp: Date.now(),
    };
  }

  /**
   * One bounded send. Distinguishes timeout from transport failure so the
   * controller can log honestly; both are non-retried and single-attempt.
   */
  private async sendOnce(request: BridgeRequest): Promise<
    { kind: "ok"; value: unknown } | { kind: "error" } | { kind: "timeout" }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), this.timeoutMs);
    });
    try {
      const sent = this.transport.send(request).then(
        (value) => ({ kind: "ok", value }) as const,
        () => ({ kind: "error" }) as const,
      );
      return await Promise.race([sent, timedOut]);
    } catch {
      return { kind: "error" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Convenience for tests / wiring: capability an action would use, if any. */
export function capabilityFor(action: StructuredAction): BridgeCapability | null {
  const cap = ACTION_CAPABILITY[action.action];
  return cap !== undefined && cap !== null ? cap : null;
}

/** Re-exported so callers can assert the projection stays schema-valid. */
export { bridgeCapabilityToAction };
