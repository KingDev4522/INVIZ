/**
 * Tavily search client tests: request shape, truncation, error mapping.
 * Key discipline: fakes only — the real key never appears outside .env.
 * Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import {
  SearchAuthError,
  SearchRateLimitError,
  SearchRequestError,
  searchViaTavily,
} from "./tavily.js";

function okFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("searchViaTavily", () => {
  it("posts bearer auth + bounded body to /search", async () => {
    let url = "";
    let init: RequestInit = {};
    const fetchImpl = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }) as unknown as typeof fetch;
    await searchViaTavily("pizza near me", { apiKey: "or-test-key" }, { fetchImpl });
    expect(url).toBe("https://api.tavily.com/search");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer or-test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["query"]).toBe("pizza near me");
    expect(body["search_depth"]).toBe("basic");
    expect(body["max_results"]).toBe(5);
    expect(body["include_answer"]).toBe(false);
  });

  it("truncates snippets and drops non-http results", async () => {
    const results = await searchViaTavily(
      "q",
      { apiKey: "k" },
      {
        fetchImpl: okFetch({
          results: [
            { title: "Good", url: "https://example.com/a", content: "x".repeat(500) },
            { title: "", url: "https://example.com/b", content: "short" },
            { title: "Bad scheme", url: "javascript:alert(1)", content: "evil" },
            { title: "No URL", content: "missing" },
          ],
        }),
      },
    );
    expect(results.length).toBe(2);
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(301);
    expect(results[1]?.title).toBe("https://example.com/b");
  });

  it("maps 401 to auth, 429 to rate-limit (with hint), 500 to request error", async () => {
    const f401 = (async () => ({ ok: false, status: 401, text: async () => "no" })) as unknown as typeof fetch;
    await expect(searchViaTavily("q", { apiKey: "k" }, { fetchImpl: f401 })).rejects.toBeInstanceOf(
      SearchAuthError,
    );
    const f429 = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: (n: string) => (n === "retry-after" ? "3" : null) },
      text: async () => "slow",
    })) as unknown as typeof fetch;
    const err = await searchViaTavily("q", { apiKey: "k" }, { fetchImpl: f429 }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchRateLimitError);
    expect((err as SearchRateLimitError).retryAfterMs).toBe(3000);
    const f500 = (async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch;
    await expect(searchViaTavily("q", { apiKey: "k" }, { fetchImpl: f500 })).rejects.toBeInstanceOf(
      SearchRequestError,
    );
  });

  it("rejects empty/oversize queries and missing keys without network", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string) => {
      calls.push(u);
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }) as unknown as typeof fetch;
    await expect(searchViaTavily("   ", { apiKey: "k" }, { fetchImpl })).rejects.toBeInstanceOf(
      SearchRequestError,
    );
    await expect(
      searchViaTavily("x".repeat(401), { apiKey: "k" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(SearchRequestError);
    await expect(searchViaTavily("q", { apiKey: "" }, { fetchImpl })).rejects.toBeInstanceOf(
      SearchAuthError,
    );
    expect(calls.length).toBe(0);
  });
});
