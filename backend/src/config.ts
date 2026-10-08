/**
 * Backend configuration: environment only, never files, never the frontend.
 * Values are read from process.env (optionally via a local .env file loaded
 * by loadDotEnv below). Missing/invalid config throws with actionable
 * messages that contain NO secret values — only counts and names.
 */
import fs from "node:fs";
import path from "node:path";
import { OPENROUTER_DEFAULT_MODEL, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL, parseContextMode, type ContextMode } from "../../shared/constants.js";

/**
 * Which reasoning provider leads the rotation.
 * - "auto" (default): rotate every configured provider, Ollama first when present.
 * - a provider name: pin it as primary; the rest remain bounded standbys.
 */
export type LlmProvider = "auto" | "ollama" | "groq" | "openrouter";

const LLM_PROVIDERS: ReadonlySet<string> = new Set(["auto", "ollama", "groq", "openrouter"]);

/**
 * EXPERIMENTAL context mode (see shared/constants.ts for the full contract).
 * Re-exported here so backend consumers have one obvious import site.
 *
 * - "dom" (DEFAULT): exactly the existing DOM/ARIA context path. No image is
 *   ever forwarded to a model, even if a client sends one.
 * - "hybrid": opt-in. A client-supplied viewport screenshot is forwarded as
 *   Ollama multimodal input alongside a compact target registry.
 *
 * Fail-open to "dom" (same pattern as LLM_PROVIDER): a typo must never break
 * the running backend, and the safe default is the production one.
 */
export type { ContextMode } from "../../shared/constants.js";

export interface BackendConfig {
  /** Shared by reasoning, transcription and speech. 1..N. */
  groqKeys: string[];
  /**
   * Second reasoning vendor (chat + enrichment only). Empty = Groq-only
   * reasoning. Audio (Whisper + TTS) always stays on Groq.
   */
  openrouterKey: string;
  /** OpenRouter chat-completions model for reasoning. */
  openrouterModel: string;
  /**
   * LOCAL reasoning provider (additive; optional). When configured it is
   * preferred, and Groq remains a bounded standby. Empty = never used.
   */
  ollamaUrl: string;
  ollamaModel: string;
  /** Ollama keep_alive (e.g. "10m"). Keeps weights resident between turns. */
  ollamaKeepAlive: string;
  /** Bounded wall-clock budget for one local inference (ms). */
  ollamaTimeoutMs: number;
  /** Primary provider selector (see LlmProvider). */
  llmProvider: LlmProvider;
  /** EXPERIMENTAL: "dom" (default) or "hybrid" vision prototype. */
  contextMode: ContextMode;
  /** Web search for the agent (Tavily). Required: search is a core capability. */
  tavilyKey: string;
  port: number;
  /** Optional shared secret for frontend→backend auth. Empty = loopback dev only. */
  backendToken: string;
}

/** Minimal .env loader (KEY=value, # comments, single/double-quote stripping). */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const file = path.join(cwd, ".env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env: pure environment is fine
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function splitKeys(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
}

/** Loads + validates config. Throws on missing credentials (message is safe to log). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const groqKeys = splitKeys(env["GROQ_API_KEYS"]);
  const portRaw = (env["PORT"] ?? "8787").trim();
  const port = Number(portRaw);
  const problems: string[] = [];
  if (groqKeys.length === 0) {
    problems.push("GROQ_API_KEYS is empty (comma-separated, at least one)");
  }
  if ((env["TAVILY_API_KEY"] ?? "").trim() === "") {
    problems.push("TAVILY_API_KEY is empty (web search needs one)");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`PORT is not a valid port: ${portRaw}`);
  }
  if (problems.length > 0) {
    throw new Error(`backend misconfigured: ${problems.join("; ")}`);
  }
  // Ollama is OPTIONAL: an empty value disables the local provider entirely
  // (cloud-only), and a bad LLM_PROVIDER is ignored rather than fatal, so the
  // existing API architecture always stays recoverable.
  const ollamaUrlRaw = (env["OLLAMA_URL"] ?? "").trim();
  const ollamaModelRaw = (env["OLLAMA_MODEL"] ?? "").trim();
  const llmProviderRaw = (env["LLM_PROVIDER"] ?? "auto").trim();
  const keepAliveRaw = (env["OLLAMA_KEEP_ALIVE"] ?? "").trim();
  const timeoutRaw = Number((env["OLLAMA_TIMEOUT_MS"] ?? "").trim());
  return {
    groqKeys,
    tavilyKey: (env["TAVILY_API_KEY"] ?? "").trim(),
    openrouterKey: (env["OPENROUTER_API_KEY"] ?? "").trim(),
    openrouterModel: (env["OPENROUTER_MODEL"] ?? "").trim() === ""
      ? OPENROUTER_DEFAULT_MODEL
      : (env["OPENROUTER_MODEL"] ?? "").trim(),
    ollamaUrl:
      ollamaUrlRaw === ""
        ? ""
        : ollamaUrlRaw === "disabled"
          ? ""
          : ollamaUrlRaw.replace(/\/+$/, ""),
    ollamaModel: ollamaModelRaw === "" ? OLLAMA_DEFAULT_MODEL : ollamaModelRaw,
    ollamaKeepAlive: keepAliveRaw,
    // Measured on this machine: cold load+inference up to ~60s, warm ~1-3s.
    // 180s leaves headroom so a cold start is never mistaken for a dead
    // endpoint (which would spend cloud quota), while staying bounded.
    ollamaTimeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw >= 10_000 && timeoutRaw <= 900_000
        ? Math.floor(timeoutRaw)
        : 180_000,
    llmProvider: LLM_PROVIDERS.has(llmProviderRaw)
      ? (llmProviderRaw as LlmProvider)
      : "auto",
    // Invalid value fails OPEN to "dom": never silently enable an experiment.
    contextMode: parseContextMode(env["CONTEXT_MODE"] ?? "dom"),
    port,
    backendToken: (env["BACKEND_TOKEN"] ?? "").trim(),
  };
}

/** Safe startup summary: counts and presence only — never values. */
export function configSummary(config: BackendConfig): Record<string, unknown> {
  return {
    groqKeysConfigured: config.groqKeys.length,
    tavilyConfigured: 1,
    openrouterConfigured: config.openrouterKey !== "" ? 1 : 0,
    // Model id is not secret — naming it proves which free model is in rotation.
    ...(config.openrouterKey !== "" ? { openrouterModel: config.openrouterModel } : {}),
    // Local provider presence + the selected primary. No URL, no credentials.
    ollamaConfigured: config.ollamaUrl !== "" ? 1 : 0,
    ...(config.ollamaUrl !== ""
      ? {
          ollamaModel: config.ollamaModel,
          llmProvider: config.llmProvider,
          ollamaKeepAlive:
            config.ollamaKeepAlive === "" ? "server-default" : config.ollamaKeepAlive,
          ollamaTimeoutMs: config.ollamaTimeoutMs,
        }
      : {}),
    port: config.port,
    // Not secret: tells the operator which context path is active.
    contextMode: config.contextMode,
    authMode: config.backendToken !== "" ? "bearer" : "open-loopback-dev",
  };
}
