/**
 * Ollama client — local reasoning (ADDITIVE provider).
 * Server-side only: INVIZ talks to the user's own Ollama over loopback HTTP.
 * No model files, no GGUF handling, no Python — Ollama is the runtime.
 *
 * Live-verified request-shape constraints (Ollama 0.32.15), encoded here so the
 * reasoning contract cannot break on them:
 * 1. `think: false` is always sent. On a THINKING model (qwen3.5:9b-q4_K_M)
 *    it is REQUIRED — otherwise the whole token budget is spent in a separate
 *    `thinking` field and `content` comes back EMPTY. On a non-thinking model
 *    (the previous default, llama3.2:3b) Ollama accepts and ignores it.
 * 2. `format: <json-schema>` returns HTTP 500 on this build, so structured
 *    output uses `format: "json"` plus the shared JSON-only system prompt.
 *
 * Model-agnostic: the model tag is configuration (OLLAMA_MODEL), not code.
 * Output is untrusted exactly like any cloud provider's: it flows through the
 * same extract → validateModelOutput → WebGuard pipeline.
 */
import { OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL } from "../../../shared/constants.js";
import { GatewayError } from "./gateway.js";
import { logger } from "../../../shared/logger.js";

export interface OllamaRef {
  /** Base URL of the local Ollama server (no trailing slash). */
  url: string;
  /** Exact installed model tag, e.g. "qwen3.5:9b-q4_K_M". */
  model: string;
  /**
   * Ollama `keep_alive` duration (e.g. "10m", "1h", or a seconds number).
   * Keeps the model resident between turns so only the FIRST request pays the
   * ~25-60s cold load. Verified accepted on Ollama 0.32.15 (/api/chat honours
   * the field and reports expires_at in /api/ps). Empty = server default.
   */
  keepAlive?: string;
}

