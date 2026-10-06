/**
 * POST /v1/search — live Tavily web search (agent capability).
 * Accepts a bounded query and returns truncated title/url/snippet results
 * sized for the reasoning token budget. Query CONTENT is never logged —
 * lengths only. Single attempt per call (429 → RATE_LIMITED, not retried).
 */
import { TAVILY_MAX_RESULTS, TAVILY_QUERY_MAX_CHARS } from "../../../shared/constants.js";
import { logger } from "../../../shared/logger.js";
import {
  SearchAuthError,
  SearchRateLimitError,
  searchViaTavily,
} from "../search/tavily.js";

export interface SearchDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleSearch(
  body: unknown,
  deps: SearchDeps,
): Promise<{ status: number; payload: unknown }> {
  if (!isRecord(body) || typeof body["query"] !== "string") {
    return { status: 400, payload: { error: { code: "BAD_PAYLOAD", message: "query must be a string" } } };
  }
  const query = (body["query"] as string).replace(/\s+/gu, " ").trim();
  if (query === "" || query.length > TAVILY_QUERY_MAX_CHARS) {
    return {
      status: 400,
      payload: {
        error: {
          code: "BAD_PAYLOAD",
          message: `query must be 1..${TAVILY_QUERY_MAX_CHARS} characters`,
        },
      },
    };
  }
  const rawMax = body["maxResults"];
  const maxResults =
    typeof rawMax === "number" && Number.isInteger(rawMax) ? rawMax : TAVILY_MAX_RESULTS;
  if (maxResults < 1 || maxResults > TAVILY_MAX_RESULTS) {
    return {
      status: 400,
      payload: {
        error: { code: "BAD_PAYLOAD", message: `maxResults must be an integer in [1, ${TAVILY_MAX_RESULTS}]` },
      },
    };
  }
  const turnId = typeof body["turnId"] === "string" ? (body["turnId"] as string) : undefined;
  logger.info("search: attempt", {
    ...(turnId !== undefined ? { turnId } : {}),
    requestType: "search",
    timestampMs: Date.now(),
    queryChars: query.length,
    maxResults,
  });
  try {
    const results = await searchViaTavily(query, { apiKey: deps.apiKey }, {
      maxResults,
      fetchImpl: deps.fetchImpl,
    });
    logger.info("search: ok", {
      ...(turnId !== undefined ? { turnId } : {}),
      requestType: "search",
      timestampMs: Date.now(),
      resultCount: results.length,
    });
    return { status: 200, payload: { results } };
  } catch (err) {
    if (err instanceof SearchRateLimitError) {
      logger.warn("search: rate limited", {
        ...(turnId !== undefined ? { turnId } : {}),
        errorCode: "RATE_LIMITED",
        httpStatus: 429,
      });
      return { status: 429, payload: { error: { code: "RATE_LIMITED", message: "search rate limited" } } };
    }
    if (err instanceof SearchAuthError) {
      logger.error("search: provider rejected the key", { errorCode: "PROVIDER_AUTH" });
      return { status: 500, payload: { error: { code: "PROVIDER_AUTH", message: "search provider rejected the server key" } } };
    }
    logger.error("search: failed", {
      ...(turnId !== undefined ? { turnId } : {}),
      errorCode: "SEARCH_FAILED",
      reason: err instanceof Error ? err.message : "unknown",
    });
    return { status: 500, payload: { error: { code: "SEARCH_FAILED", message: "web search failed" } } };
  }
}
