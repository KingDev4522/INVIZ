/**
 * GET /v1/health (open) + POST /v1/validation (auth-protected).
 * Health reports capability presence only — never key material.
 * Validation runs bounded live smoke checks: the Groq models list (including
 * the TTS voice) plus one tiny synthesis. Details are sanitized.
 */
import {
  OPENROUTER_BASE_URL,
  QWEN_FALLBACK_MODEL,
  QWEN_PRIMARY_MODEL,
  TTS_MODEL,
  WHISPER_PRIMARY_MODEL,
} from "../../../shared/constants.js";
import { GroqKeyPool } from "../gateway/gateway.js";
import { probeOllama } from "../gateway/ollama.js";
import { synthesizeChunk } from "../tts/groq-tts.js";

export interface HealthDeps {
  groqKeysConfigured: number;
  tavilyConfigured?: number;
}

export async function handleHealth(deps: HealthDeps): Promise<{ status: number; payload: unknown }> {
  return {
    status: 200,
    payload: {
      ok: true,
      groqKeysConfigured: deps.groqKeysConfigured,
      tavilyConfigured: deps.tavilyConfigured ?? 0,
      models: {
        qwen: QWEN_PRIMARY_MODEL,
        whisper: WHISPER_PRIMARY_MODEL,
        tts: TTS_MODEL,
      },
      timestamp: Date.now(),
    },
  };
}

export interface ValidationDeps {
  pool: GroqKeyPool;
  fetchImpl?: typeof fetch;
  openrouterKey?: string;
  ollama?: { url: string; model: string };
  tavilyConfigured?: boolean;
}

interface GroqModels {
  data?: Array<{ id?: string }>;
}

async function checkGroq(deps: ValidationDeps): Promise<{ ok: boolean; detail: string }> {
  try {
    const key = deps.pool.next();
    if (key === null) return { ok: false, detail: "no usable Groq keys" };
    const res = await (deps.fetchImpl ?? fetch)("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, detail: `models list HTTP ${res.status}` };
    const body = (await res.json()) as GroqModels;
    const ids = new Set((body.data ?? []).map((m) => m.id));
    const missing = [QWEN_PRIMARY_MODEL, QWEN_FALLBACK_MODEL, WHISPER_PRIMARY_MODEL, TTS_MODEL].filter(
      (id) => !ids.has(id),
    );
    if (missing.length > 0) return { ok: false, detail: `missing model access: ${missing.join(", ")}` };
    return { ok: true, detail: "models list + required IDs present" };
  } catch {
    return { ok: false, detail: "network error reaching Groq" };
  }
}

async function checkTts(deps: ValidationDeps): Promise<{ ok: boolean; detail: string }> {
  try {
    const blob = await synthesizeChunk("ok.", "en", { pool: deps.pool }, {
      timeoutMs: 15000,
      fetchImpl: deps.fetchImpl,
    });
    if (blob.size === 0) return { ok: false, detail: "empty audio returned" };
    return { ok: true, detail: `live synthesis returned ${blob.size} bytes` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { ok: false, detail: message.slice(0, 160) };
  }
}

/**
 * Cheap OpenRouter key check: one key-authenticated models ping, no
 * generation spend. Absent key = Groq-only reasoning (healthy, not a failure).
 */
async function checkOpenRouter(deps: ValidationDeps): Promise<{ ok: boolean; detail: string }> {
  if (deps.openrouterKey === undefined || deps.openrouterKey === "") {
    return { ok: true, detail: "not configured — Groq-only reasoning" };
  }
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${OPENROUTER_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${deps.openrouterKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: "OpenRouter key rejected (HTTP 401/403)" };
    }
    if (!res.ok) return { ok: false, detail: `models list HTTP ${res.status}` };
    return { ok: true, detail: "key accepted" };
  } catch {
    return { ok: false, detail: "network error reaching OpenRouter" };
  }
}

/**
 * Tavily presence check (no live call: validation must not spend search
 * credits). Absent key is a hard failure — search is a core capability.
 */
function checkTavily(deps: ValidationDeps): { ok: boolean; detail: string } {
  if (deps.tavilyConfigured === true) return { ok: true, detail: "key configured" };
  return { ok: false, detail: "TAVILY_API_KEY missing on the server" };
}

/**
 * Local provider check: reachability + exact model presence, NO inference (no
 * tokens, fast). Unconfigured = not applicable (cloud reasoning still works),
 * so it never reports a failure for someone who does not use Ollama.
 */
async function checkOllama(deps: ValidationDeps): Promise<{ ok: boolean; detail: string }> {
  if (deps.ollama === undefined) {
    return { ok: true, detail: "not configured — cloud reasoning only" };
  }
  return probeOllama(deps.ollama, { fetchImpl: deps.fetchImpl });
}

export async function handleValidation(
  deps: ValidationDeps,
): Promise<{ status: number; payload: unknown }> {
  const [groq, tts, openrouter, ollama] = await Promise.all([
    checkGroq(deps),
    checkTts(deps),
    checkOpenRouter(deps),
    checkOllama(deps),
  ]);
  return { status: 200, payload: { groq, tts, openrouter, ollama, tavily: checkTavily(deps) } };
}
