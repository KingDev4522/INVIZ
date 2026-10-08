/**
 * Pinned program constants (PRD 6 §4). Magic numbers elsewhere are defects.
 * Changing any value is a design change: amend PRD 6 first.
 */

// --- Providers (PRD 6 §0, verified vendor facts) ---
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
// OpenRouter (OpenAI-compatible chat completions): second reasoning vendor.
// Reasoning (chat + enrich) round-robins OpenRouter ↔ Groq per request, with
// instant failover on 429/5xx/timeout. Audio (Whisper + TTS) stays on Groq —
// OpenRouter has no equivalent free audio endpoints.
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "google/gemma-4-26b-a4b-it:free";
// Tavily web search (agent capability). basic depth = 1 credit/search;
// snippets are capped so results fit the reasoning token budget.
export const TAVILY_BASE_URL = "https://api.tavily.com";
export const TAVILY_SEARCH_DEPTH = "basic";
export const TAVILY_MAX_RESULTS = 5;
export const TAVILY_QUERY_MAX_CHARS = 400;
export const TAVILY_SNIPPET_MAX_CHARS = 300;
export const TAVILY_REQUEST_TIMEOUT_MS = 15000;
// Ollama (local Qwen, ADDITIVE provider). Defaults match a stock local install;
// overridable via OLLAMA_URL / OLLAMA_MODEL in backend/.env.
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen3.5:9b-q4_K_M";
export const QWEN_PRIMARY_MODEL = "qwen/qwen3.8-27b";
export const QWEN_FALLBACK_MODEL = "openai/gpt-oss-20b";
export const WHISPER_PRIMARY_MODEL = "whisper-large-v3-turbo";
export const WHISPER_FALLBACK_MODEL = "whisper-large-v3";
// TTS via Groq's OpenAI-compatible /audio/speech endpoint. Same provider and
// same credential pool as reasoning and transcription — one vendor, one key
// set, one rate-limit story.
export const GROQ_SPEECH_ENDPOINT = `${GROQ_BASE_URL}/audio/speech`;

// --- Task / loop budgets (PRD 6 §4.4) ---
export const MAX_ACTIONS_PER_TASK = 25;
export const MAX_RECOVERY_ATTEMPTS_PER_ACTION = 3;
export const MAX_QWEN_CALLS_PER_TASK = 30;
/** Enrichment calls (intent classification) have their own budget so they
 *  never starve the reasoning loop's 30-call allowance. */
export const MAX_ENRICH_CALLS_PER_TASK = 5;
export const MAX_TASK_DURATION_MS = 600_000;
export const WAITING_FOR_USER_ANSWER_TTL_MS = 90_000;
export const WAITING_FOR_CONFIRMATION_TTL_MS = 90_000;

// --- Deterministic open-site navigation ---
/**
 * Frozen allowlist of unambiguous public homepages the controller may open
 * WITHOUT spending a reasoning call. "Open YouTube" / "open GitHub" must never
 * degrade into a web search or a "which URL?" clarification: these
 * destinations are fixed, public, and carry no credentials, so resolving them
 * deterministically is safe. Anything not listed here still goes through the
 * model (search first, then navigate to an observed URL).
 */
export const OPEN_SITE_ALLOWLIST: Readonly<Record<string, string>> = {
  youtube: "https://www.youtube.com/",
  github: "https://github.com/",
};

// --- Qwen call policy (PRD 6 §4.5) ---
export const QWEN_REASONING_EFFORT_INTERACTIVE = "none" as const;
export const QWEN_JSON_MODE = true;
/**
 * Output caps are sized against a measured budget, not guessed.
 *
 * Groq's free tier allows ~8000 output tokens/minute PER ACCOUNT — verified
 * live, and shared by every key on the account, so extra keys add no
 * throughput. At the previous 2000-token interactive cap a single voice turn
 * could spend a quarter of the minute's budget on reasoning that returns a
 * handful of JSON fields, which is what produced the constant
 * "too many requests". These caps fit a small validated outcome while leaving
 * room for several turns per minute.
 */
