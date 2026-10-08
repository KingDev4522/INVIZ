/**
 * Browser Harness bridge protocol — REAL (Phase 7).
 *
 * A VERSIONED, TYPED capability protocol. The bridge lives entirely OUTSIDE the
 * MV3 trusted core: nothing here opens a socket, talks CDP, or evaluates
 * JavaScript. Requests/responses are plain validated data.
 *
 * Capabilities are derived from the EXISTING ActionType semantics — the bridge
 * cannot express anything INVIZ could not already express. Every action-shaped
 * capability converts to a StructuredAction and is re-validated with the SAME
 * closed schema WebGuard enforces. Anything else fails closed.
 */
import {
  MAX_BRIDGE_ITEMS,
  MAX_BRIDGE_MESSAGE_BYTES,
  MAX_BRIDGE_TEXT_CHARS,
} from "./execution.js";
import { validateStructuredAction } from "./types.js";
import type { ActionType, SkillStatus, StructuredAction } from "./types.js";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_REQUEST_ID_MAX = 64;
export const BRIDGE_TASK_ID_MAX = 128;

/**
 * The ONLY capabilities the external bridge may be asked for.
 * Everything that corresponds to an interaction maps onto an existing
 * ActionType; the rest are read-only observations.
 */
export const BRIDGE_CAPABILITIES = [
  "get_page_state",
  "find_element",
  "read_region",
  "click",
  "type",
  "focus",
  "select",
  "scroll",
  "press_key",
  "navigate",
  "go_back",
  "go_forward",
  "wait_for",
  "observe",
] as const;

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

/**
 * Capability → existing ActionType. Observation capabilities return null: they
 * never mutate the page, so they carry no StructuredAction at all.
 */
const CAPABILITY_ACTION: Readonly<Partial<Record<BridgeCapability, ActionType>>> = {
  click: "click",
  type: "type",
  focus: "focus",
  select: "select",
  scroll: "scroll",
  press_key: "press_key",
  navigate: "navigate",
  go_back: "go_back",
  go_forward: "go_forward",
  read_region: "read",
  // The built-in generic_find_element skill resolves to `focus` — same meaning.
  find_element: "focus",
};

