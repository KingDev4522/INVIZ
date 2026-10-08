/**
 * MCP-style typed interface — REAL (Phase 7, OPTIONAL).
 *
 * Exposes SAFE typed capabilities, never raw browser control. Every request is
 * schema-validated, size-bounded and mapped to a KNOWN tool that itself maps
 * onto existing INVIZ types and the existing policy path. Unknown tools,
 * unknown arguments, oversized input and malformed payloads all fail closed.
 *
 * Explicitly NOT exposed: raw CDP, execute_javascript, shell, filesystem,
 * credentials, arbitrary network requests, and any mutation of WebGuard,
 * Verification or trust policy.
 */
import { MAX_MCP_REQUEST_BYTES } from "./execution.js";

export const MCP_PROTOCOL_VERSION = 1;
export const MCP_REQUEST_ID_MAX = 64;
/** Top-level MCP request keys. Anything else is rejected. */
const MCP_REQUEST_FIELDS = ["protocolVersion", "requestId", "tool", "args"] as const;
/** Per-tool allowed argument keys. Anything else is rejected. */
export const MCP_TOOL_ARGS: Readonly<Record<McpTool, readonly string[]>> = {
  get_page_state: ["tabId"],
  get_task_state: [],
  read_region: ["tabId", "regionId", "maxChars"],
  find_element: ["tabId", "name", "role"],
  execute_allowed_action: ["action"],
  verify_result: ["tabId", "expect"],
  get_skill_metadata: ["skillId"],
};
export const MCP_STRING_ARG_MAX_CHARS = 500;

export const MCP_TOOLS = [
  "get_page_state",
  "get_task_state",
  "read_region",
  "find_element",
  "execute_allowed_action",
  "verify_result",
  "get_skill_metadata",
] as const;

export type McpTool = (typeof MCP_TOOLS)[number];

export type McpErrorCode =
  | "unsupported_protocol"
  | "unknown_tool"
  | "unknown_argument"
  | "invalid_arguments"
  | "oversized"
  | "malformed"
  | "not_authorized"
  | "unavailable"
  | "policy_rejected"
  | "verification_failed"
  | "internal";

export interface McpRequest {
  protocolVersion: number;
  requestId: string;
  tool: McpTool;
  args: Record<string, unknown>;
}

export interface McpResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  result?: unknown;
  errorCode?: McpErrorCode;
  detail?: string;
}

export interface McpValidation {
  ok: boolean;
  request?: McpRequest;
  errorCode?: McpErrorCode;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isMcpTool(value: unknown): value is McpTool {
  return typeof value === "string" && (MCP_TOOLS as readonly string[]).includes(value);
}

/**
 * Fail-closed request validation. Rejects malformed payloads, wrong protocol
 * versions, unknown tools, unknown argument keys, oversized requests, and
 * string arguments above the bound.
 */
export function validateMcpRequest(
  raw: unknown,
  opts: { protocolVersion: number; maxBytes?: number },
): McpValidation {
  if (!isRecord(raw)) {
    return { ok: false, errorCode: "malformed", errors: ["request must be an object"] };
  }
  if (raw["protocolVersion"] !== opts.protocolVersion) {
    return {
      ok: false,
      errorCode: "unsupported_protocol",
      errors: [`unsupported protocol version ${String(raw["protocolVersion"])}`],
    };
  }
  const maxBytes = opts.maxBytes ?? MAX_MCP_REQUEST_BYTES;
  if (JSON.stringify(raw).length > maxBytes) {
    return { ok: false, errorCode: "oversized", errors: ["request exceeds size bound"] };
  }
  for (const key of Object.keys(raw)) {
    if (!(MCP_REQUEST_FIELDS as readonly string[]).includes(key)) {
      return {
        ok: false,
        errorCode: "malformed",
        errors: [`unexpected field: ${key}`],
      };
    }
  }

  const requestId = raw["requestId"];
  if (
    typeof requestId !== "string" ||
    requestId.trim() === "" ||
    requestId.length > MCP_REQUEST_ID_MAX
  ) {
    return {
      ok: false,
      errorCode: "invalid_arguments",
      errors: ["requestId: required bounded non-empty string"],
    };
  }

  const tool = raw["tool"];
  if (!isMcpTool(tool)) {
    return { ok: false, errorCode: "unknown_tool", errors: [`unknown tool ${String(tool)}`] };
  }

  const args = raw["args"] ?? {};
  if (!isRecord(args)) {
    return { ok: false, errorCode: "invalid_arguments", errors: ["args: must be an object"] };
  }

  const allowed = MCP_TOOL_ARGS[tool];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        errorCode: "unknown_argument",
        errors: [`tool ${tool} does not accept "${key}"`],
      };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > MCP_STRING_ARG_MAX_CHARS) {
      return {
        ok: false,
        errorCode: "oversized",
        errors: [`arg ${key} exceeds ${MCP_STRING_ARG_MAX_CHARS} characters`],
      };
    }
    if (
      value !== null &&
      typeof value === "object" &&
      JSON.stringify(value).length > maxBytes
    ) {
      return { ok: false, errorCode: "oversized", errors: [`arg ${key} is too large`] };
    }
  }

  return {
    ok: true,
    request: {
      protocolVersion: opts.protocolVersion,
      requestId,
      tool,
      args,
    },
    errors: [],
  };
}

/** Builds a well-formed failure response. */
export function mcpError(
  requestId: string,
  errorCode: McpErrorCode,
  detail: string,
): McpResponse {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    requestId,
    ok: false,
    errorCode,
    detail: detail.slice(0, 500),
  };
}