export const QWEN_MAX_COMPLETION_TOKENS_INTERACTIVE = 600;
export const QWEN_MAX_COMPLETION_TOKENS_ENRICHMENT = 400;
/** Extra room granted to the corrective re-ask after a rejected reply. */
export const QWEN_CONTRACT_RETRY_HEADROOM = 250;
/**
 * Input budget for one reasoning call.
 *
 * Tightened from 10k after measuring what real pages actually produce: a
 * GitHub repo page serialized to ~1.3k tokens and a dense settings page to
 * ~1.8k, i.e. the old cap never bound anything — the ELEMENT COUNT did. A
 * small local model (3B) also degrades sharply on long contexts: it loses the
 * instruction and starts guessing element ids. 3k is far above the real median
 * and still bounds pathological pages.
 */
export const QWEN_INPUT_TOKEN_BUDGET = 3_000;
/**
 * Element candidates sent to the model.
 *
 * Lowered from 120 for the same reason: real pages are dominated by repeated
 * controls (22 identical "Star" links, 18 "Fork", 12 avatars on one repo page)
 * that the model must read past to find the one control the user meant.
 */
export const MAX_ELEMENT_CANDIDATES = 60;
/** Heading candidates; pages can carry hundreds and only structure matters. */
export const MAX_HEADING_CANDIDATES = 20;
export const LAYER_B_FRESHNESS_TTL_MS = 90_000;

// --- Audio (PRD 6 §4.2–4.3) ---
export const MAX_CAPTURE_SECONDS = 60;
export const SILENCE_AUTO_STOP_MS = 1500;
export const MIN_EFFECTIVE_AUDIO_MS = 500;
export const TTS_MAX_BYTES_PER_REQUEST = 3900;
export const TTS_REQUEST_TIMEOUT_MS = 15000;
export const TTS_AUDIO_CACHE_MAX_BYTES = 50 * 1024 * 1024;
// Groq TTS (canopylabs/orpheus-v1-english): one English voice, addressed by
// name. Same voice for every utterance = one consistent assistant identity.
// Live-proven against Groq: only [autumn diana hannah austin daniel troy] are
// accepted ("default" is rejected with HTTP 400).
export const TTS_MODEL = "canopylabs/orpheus-v1-english";
export const TTS_VOICE = "autumn";
// Orpheus speaks English only. Devanagari is romanized before synthesis (see
// backend/src/tts/transliterate.ts) and Hindi falls back to the browser's own
// Hindi voice, so the request format is WAV in every case.
export const TTS_RESPONSE_FORMAT = "wav";
export const TTS_LANG_EN = "en-IN";
export const TTS_LANG_HI = "hi-IN";
export const EARCON_LISTENING_HZ = 660;
export const EARCON_CAPTURED_HZ = 440;
export const EARCON_ERROR_HZ = 220;

// --- Storage (PRD 6 §4.6; chrome.storage.session quota = 10,485,760 bytes) ---
export const SESSION_QUOTA_BYTES = 10_485_760;
export const PAGE_STATE_TAB_CAP_BYTES = 1 * 1024 * 1024;
export const STORAGE_KEY_TASK = "taskstate:current";
export const STORAGE_KEY_CONFIG = "config:user";
export const STORAGE_KEY_CREDENTIALS = "credentials:local";
export const STORAGE_KEY_SKILLS = "skills:registry";
export const STORAGE_KEY_EPISODES = "episodes:store";
export const pageStateKey = (tabId: number): string => `page:tab:${tabId}`;

// --- Learning layer (PRD Phase 5/6): bounded episode storage ---------------
/** Retained episodes. One task = one episode; oldest are evicted first. */
export const MAX_EPISODES = 50;
/** Serialized bound for ONE episode — refuses to write larger. */
export const MAX_EPISODE_BYTES = 32 * 1024;
/** Action records kept per episode (tasks are already bounded by 25). */
export const MAX_EPISODE_ACTIONS = 30;

// --- Verification (PRD 6 §5; PRD 4 §49) ---
export const DEFAULT_ACTION_TIMEOUT_MS = 3000;
export const MAX_ACTION_TIMEOUT_MS = 10_000;
export const TYPE_VALUE_MAX_CHARS = 2000;

// --- Keyboard commands (PRD 6 §4.1) ---
export const COMMANDS = {
  TOGGLE_VOICELENS: "toggle-voicelens",
  START_VOICE_CAPTURE: "start-voice-capture",
  STOP_CANCEL_TASK: "stop-cancel-task",
  REPEAT_LAST: "repeat-last",
} as const;
