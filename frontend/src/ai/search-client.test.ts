/**
 * Web-search backend-client tests: single POST, no blind retries, turnId.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { MAX_SEARCH_ATTEMPTS, SearchError, webSearch } from "./search-client.js";
import { ENDPOINTS } from "../../../shared/api.js";

const BACKEND = { url: "http://127.0.0.1:8787" };

function okJson(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

function httpError(status: number): Response {
  return { ok: false, status, json: async () => ({}), text: async () => "err" } as Response;
}

describe("web search backend client", () => {
  it("posts the query once to /v1/search with turnId", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: { body?: string }) => {
      seen.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      return okJson({ results: [{ title: "T", url: "https://example.com/", snippet: "S" }] });
    }) as unknown as typeof fetch;
    const out = await webSearch("visa rules", { backend: BACKEND, fetchImpl, turnId: "turn_9" });
    expect(seen.length).toBe(1);
    expect(seen[0]?.url).toBe(`http://127.0.0.1:8787${ENDPOINTS.search}`);
    expect(seen[0]?.body["query"]).toBe("visa rules");
    expect(seen[0]?.body["turnId"]).toBe("turn_9");
    expect(out.results.length).toBe(1);
  });

  it("makes exactly one attempt on 429 (surfaces, never retries)", async () => {
    expect(MAX_SEARCH_ATTEMPTS).toBe(1);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return httpError(429);
    }) as unknown as typeof fetch;
    const err = await webSearch("q", { backend: BACKEND, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).status).toBe(429);
    expect((err as SearchError).fatal).toBe(false);
    expect(calls).toBe(1);
  });

  it("maps 401 to fatal and rejects bad queries offline", async () => {
    const fetchImpl = (async () => httpError(401)) as unknown as typeof fetch;
    await expect(webSearch("q", { backend: BACKEND, fetchImpl })).rejects.toMatchObject({
      fatal: true,
      status: 401,
    });
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return okJson({ results: [] });
    }) as unknown as typeof fetch;
    await expect(webSearch("   ", { backend: BACKEND, fetchImpl: counting })).rejects.toBeInstanceOf(
      SearchError,
    );
    expect(calls).toBe(0);
  });
});