export interface OllamaCallOptions {
  ref: OllamaRef;
  body: Record<string, unknown>;
  /**
   * Bounded wall-clock budget for the whole request. Measured on this machine:
   * cold load+inference up to ~60s, warm ~1-3s. The default leaves headroom so
   * a cold start is NEVER mistaken for a dead endpoint (which would burn cloud
   * quota), while still guaranteeing the request cannot hang forever.
   */
  timeoutMs?: number;
  /**
   * Retries after the first try (default 0 = single attempt). Local inference
   * is unbounded in time, so a retry is opt-in only; cloud providers keep
   * their own bounded policy in their own clients.
   */
  maxRetries?: number;
  baseBackoffMs?: number;
  /** Voice-turn correlation id for log attribution. */
  turnId?: string;
  fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
  message?: { content?: unknown; thinking?: unknown };
  done?: boolean;
  done_reason?: unknown;
  eval_count?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Error text is safe to log: no prompt content, no page text, no keys. */
function brief(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

export interface OllamaResult {
  /** Assistant text (JSON, per the shared prompt contract). */
  content: string;
  /** Named "evalCount" (not "evalTokens"): the shared log redactor treats any
   *  key containing "token" as a secret and would mask this harmless count. */
  evalCount: number;
  durationMs: number;
}

/**
 * POST /api/chat on the local Ollama server and return the assistant content.
 *
 * - `think: false`  - always sent: required on thinking models, ignored on
 *                      non-thinking ones (see file header).
 * - `format: "json"`— structured-output mode; schema mode is broken on 0.32.15.
 * - `stream: false` — single response, so one call = one inference.
 *
 * Throws GatewayError: "network" (server down/refused), "timeout" (unavailable
 * or aborted), "auth" (unknown local state — treated as non-retryable so the
 * caller fails over instead of hammering a dead endpoint), "schema" (unparseable).
 */
export async function postChatOllama(
  opts: OllamaCallOptions,
): Promise<OllamaResult> {
  const url = normalizeUrl(opts.ref.url === "" ? OLLAMA_DEFAULT_URL : opts.ref.url);
  const model = opts.ref.model === "" ? OLLAMA_DEFAULT_MODEL : opts.ref.model;
  const timeoutMs = opts.timeoutMs ?? 180_000; // measured cold ≈60s, warm ≈1-3s
  const maxRetries = opts.maxRetries ?? 0;
  const baseBackoffMs = opts.baseBackoffMs ?? 400;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const keepAlive = opts.ref.keepAlive ?? "";

  logger.info("ollama: attempt", {
    provider: "ollama",
    model,
    ...(opts.turnId !== undefined && opts.turnId !== "" ? { turnId: opts.turnId } : {}),
    timestampMs: startedAt,
    timeoutMs,
    ...(keepAlive !== "" ? { keepAlive } : {}),
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          // Mandatory: without these two this model returns empty content.
          think: false,
          format: "json",
          // Verified field name on Ollama 0.32.15: keeps the weights resident
          // so only the first turn of a session pays the cold load.
          ...(keepAlive !== "" ? { keep_alive: keepAlive } : {}),
          messages: opts.body["messages"] ?? [],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      logger.warn("ollama: transport failure", {
        provider: "ollama",
        model,
        ...(opts.turnId !== undefined && opts.turnId !== "" ? { turnId: opts.turnId } : {}),
        timestampMs: Date.now(),
        attempt: attempt + 1,
        outcome: aborted ? "timeout" : "unavailable",
        durationMs: Date.now() - startedAt,
      });
      if (attempt < maxRetries) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(baseBackoffMs * 2 ** attempt);
        continue;
      }
      throw new GatewayError(
        aborted ? "timeout" : "network",
        aborted
          ? `Ollama timed out after ${timeoutMs}ms (model ${model})`
          : `Ollama unreachable at ${url} (${brief(err)})`,
      );
    }
    clearTimeout(timer);

    if (!res.ok) {
      // 404 here means the exact model tag is not installed locally.
      const kind: "provider" | "auth" = res.status === 404 ? "auth" : "provider";
      logger.warn("ollama: rejected", {
        provider: "ollama",
        model,
        ...(opts.turnId !== undefined && opts.turnId !== "" ? { turnId: opts.turnId } : {}),
        timestampMs: Date.now(),
        attempt: attempt + 1,
        outcome: "http-error",
        httpStatus: res.status,
        durationMs: Date.now() - startedAt,
      });
      if (attempt < maxRetries && res.status >= 500) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(baseBackoffMs * 2 ** attempt);
        continue;
      }
      throw new GatewayError(kind, `Ollama HTTP ${res.status} for model ${model}`, res.status);
    }

    let data: OllamaChatResponse;
    try {
      data = (await res.json()) as OllamaChatResponse;
    } catch {
      throw new GatewayError("schema", "Ollama response was not JSON");
    }
    const content = data.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      // Empty content is this model's known failure mode (thinking budget
      // exhaustion). Never silently accepted — the caller fails over.
      throw new GatewayError("schema", "Ollama returned empty content");
    }
    logger.info("ollama: ok", {
      provider: "ollama",
      model,
      ...(opts.turnId !== undefined && opts.turnId !== "" ? { turnId: opts.turnId } : {}),
      timestampMs: Date.now(),
      attempt: attempt + 1,
      outcome: "ok",
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
      evalCount: typeof data.eval_count === "number" ? data.eval_count : -1,
    });
    return {
      content,
      evalCount: typeof data.eval_count === "number" ? data.eval_count : 0,
      durationMs: Date.now() - startedAt,
    };
  }
  throw new GatewayError("network", "Ollama exhausted its bounded retries");
}

/**
 * Cheap reachability + model-presence probe (no inference, no tokens).
 * Used by /v1/validation so Options can prove the local provider is usable.
 */
export async function probeOllama(
  ref: OllamaRef,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; detail: string }> {
  const url = normalizeUrl(ref.url === "" ? OLLAMA_DEFAULT_URL : ref.url);
  const model = ref.model === "" ? OLLAMA_DEFAULT_MODEL : ref.model;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${url}/api/tags`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) return { ok: false, detail: `/api/tags HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const names = new Set(
      (body.models ?? [])
        .map((m) => (typeof m.name === "string" ? m.name : ""))
        .filter((n) => n !== ""),
    );
    // Ollama tags may be reported with or without the ":latest" suffix.
    const present =
      names.has(model) || [...names].some((n) => n.split(":")[0] === model.split(":")[0]);
    return present
      ? { ok: true, detail: `reachable; model ${model} installed` }
      : { ok: false, detail: `reachable but model ${model} is not installed` };
  } catch {
    return { ok: false, detail: `unreachable at ${url}` };
  }
}
