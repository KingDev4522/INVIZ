/**
 * Frontend↔backend REST contracts (INVIZ architecture split).
 * The single source of truth for the API boundary: endpoint paths, request /
 * response shapes, error codes, the user-payload builder, and shared language
 * types. Both sides import from here; neither side may invent wire shapes.
 * No secrets, no DOM, no provider specifics beyond model identifiers.
 */

export const API_PREFIX = "/v1";

export const ENDPOINTS = {
  chat: `${API_PREFIX}/chat`,
  enrich: `${API_PREFIX}/enrich`,
  transcribe: `${API_PREFIX}/transcribe`,
  tts: `${API_PREFIX}/tts`,
  search: `${API_PREFIX}/search`,
  health: `${API_PREFIX}/health`,
  validation: `${API_PREFIX}/validation`,
} as const;

export type TtsLang = "en" | "hi" | "mixed";
export type SpeechLang = "en" | "hi";

/** Backend reference held by the frontend (URL + optional bearer token). */
export interface BackendRef {
  url: string;
  token?: string;
}

/** Wire error envelope returned by every backend route on failure. */
export interface BackendErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Transport error thrown by frontend backend-clients. */
export class BackendError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

// --- POST /v1/chat ------------------------------------------------------------

/**
 * EXPERIMENTAL: a viewport screenshot for the hybrid context prototype.
 *
 * Opt-in only — a request without this field (or a backend whose CONTEXT_MODE
 * is "dom") takes the exact pre-prototype text-only path. The image never
 * carries executable intent: targets still come from the eNN registry, which
 * the model cannot see here and cannot invent into existence (WebGuard and the
 * registry check reject anything not in the current snapshot).
 */
export interface HybridScreenshot {
  /**
   * Raw base64 JPEG of the CURRENT TAB viewport — NO `data:` prefix, which is
   * precisely the Ollama `messages[].images` wire format (`api.ImageData`).
   */
  b64: string;
  /** Encoded pixel width actually sent (post-downscale). */
  width: number;
  /** Encoded pixel height actually sent (post-downscale). */
  height: number;
  /** Decoded payload size in bytes (not the base64 string length). */
  bytes: number;
  /** Original viewport dimensions before downscaling (Phase 4 measurement). */
  sourceWidth?: number;
  sourceHeight?: number;
  /**
   * Frontend Phase-8 timings in ms: capture start/end, encode start/end,
   * packaging. Log-only telemetry — never affects reasoning or validation.
   */
  timings?: Record<string, number>;
}

export interface ChatRequest {
  userPayload: string;
  systemPrompt?: string;
  effort?: "none" | "low" | "medium" | "high";
  maxCompletionTokens?: number;
  /** Voice-turn correlation id (optional, log-only; never affects reasoning). */
  turnId?: string;
  /** EXPERIMENTAL hybrid context: ignored unless the backend is CONTEXT_MODE=hybrid. */
  image?: HybridScreenshot;
}

export interface UserPayloadInput {
  intent: string;
  lang: "en" | "hi" | "mixed";
  pageText: string;
  focusText?: string;
  verifiedText?: string;
  /**
   * Compact list of skills the model may select (Phase 3). Capability
   * metadata only — never a procedure, never page content. Rendered into its
   * own provenance-labeled section so the model knows the option exists.
   */
  skills?: string;
}

/**
 * Builds the user message with provenance-labeled sections (PRD 5 §17).
 * Pure string assembly — safe on either side of the boundary.
 */
export function buildUserPayload(input: UserPayloadInput): string {
  const sections = [
    `[USER INTENT, lang=${input.lang}]\n${input.intent}`,
    `[VERIFIED PAGE STATE]\n${input.pageText}`,
  ];
  if (input.skills !== undefined && input.skills.trim() !== "") {
    sections.push(`[AVAILABLE SKILLS]\n${input.skills}`);
  }
  if (input.focusText !== undefined && input.focusText !== "") {
    sections.push(`[CURRENT FOCUS]\n${input.focusText}`);
  }
  if (input.verifiedText !== undefined && input.verifiedText !== "") {
    sections.push(`[LAST VERIFIED RESULT]\n${input.verifiedText}`);
  }
  return sections.join("\n\n");
}

// --- POST /v1/enrich ------------------------------------------------------------

export interface EnrichRequest {
  pageText: string;
  generation: number;
  lang: "en" | "hi" | "mixed";
  /** Voice-turn correlation id (optional, log-only; never affects reasoning). */
  turnId?: string;
}

export interface LayerB {
  interpretation: string;
  pageGeneration: number;
  producedAt: number;
  provenance: "MODEL_INFERENCE";
}

// --- POST /v1/transcribe ----------------------------------------------------------

export interface TranscribeRequest {
  /** Base64-encoded audio (Opus/WebM from the capture pipeline). */
  audioBase64: string;
  mimeType?: string;
  /** BCP-47 hint. Unset = auto-detect (required for Hinglish). */
  language?: string;
  model?: string;
  /** Voice-turn correlation id (optional, log-only; never affects transcription). */
  turnId?: string;
}

export interface TranscribeResponse {
  text: string;
}

// --- POST /v1/tts ------------------------------------------------------------------

export const TTS_MAX_CHARS = 4000;

export interface TtsRequest {
  /** Plain text to speak (≤4000 chars; chunk client-side). */
  text: string;
  lang: "en" | "hi";
  /** Voice-turn correlation id (optional, log-only; never affects synthesis). */
  turnId?: string;
}

export interface TtsResponse {
  /** Base64-encoded WAV audio (PCM16 mono). */
  audioBase64: string;
  mimeType: "audio/wav";
  sampleRate: number;
}

// --- POST /v1/search ------------------------------------------------------------

export interface SearchResultItem {
  title: string;
  url: string;
  /** Truncated snippet (≤300 chars server-side) for the reasoning budget. */
  snippet: string;
}

export interface SearchRequest {
  /** Web search query, 1..400 chars. */
  query: string;
  /** Max results, 1..5 (default 5). */
  maxResults?: number;
  /** Voice-turn correlation id (optional, log-only). */
  turnId?: string;
}

export interface SearchResponse {
  results: SearchResultItem[];
}

// --- GET /v1/health + POST /v1/validation ----------------------------------------------

export interface HealthResponse {
  ok: boolean;
  groqKeysConfigured: number;
  /** 0/1: whether an OpenRouter reasoning key is configured (round-robin on). */
  openrouterConfigured?: number;
  models: {
    qwen: string;
    whisper: string;
    tts: string;
  };
  timestamp: number;
}

export interface ValidationResponse {
  groq: { ok: boolean; detail: string };
  tts: { ok: boolean; detail: string };
  openrouter: { ok: boolean; detail: string };
  tavily: { ok: boolean; detail: string };
}
