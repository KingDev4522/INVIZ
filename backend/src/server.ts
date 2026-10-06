/**
 * INVIZ backend entry: authenticated AI gateway over plain Node http.
 * Routes: GET /v1/health (open) · POST /v1/chat|enrich|transcribe|tts|validation.
 * Zero runtime dependencies (Node builtins only). Provider keys never leave
 * this process: they are read from the environment and never logged.
 */
import http from "node:http";
import { configSummary, loadConfig, loadDotEnv } from "./config.js";
import { GroqKeyPool } from "./gateway/gateway.js";
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
          result = await handleChat(body, { pool, ...reasoningExtras, fetchImpl });
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

server.listen(config.port, "127.0.0.1", () => {
  logger.info("backend listening", {
    ...configSummary(config),
    url: `http://127.0.0.1:${config.port}`,
  });
});
