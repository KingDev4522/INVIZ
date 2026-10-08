/**
 * Web-search client — backend HTTP edition (architecture split).
 * The frontend NEVER talks to Tavily: it POSTs the bounded query to the
 * backend /v1/search contract, which owns the provider key and truncates
 * results for the reasoning budget. Error contract mirrors whisper-client:
 * single attempt, 429 never retried, 401/403 fatal.
 */
import {
  BackendError,
  ENDPOINTS,
  type BackendRef,
  type SearchResultItem,
} from "../../../shared/api.js";
import { logger } from "../../../shared/logger.js";

/**
 * Search retry policy: exactly ONE attempt per call. Every call spends real
 * Tavily credits, so a 429 is surfaced (not retried) for the caller to speak
 * honestly and let the user decide.
 */
export const MAX_SEARCH_ATTEMPTS = 1;

export class SearchError extends Error {
  readonly status: number | null;
  /** False for 429 (caller may wait); true otherwise. Never auto-retried. */
  readonly fatal: boolean;
  constructor(message: string, status: number | null, fatal: boolean) {
    super(message);
    this.name = "SearchError";
    this.status = status;
    this.fatal = fatal;
  }
}

export interface SearchOptions {
  backend: BackendRef;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Voice-turn correlation id, carried into logs and the backend body. */
  turnId?: string;
}

export async function webSearch(
  query: string,
  opts: SearchOptions,
): Promise<{ results: SearchResultItem[] }> {
  const clean = query.replace(/\s+/gu, " ").trim();
  if (clean === "" || clean.length > 400) {
    throw new SearchError("query must be 1..400 characters", null, true);
  }
  const turnId = opts.turnId ?? "no-turn";
  // Query CONTENT is never logged (user speech); length proves a real call.
  logger.info("api: search attempt", {
    turnId,
    requestType: "search",
    timestampMs: Date.now(),
    attempt: 1,
    maxAttempts: MAX_SEARCH_ATTEMPTS,
    queryChars: clean.length,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.backend.token !== undefined && opts.backend.token !== "") {
      headers["Authorization"] = `Bearer ${opts.backend.token}`;
    }
    res = await (opts.fetchImpl ?? fetch)(`${opts.backend.url}${ENDPOINTS.search}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: clean,
        ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
        ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn("api: search failed", {
      turnId,
      requestType: "search",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "transport-error",
    });
    void err;
    throw new SearchError("web search transport failed", null, false);
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 429) {
    logger.warn("api: search rate limited", {
      turnId,
      requestType: "search",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "rate-limited",
      httpStatus: 429,
    });
    throw new SearchError("API rate limit reached. Please wait and try again.", 429, false);
  }
  if (res.status === 401 || res.status === 403) {
    logger.warn("api: search failed", {
      turnId,
      requestType: "search",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "auth-error",
      httpStatus: res.status,
    });
    throw new SearchError("backend rejected frontend credentials", res.status, true);
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    logger.warn("api: search failed", {
      turnId,
      requestType: "search",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "error",
      httpStatus: res.status,
    });
    throw new SearchError(`web search failed (HTTP ${res.status})`, res.status, true);
  }
  const data = (await res.json()) as { results?: unknown };
  if (!Array.isArray(data.results)) {
    throw new SearchError("search returned no results array", res.status, true);
  }
  const results: SearchResultItem[] = [];
  for (const item of data.results) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["url"] !== "string" || typeof rec["title"] !== "string") continue;
    results.push({
      title: rec["title"],
      url: rec["url"],
      snippet: typeof rec["snippet"] === "string" ? rec["snippet"] : "",
    });
    if (results.length >= 5) break;
  }
  logger.info("api: search ok", {
    turnId,
    requestType: "search",
    timestampMs: Date.now(),
    attempt: 1,
    outcome: "ok",
    httpStatus: res.status,
    resultCount: results.length,
  });
  return { results };
}

export { BackendError };
export type { BackendRef, SearchResultItem };
