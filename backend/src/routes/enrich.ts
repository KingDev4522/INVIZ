/**
 * POST /v1/enrich — page semantic enrichment (Layer B).
 * Activation-time and trigger-driven semantic interpretation. Advisory output
 * only (MODEL_INFERENCE provenance) — never authorization (PRD 3 §30).
 */
import { enrichPage } from "../ai/enrichment.js";
import { logger } from "../../../shared/logger.js";
import type { GroqKeyPool } from "../gateway/gateway.js";

export interface EnrichDeps {
  pool: GroqKeyPool;
  openrouter?: { apiKey: string; model: string };
  ollama?: { url: string; model: string; keepAlive?: string };
  llmProvider?: "auto" | "ollama" | "groq" | "openrouter";
  fetchImpl?: typeof fetch;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleEnrich(
  body: unknown,
  deps: EnrichDeps,
): Promise<{ status: number; payload: unknown }> {
  if (!isRecord(body) || typeof body["pageText"] !== "string" || body["pageText"].trim() === "") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "pageText must be a non-empty string" } } };
  }
  if (body["pageText"].length > 60000) {
    return { status: 400, payload: { error: { code: "PAYLOAD_TOO_LARGE", message: "pageText exceeds 60000 characters" } } };
  }
  if (typeof body["generation"] !== "number" || !Number.isInteger(body["generation"])) {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "generation must be an integer" } } };
  }
  const lang = body["lang"];
  if (lang !== "en" && lang !== "hi" && lang !== "mixed") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "lang must be en|hi|mixed" } } };
  }
  const turnId = typeof body["turnId"] === "string" ? (body["turnId"] as string) : undefined;
  try {
    const layer = await enrichPage({
      pageText: body["pageText"] as string,
      generation: body["generation"] as number,
      lang,
      pool: deps.pool,
      ...(deps.openrouter !== undefined ? { openrouter: deps.openrouter } : {}),
      ...(deps.ollama !== undefined ? { ollama: deps.ollama } : {}),
      ...(deps.llmProvider !== undefined ? { llmProvider: deps.llmProvider } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      fetchImpl: deps.fetchImpl,
    });
    return { status: 200, payload: layer };
  } catch (err) {
    // Previously silent: a swallowed failure here is indistinguishable from a
    // provider outage when counting a turn's requests. Log-only change.
    logger.warn("enrich: enrichment failed", {
      ...(turnId !== undefined ? { turnId } : {}),
      errorCode: "ENRICH_FAILED",
      reason: err instanceof Error ? err.message : "unknown",
    });
    return { status: 500, payload: { error: { code: "ENRICH_FAILED", message: "enrichment failed" } } };
  }
}
