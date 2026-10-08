/**
 * Page Q&A + element-find flows (PRD 6.4 §1.6; PRD 2 §8–9).
 * Thin orchestration over reason(): constrained prompts, then honest mapping.
 * Element IDs are verified against the live candidate set here — an ID the
 * registry did not provide can never leave this module (defense in depth with
 * Phase 5 WebGuard, which re-checks independently).
 */
import { reasonOnce } from "./qwen-client.js";
import { buildUserPayload } from "../../../shared/api.js";
import { SYSTEM_PROMPT_V2 } from "./schemas.js";
import type { GroqKeyPool } from "../gateway/gateway.js";

export interface QaDeps {
  pool: GroqKeyPool;
  fetchImpl?: typeof fetch;
  reason?: typeof reasonOnce;
}

export interface QuestionInput {
  question: string;
  lang: "en" | "hi" | "mixed";
  pageText: string;
}

export async function answerQuestion(
  input: QuestionInput,
  deps: QaDeps,
): Promise<string> {
  const reason = deps.reason ?? reasonOnce;
  const outcome = await reason({
    systemPrompt: SYSTEM_PROMPT_V2,
    userPayload: buildUserPayload({
      intent: `User question about the current page: ${input.question}`,
      lang: input.lang,
      pageText: input.pageText,
    }),
    effort: "none",
    pool: deps.pool,
    fetchImpl: deps.fetchImpl,
  });
  if (outcome.type !== "answer" || outcome.text === undefined || outcome.text.trim() === "") {
    throw new Error("question answering must resolve to a non-empty answer");
  }
  return outcome.text;
}

export interface ElementCandidate {
  id: string;
  role: string;
  name: string;
}

export interface FindInput {
  query: string;
  lang: "en" | "hi" | "mixed";
  pageText: string;
  candidates: ElementCandidate[];
}

/**
 * Returns the registry ID of the matching element, or null when the model
 * cannot ground the request. Invented IDs are rejected here (returned null),
 * not passed on.
 */
export async function findElement(
  input: FindInput,
  deps: QaDeps,
): Promise<string | null> {
  if (input.candidates.length === 0) return null;
  const reason = deps.reason ?? reasonOnce;
  const candidateList = input.candidates
    .map((c) => `${c.id} ${c.role} "${c.name}"`)
    .join("\n");
  const outcome = await reason({
    systemPrompt: SYSTEM_PROMPT_V2,
    userPayload: buildUserPayload({
      intent:
        `User wants to locate: ${input.query}. Reply with type "answer" whose text ` +
        `is ONLY the element ID (e.g. e37) from the candidate list below that best ` +
        `matches, or the exact text NO_MATCH if nothing matches confidently.`,
      lang: input.lang,
      pageText: `${input.pageText}\nCANDIDATES:\n${candidateList}`,
    }),
    effort: "none",
    pool: deps.pool,
    fetchImpl: deps.fetchImpl,
  });
  if (outcome.type !== "answer" || outcome.text === undefined) return null;
  const id = outcome.text.trim();
  if (id === "NO_MATCH" || id === "") return null; // honesty path (PRD 2 §20)
  return input.candidates.some((c) => c.id === id) ? id : null;
}