export function isBridgeCapability(value: unknown): value is BridgeCapability {
  return (
    typeof value === "string" &&
    (BRIDGE_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Skill provenance carried with a request (planning snapshot, not authority). */
export interface BridgeSkillRef {
  skillId: string;
  skillVersion: string;
  skillStatus?: SkillStatus;
}

export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  taskId: string;
  capability: BridgeCapability;
  args: Record<string, unknown>;
  /** PageState generation the request was derived from. */
  pageGeneration?: number;
  skillRef?: BridgeSkillRef;
}

export type BridgeErrorCategory =
  | "unsupported_protocol"
  | "unknown_capability"
  | "invalid_args"
  | "stale_generation"
  | "unauthorized_task"
  | "oversized"
  | "malformed"
  | "unavailable"
  | "timeout"
  | "internal";

export interface BridgeObservation {
  kind: "page_state" | "element" | "region" | "result" | "waited" | "observed";
  pageGeneration?: number;
  text?: string;
  items?: Array<{ id: string; role: string; name: string }>;
  url?: string;
}

export interface BridgeResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  observation?: BridgeObservation;
  errorCode?: BridgeErrorCategory;
  detail?: string;
}

export interface BridgeValidation<T> {
  ok: boolean;
  value?: T;
  errorCode?: BridgeErrorCategory;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Projects a bridge capability + args onto the existing StructuredAction
 * vocabulary. Returns null when the capability is observational or the args
 * cannot form a valid action.
 */
export function bridgeCapabilityToAction(
  capability: BridgeCapability,
  args: Record<string, unknown>,
  pageGeneration?: number,
): StructuredAction | null {
  const actionType = CAPABILITY_ACTION[capability];
  if (actionType === undefined) return null; // observation-only capability
  const action: Record<string, unknown> = { action: actionType };
  if (typeof args["target"] === "string") action["target"] = args["target"];
  if (typeof args["value"] === "string") action["value"] = args["value"];
  if (isRecord(args["parameters"])) action["parameters"] = args["parameters"];
  if (isRecord(args["expect"])) action["expect"] = args["expect"];
  if (pageGeneration !== undefined) action["pageGeneration"] = pageGeneration;
  return action as unknown as StructuredAction;
}

export interface BridgeRequestContext {
  /** Exact protocol version this deployment speaks. */
  protocolVersion: number;
  /** Task ids currently authorized to use the bridge. Empty = none authorized. */
  authorizedTaskIds: ReadonlySet<string>;
  /** Current PageState generation, used to reject stale requests. */
  currentGeneration?: number;
}

/**
 * Fail-closed request validation. Rejects malformed payloads, unknown protocol
 * versions, unknown capabilities, oversized messages, unauthorized task ids,
 * stale generations, and any action-shaped capability whose args do not satisfy
 * the closed StructuredAction schema.
 */
export function validateBridgeRequest(
  raw: unknown,
  ctx: BridgeRequestContext,
): BridgeValidation<BridgeRequest> {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errorCode: "malformed", errors: ["request must be an object"] };
  }
  if (raw["protocolVersion"] !== ctx.protocolVersion) {
    return {
      ok: false,
      errorCode: "unsupported_protocol",
      errors: [`unsupported protocol version ${String(raw["protocolVersion"])}`],
    };
  }
  if (JSON.stringify(raw).length > MAX_BRIDGE_MESSAGE_BYTES) {
    return { ok: false, errorCode: "oversized", errors: ["request exceeds size bound"] };
  }

  const requestId = typeof raw["requestId"] === "string" ? raw["requestId"] : "";
  if (requestId === "" || requestId.length > BRIDGE_REQUEST_ID_MAX) {
    errors.push("requestId: required, bounded non-empty string");
  }
  const taskId = typeof raw["taskId"] === "string" ? raw["taskId"] : "";
  if (taskId === "" || taskId.length > BRIDGE_TASK_ID_MAX) {
    errors.push("taskId: required bounded string");
  } else if (!ctx.authorizedTaskIds.has(taskId)) {
    return {
      ok: false,
      errorCode: "unauthorized_task",
      errors: [`task ${taskId} is not authorized for external execution`],
    };
  }

  const capability = raw["capability"];
  if (!isBridgeCapability(capability)) {
    return {
      ok: false,
      errorCode: "unknown_capability",
      errors: [`unknown capability ${String(capability)}`],
    };
  }

  const args = raw["args"];
  if (args !== undefined && !isRecord(args)) {
    errors.push("args: must be an object");
  }

  // Fail closed on unknown argument keys: an unrecognised key must be
  // rejected, never silently dropped (dropping it would mask a smuggled
  // field that a downstream consumer might interpret differently).
  const ALLOWED_ARGS = ["target", "value", "parameters", "expect"] as const;
  if (isRecord(args)) {
    for (const key of Object.keys(args)) {
      if (!(ALLOWED_ARGS as readonly string[]).includes(key)) {
        errors.push(`args: unknown argument "${key}"`);
      }
    }
  }

  let pageGeneration: number | undefined;
  if (raw["pageGeneration"] !== undefined) {
    const gen = raw["pageGeneration"];
    if (!Number.isInteger(gen) || (gen as number) < 0) {
      errors.push("pageGeneration: must be a non-negative integer");
    } else {
      pageGeneration = gen as number;
      if (
        ctx.currentGeneration !== undefined &&
        pageGeneration !== ctx.currentGeneration
      ) {
        return {
          ok: false,
          errorCode: "stale_generation",
          errors: [
            `stale generation ${pageGeneration} (current ${ctx.currentGeneration})`,
          ],
        };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errorCode: "invalid_args", errors };

  const record: BridgeRequest = {
    protocolVersion: ctx.protocolVersion,
    requestId,
    taskId,
    capability,
    args: (args as Record<string, unknown> | undefined) ?? {},
    ...(pageGeneration !== undefined ? { pageGeneration } : {}),
    ...(isRecord(raw["skillRef"]) && typeof raw["skillRef"]["skillId"] === "string"
      ? {
          skillRef: {
            skillId: raw["skillRef"]["skillId"],
            skillVersion: String(raw["skillRef"]["skillVersion"] ?? ""),
            ...(typeof raw["skillRef"]["skillStatus"] === "string"
              ? { skillStatus: raw["skillRef"]["skillStatus"] as SkillStatus }
              : {}),
          },
        }
      : {}),
  };

  // Action-shaped capabilities must still satisfy the closed schema. This is
  // the same validator WebGuard uses, so a smuggled field or an unknown verb
  // cannot cross the bridge.
  const asAction = bridgeCapabilityToAction(capability, record.args, pageGeneration);
  if (asAction !== null) {
    const checked = validateStructuredAction(asAction);
    if (!checked.ok) {
      return {
        ok: false,
        errorCode: "invalid_args",
        errors: checked.errors.map((e) => `${capability}: ${e}`),
      };
    }
  }

  return { ok: true, value: record, errors: [] };
}

/** Fail-closed response validation: a malformed bridge reply is never trusted. */
export function validateBridgeResponse(
  raw: unknown,
  expect: { requestId: string; protocolVersion: number },
): BridgeValidation<BridgeResponse> {
  if (!isRecord(raw)) {
    return { ok: false, errorCode: "malformed", errors: ["response must be an object"] };
  }
  if (raw["protocolVersion"] !== expect.protocolVersion) {
    return { ok: false, errorCode: "unsupported_protocol", errors: ["version mismatch"] };
  }
  if (raw["requestId"] !== expect.requestId) {
    return { ok: false, errorCode: "malformed", errors: ["requestId mismatch"] };
  }
  if (typeof raw["ok"] !== "boolean") {
    return { ok: false, errorCode: "malformed", errors: ["ok must be boolean"] };
  }
  if (raw["ok"] === false) {
    const code = raw["errorCode"];
    return {
      ok: true,
      value: {
        protocolVersion: expect.protocolVersion,
        requestId: expect.requestId,
        ok: false,
        errorCode:
          typeof code === "string" &&
          ([
            "unsupported_protocol",
            "unknown_capability",
            "invalid_args",
            "stale_generation",
            "unauthorized_task",
            "oversized",
            "malformed",
            "unavailable",
            "timeout",
            "internal",
          ] as const).includes(code as never)
            ? (code as BridgeErrorCategory)
            : "internal",
        ...(typeof raw["detail"] === "string"
          ? { detail: raw["detail"].slice(0, 500) }
          : {}),
      },
      errors: [],
    };
  }

  const observation = raw["observation"];
  if (!isRecord(observation)) {
    return { ok: false, errorCode: "malformed", errors: ["ok response needs an observation"] };
  }
  const kind = observation["kind"];
  if (
    typeof kind !== "string" ||
    !["page_state", "element", "region", "result", "waited", "observed"].includes(kind)
  ) {
    return { ok: false, errorCode: "malformed", errors: ["invalid observation kind"] };
  }

  const safe: BridgeObservation = { kind: kind as BridgeObservation["kind"] };
  if (typeof observation["pageGeneration"] === "number") {
    safe.pageGeneration = observation["pageGeneration"];
  }
  if (typeof observation["url"] === "string") safe.url = observation["url"].slice(0, 2048);
  if (typeof observation["text"] === "string") {
    safe.text = observation["text"].slice(0, MAX_BRIDGE_TEXT_CHARS);
  }
  if (Array.isArray(observation["items"])) {
    safe.items = observation["items"]
      .slice(0, MAX_BRIDGE_ITEMS)
      .map((item) =>
        isRecord(item)
          ? {
              id: String(item["id"] ?? ""),
              role: String(item["role"] ?? ""),
              name: String(item["name"] ?? "").slice(0, 200),
            }
          : { id: "", role: "", name: "" },
      );
  }

  return {
    ok: true,
    value: {
      protocolVersion: expect.protocolVersion,
      requestId: expect.requestId,
      ok: true,
      observation: safe,
    },
    errors: [],
  };
}
