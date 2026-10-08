/**
 * Page enrichment pipeline (PRD 6.4 §1.4; PRD 3 §12, §30).
 * Activation-time Layer B build runs async and NEVER blocks the fast path;
 * re-analysis happens only on meaningful triggers; stale/empty Layer B is
 * excluded from reasoning input. Layer B is MODEL_INFERENCE — advisory only,
 * never authorization (enforced in Phase 5/6; the shape is correct from birth).
 */
import type { GroqKeyPool } from "../gateway/gateway.js";
import { reasonOnce } from "./qwen-client.js";
import { SYSTEM_PROMPT_V1 } from "./schemas.js";
import { buildUserPayload } from "../../../shared/api.js";
import { QWEN_MAX_COMPLETION_TOKENS_ENRICHMENT } from "../../../shared/constants.js";
import type { LayerB } from "../../../shared/api.js";

export interface EnrichmentInput {
  pageText: string;
  generation: number;
  lang: "en" | "hi" | "mixed";
  pool: GroqKeyPool;
  openrouter?: { apiKey: string; model: string };
  ollama?: { url: string; model: string };
  llmProvider?: "auto" | "ollama" | "groq" | "openrouter";
  fetchImpl?: typeof fetch;
}

/** Async enrichment: page summary + purpose + key actions, bounded output. */
export async function enrichPage(input: EnrichmentInput): Promise<LayerB> {
  const outcome = await reasonOnce({
    ...(input.openrouter !== undefined ? { openrouter: input.openrouter } : {}),
    ...(input.ollama !== undefined ? { ollama: input.ollama } : {}),
    ...(input.llmProvider !== undefined ? { llmProvider: input.llmProvider } : {}),
    systemPrompt: SYSTEM_PROMPT_V1,
    userPayload: buildUserPayload({
      intent:
        "Summarize this page for an accessibility assistant: its purpose, its important sections, and the important actions a user can take. " +
        "Ground every claim in the provided state. " +
        `Respond in this language: ${input.lang}.`,
      lang: input.lang,
      pageText: input.pageText,
    }),
    effort: "none",
    maxCompletionTokens: QWEN_MAX_COMPLETION_TOKENS_ENRICHMENT,
    pool: input.pool,
    fetchImpl: input.fetchImpl,
  });
  if (outcome.type !== "answer" || outcome.text === undefined) {
    throw new Error("enrichment must resolve to an answer outcome");
  }
  return {
    interpretation: outcome.text,
    pageGeneration: input.generation,
    producedAt: Date.now(),
    provenance: "MODEL_INFERENCE",
  };
}
