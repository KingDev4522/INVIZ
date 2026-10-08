/**
 * Opt-in backend diagnostic trace (INVIZ_AI_TRACE=true; default OFF).
 *
 * Prints the AI pipeline stages to the backend terminal so a failed turn can
 * be attributed to exactly one stage: context assembly -> model reasoning
 * (incl. provider fallback) -> schema validation -> outcome.
 *
 * SECURITY (non-negotiable):
 * - Allowlisted fields only. Anything not explicitly passed here is never
 *   printed — there is no generic object dump anywhere in this file.
 * - NEVER: API keys, auth headers, cookies, passwords, tokens, credentials,
 *   raw secrets. The trace call sites do not receive them, so they cannot leak.
 * - Images: metadata ONLY (present/width/height/bytes). Base64 is never
 *   accepted by these functions (no b64 parameter exists).
 * - Action `value` (typed text — may be user-dictated secrets) is redacted.
 * - Long text is truncated (see caps below).
 *
 * WebGuard / executor / verification run in the EXTENSION, not this process:
 * they are observable via the existing frontend logs, correlated by turnId.
 * This trace covers the backend-owned stages and the provider transitions.
 */

const MAX_INTENT_CHARS = 300;
const MAX_REGISTRY_LINES = 40;
const MAX_TEXT_CHARS = 300;

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…[truncated ${clean.length - max} chars]` : clean;
}

/** Registry lines only (eNN/rNN entries), capped — never the full payload. */
function registryExcerpt(pageText: string): string[] {
  const lines: string[] = [];
  for (const line of pageText.split("\n")) {
    const t = line.trim();
    if (/^[er]\d+\s/.test(t)) {
      lines.push(t.slice(0, 160));
      if (lines.length >= MAX_REGISTRY_LINES) {
        lines.push(`…[+more registry lines capped at ${MAX_REGISTRY_LINES}]`);
        break;
      }
    }
  }
  return lines;
}

export function aiTraceEnabled(): boolean {
  return process.env["INVIZ_AI_TRACE"] === "true";
}

function emit(block: string): void {
  if (!aiTraceEnabled()) return;
  // Direct console output (not the JSON logger): this is a human debugging
  // facility for the local terminal, and every field reaching here is already
  // allowlisted + truncated by the helpers above.
  console.log(block);
}

export interface TraceRequest {
  turnId?: string;
  provider: string;
  model: string;
  contextMode: string;
  /** Full user payload; intent/registry are split out here (never printed whole). */
  userPayload: string;
  imageMeta?: { width: number; height: number; bytes: number };
}

export function traceRequestSeen(r: TraceRequest): void {
  const splitAt = r.userPayload.indexOf("[VERIFIED PAGE STATE]");
  const intent = splitAt >= 0 ? r.userPayload.slice(0, splitAt) : r.userPayload;
  const pageText = splitAt >= 0 ? r.userPayload.slice(splitAt) : "";
  const registry = registryExcerpt(pageText);
  emit(
    [
      "[INVIZ AI TRACE] request received",
      `turn=${r.turnId ?? "none"} provider=${r.provider} model=${r.model} contextMode=${r.contextMode}`,
      `payloadChars=${r.userPayload.length} registryLines=${registry.length}`,
      `image=${r.imageMeta !== undefined ? `true width=${r.imageMeta.width} height=${r.imageMeta.height} bytes=${r.imageMeta.bytes}` : "false"}`,
      "[CONTEXTLENS -> AI]",
      `intent: ${truncate(intent, MAX_INTENT_CHARS)}`,
      `relevant target registry (${registry.length} lines):`,
      ...registry.map((l) => `  ${l}`),
    ].join("\n"),
  );
}

/** Sanitized model outcome: structure without typed values. */
export function sanitizeOutcome(outcome: unknown): Record<string, unknown> {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    return { unshaped: true };
  }
  const o = outcome as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof o["type"] === "string") out["type"] = o["type"];
  if (typeof o["text"] === "string") out["text"] = truncate(o["text"], MAX_TEXT_CHARS);
  if (typeof o["question"] === "string") out["question"] = truncate(o["question"], MAX_TEXT_CHARS);
  if (typeof o["reason"] === "string") out["reason"] = truncate(o["reason"], MAX_TEXT_CHARS);
  if (typeof o["summary"] === "string") out["summary"] = truncate(o["summary"], MAX_TEXT_CHARS);
  const action = o["action"];
  if (typeof action === "object" && action !== null && !Array.isArray(action)) {
    const a = action as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const key of ["action", "target", "pageGeneration", "parameters", "expect", "timeout_ms"]) {
      if (a[key] !== undefined) clean[key] = a[key];
    }
    // `value` (typed text) is deliberately NEVER printed.
    if ("value" in a) clean["value"] = "<redacted>";
    out["action"] = clean;
  }
  if (typeof o["skill_id"] === "string") out["skill_id"] = o["skill_id"];
  return out;
}

export function traceOutcome(turnId: string | undefined, outcome: unknown, reasks: number): void {
  emit(
    [
      "[INVIZ AI TRACE] [AI -> INVIZ]",
      `turn=${turnId ?? "none"} reasks=${reasks}`,
      `sanitized structured model response: ${JSON.stringify(sanitizeOutcome(outcome))}`,
      "[WEBCGUARD] runs in the extension (see frontend logs for decision=ALLOW/REQUIRE_CONFIRMATION/BLOCK)",
      "[EXECUTOR] runs in the extension (see frontend logs for action/target/result)",
      "[VERIFICATION] runs in the extension (see frontend logs for PASS/FAIL/INCONCLUSIVE)",
    ].join("\n"),
  );
}

export function traceProviderAttempt(
  turnId: string | undefined,
  provider: string,
  model: string,
): void {
  emit(`[INVIZ AI TRACE] provider attempt turn=${turnId ?? "none"} provider=${provider} model=${model}`);
}

export function traceFallback(
  turnId: string | undefined,
  fromProvider: string,
  toProvider: string,
  reason: string,
): void {
  // `reason` is a stable classification token (e.g. OLLAMA_UNAVAILABLE), never
  // provider output — safe to print verbatim.
  emit(
    `[INVIZ AI TRACE] provider transition turn=${turnId ?? "none"} ${fromProvider} -> ${toProvider} fallbackReason=${reason}`,
  );
}

export function traceContractRetry(turnId: string | undefined, attempt: number): void {
  emit(`[INVIZ AI TRACE] output-contract re-ask turn=${turnId ?? "none"} attempt=${attempt + 1}`);
}

export function traceFailure(turnId: string | undefined, stage: string, detail: string): void {
  // `detail` must be a short classification, never raw provider text.
  emit(`[INVIZ AI TRACE] FAILURE stage=${stage} turn=${turnId ?? "none"} detail=${truncate(detail, 200)}`);
}
