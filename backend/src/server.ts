/**
 * INVIZ backend entry: authenticated AI gateway over plain Node http.
 * Routes: GET /v1/health (open) · POST /v1/chat|enrich|transcribe|tts|validation.
 * Zero runtime dependencies (Node builtins only). Provider keys never leave
 * this process: they are read from the environment and never logged.
 */
import http from "node:http";
import { configSummary, loadConfig, loadDotEnv } from "./config.js";
import { GroqKeyPool } from "./gateway/gateway.js";
import { probeOllama } from "./gateway/ollama.js";
import { checkAuth, logRequest, readJsonBody, sendError, sendJson, setCors } from "./http.js";
import { handleChat } from "./routes/chat.js";
import { handleEnrich } from "./routes/enrich.js";
import { handleTranscribe } from "./routes/transcribe.js";
import { handleTts } from "./routes/tts.js";
import { handleSearch } from "./routes/search.js";
import { handleHealth, handleValidation } from "./routes/health.js";
import { logger } from "../../shared/logger.js";

loadDotEnv();
const config = loadConfig();
const pool = new GroqKeyPool(config.groqKeys);
const openrouter =
  config.openrouterKey !== ""
    ? { apiKey: config.openrouterKey, model: config.openrouterModel }
    : undefined;
// Local provider is additive: absent config => undefined => never attempted.
const ollama =
  config.ollamaUrl !== ""
    ? {
        url: config.ollamaUrl,
        model: config.ollamaModel,
        keepAlive: config.ollamaKeepAlive,
      }
    : undefined;
const reasoningExtras = {
  ...(openrouter === undefined ? {} : { openrouter }),
  ...(ollama === undefined ? {} : { ollama }),
  llmProvider: config.llmProvider,
};
const fetchImpl = fetch;

function authorized(req: http.IncomingMessage): boolean {
  return checkAuth(req, config.backendToken);
}

const server = http.createServer((req, res) => {
  void (async () => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    let status = 404;
    try {
      setCors(req, res);
      if (method === "OPTIONS") {
        status = 204;
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" && path === "/v1/health") {
        const result = await handleHealth({
          groqKeysConfigured: config.groqKeys.length,
          tavilyConfigured: config.tavilyKey !== "" ? 1 : 0,
        });
        status = result.status;
        sendJson(res, result.status, result.payload);
        return;
      }
      const authedRoutes = new Set([
        "/v1/chat",
        "/v1/enrich",
        "/v1/transcribe",
        "/v1/tts",
        "/v1/search",
        "/v1/validation",
      ]);
      if (!authedRoutes.has(path)) {
        status = 404;
        sendError(res, 404, "NOT_FOUND", "unknown endpoint");
        return;
      }
      if (method !== "POST") {
        status = 405;
        sendError(res, 405, "METHOD_NOT_ALLOWED", "use POST");
        return;
      }
      if (!authorized(req)) {
        status = 401;
        sendError(res, 401, "UNAUTHORIZED", "invalid or missing backend token");
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const shaped = err as { status?: number; code?: string };
        status = typeof shaped.status === "number" ? shaped.status : 400;
        sendError(res, status, typeof shaped.code === "string" ? shaped.code : "BAD_BODY", "unreadable request body");
        return;
      }
      let result: { status: number; payload: unknown };
      switch (path) {
        case "/v1/chat":
          result = await handleChat(body, {
            pool,
            ...reasoningExtras,
            fetchImpl,
            // EXPERIMENTAL: chat is the only route that can receive an image.
            contextMode: config.contextMode,
          });
          break;
        case "/v1/enrich":
          result = await handleEnrich(body, { pool, ...reasoningExtras, fetchImpl });
          break;
        case "/v1/transcribe":
          result = await handleTranscribe(body, { pool, fetchImpl });
          break;
        case "/v1/tts":
          result = await handleTts(body, { pool, fetchImpl });
          break;
        case "/v1/search":
          result = await handleSearch(body, { apiKey: config.tavilyKey, fetchImpl });
          break;
        case "/v1/validation":
          result = await handleValidation({
            pool,
            fetchImpl,
            ...(openrouter !== undefined ? { openrouterKey: openrouter.apiKey } : {}),
            ...(ollama === undefined ? {} : { ollama }),
            tavilyConfigured: config.tavilyKey !== "",
          });
          break;
        default:
          result = { status: 404, payload: { error: { code: "NOT_FOUND", message: "unknown endpoint" } } };
          break;
      }
      status = result.status;
      sendJson(res, result.status, result.payload);
    } catch (err) {
      status = 500;
      logger.error("server: unhandled route failure", {
        errorCode: "ACTION_FAILED",
      });
      void err;
      sendError(res, 500, "INTERNAL", "unexpected backend failure");
    } finally {
      logRequest({ method, path, status, ms: Date.now() - startedAt });
    }
  })().catch(() => undefined);
});

/**
 * Startup diagnostics for the reasoning chain.
 *
 * Answers, in one place at boot: which provider leads, which local model is
 * configured, and — critically — whether that local model is actually reachable
 * RIGHT NOW. The root-cause finding behind this was that a backend started
 * while Ollama was down looked identical to a healthy one until a voice turn
 * silently fell back to cloud.
 *
 * Presence/counts/reachability only: no key material, no prompts.
 * NEVER throws and NEVER prevents startup — an unavailable local provider is a
 * degraded-but-working configuration (cloud fallback exists exactly for this).
 */
async function reportStartupReasoningStatus(): Promise<void> {
  logger.info("startup: reasoning configuration", {
    llmProvider: config.llmProvider,
    localOllamaConfigured: ollama !== undefined,
    ...(ollama !== undefined ? { ollamaModel: ollama.model } : {}),
  });
  if (ollama === undefined) {
    logger.info("startup: local reasoning not configured - cloud reasoning only", {
      llmProvider: config.llmProvider,
    });
    return;
  }
  try {
    const probe = await probeOllama(ollama, { fetchImpl, timeoutMs: 5000 });
    if (probe.ok) {
      logger.info("startup: local Ollama AVAILABLE", {
        ollamaModel: ollama.model,
        detail: probe.detail,
      });
      return;
    }
    const pinnedToLocal = config.llmProvider === "ollama";
    logger.warn(
      pinnedToLocal
        ? "startup: LLM_PROVIDER=ollama but local Ollama is unavailable - every turn will fall back to cloud (Groq/OpenRouter). Start Ollama, then press Validate backend (live) or wait for the cooldown; the local provider re-probes automatically."
        : "startup: local Ollama unavailable - cloud reasoning will be used until it recovers",
      { ollamaModel: ollama.model, detail: probe.detail },
    );
  } catch (err) {
    logger.warn("startup: local Ollama probe failed - cloud reasoning will be used", {
      ollamaModel: ollama.model,
    });
    void err;
  }
}

server.listen(config.port, "127.0.0.1", () => {
  logger.info("backend listening", {
    ...configSummary(config),
    url: `http://127.0.0.1:${config.port}`,
    port: config.port,
  });
  // Diagnostics run AFTER the socket is bound: the service must be reachable
  // even if Ollama is down or the probe itself is slow.
  void reportStartupReasoningStatus().catch(() => undefined);
});
