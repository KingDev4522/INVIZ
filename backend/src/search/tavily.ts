/**
 * Tavily web search — REAL, live api.tavily.com (agent capability).
 * Server-side only: holds the provider key, returns truncated results that
 * fit the reasoning token budget. One credit per call at basic depth, so
 * calls are single-attempt (429 → honest RATE_LIMITED, never retried here).
 */
import {
  TAVILY_BASE_URL,
  TAVILY_MAX_RESULTS,
  TAVILY_QUERY_MAX_CHARS,
  TAVILY_REQUEST_TIMEOUT_MS,
  TAVILY_SEARCH_DEPTH,
  TAVILY_SNIPPET_MAX_CHARS,
} from "../../../shared/constants.js";
import { retryAfterMs } from "../gateway/gateway.js";

export interface TavilySearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class SearchAuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Tavily key rejected (HTTP ${status}) — check the server's TAVILY_API_KEY`);
    this.name = "SearchAuthError";
    this.status = status;
  }
}

export class SearchRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null) {
    super("Tavily rate limited (HTTP 429)");
    this.name = "SearchRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class SearchRequestError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Tavily search failed (HTTP ${status}): ${body.slice(0, 200)}`);
    this.name = "SearchRequestError";
    this.status = status;
  }
}

export interface SearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface TavilyRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

function toResult(raw: TavilyRawResult): TavilySearchResult | null {
  if (typeof raw.url !== "string" || raw.url.trim() === "") return null;
  const lowered = raw.url.trim().toLowerCase();
  if (!lowered.startsWith("http://") && !lowered.startsWith("https://")) return null;
  const title = typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title.trim() : raw.url.trim();
  const content = typeof raw.content === "string" ? raw.content.replace(/\s+/gu, " ").trim() : "";
  const snippet =
    content.length > TAVILY_SNIPPET_MAX_CHARS
      ? `${content.slice(0, TAVILY_SNIPPET_MAX_CHARS).trimEnd()}…`
      : content;
  return { title: title.slice(0, 200), url: raw.url.trim(), snippet };
}

/**
 * Live web search through Tavily. Query bounds are enforced by the route;
 * this layer defends in depth and normalizes provider errors.
 */
export async function searchViaTavily(
  query: string,
  deps: { apiKey: string },
  options: SearchOptions = {},
): Promise<TavilySearchResult[]> {
  const clean = query.replace(/\s+/gu, " ").trim();
  if (clean === "" || clean.length > TAVILY_QUERY_MAX_CHARS) {
    throw new SearchRequestError(400, "query must be 1..400 characters");
  }
  const maxResults = options.maxResults ?? TAVILY_MAX_RESULTS;
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), TAVILY_MAX_RESULTS);
  if (deps.apiKey === "") throw new SearchAuthError(401);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TAVILY_REQUEST_TIMEOUT_MS);
  try {
    const res = await (options.fetchImpl ?? fetch)(`${TAVILY_BASE_URL}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: clean,
        search_depth: TAVILY_SEARCH_DEPTH,
        max_results: capped,
        chunks_per_source: 1,
        include_answer: false,
      }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new SearchAuthError(res.status);
    }
    if (res.status === 429) {
      throw new SearchRateLimitError(retryAfterMs(res));
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      throw new SearchRequestError(res.status, raw);
    }
    const data = (await res.json()) as { results?: unknown };
    if (!Array.isArray(data.results)) {
      throw new SearchRequestError(res.status, "search response had no results array");
    }
    const out: TavilySearchResult[] = [];
    for (const item of data.results) {
      if (out.length >= capped) break;
      if (typeof item !== "object" || item === null) continue;
      const mapped = toResult(item as TavilyRawResult);
      if (mapped !== null) out.push(mapped);
    }
    return out;
  } catch (err) {
    if (
      err instanceof SearchAuthError ||
      err instanceof SearchRateLimitError ||
      err instanceof SearchRequestError
    ) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new SearchRequestError(504, "search timed out");
    }
    throw new SearchRequestError(500, err instanceof Error ? err.message : "network failure");
  } finally {
    clearTimeout(timeout);
  }
}
