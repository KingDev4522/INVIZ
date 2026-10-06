/**
 * POST /v1/search route tests: payload validation, status mapping.
 * Provider behavior itself is covered in search/tavily.test.ts.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { handleSearch } from "./search.js";

const DEPS = { apiKey: "route-test-key" };

function okFetch(results: unknown[]): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
  })) as unknown as typeof fetch;
}

describe("handleSearch", () => {
  it("rejects missing/empty/oversize queries and bad maxResults", async () => {
    expect((await handleSearch({}, DEPS)).status).toBe(400);
    expect((await handleSearch({ query: "   " }, DEPS)).status).toBe(400);
    expect((await handleSearch({ query: "x".repeat(401) }, DEPS)).status).toBe(400);
    expect((await handleSearch({ query: "q", maxResults: 0 }, DEPS)).status).toBe(400);
    expect((await handleSearch({ query: "q", maxResults: 6 }, DEPS)).status).toBe(400);
  });

  it("returns truncated results on success", async () => {
    const res = await handleSearch(
      { query: "visa rules", turnId: "turn_1" },
      {
        ...DEPS,
        fetchImpl: okFetch([
          { title: "Visa Guide", url: "https://example.com/visa", content: "apply early" },
        ]),
      },
    );
    expect(res.status).toBe(200);
    expect(res.payload).toEqual({
      results: [{ title: "Visa Guide", url: "https://example.com/visa", snippet: "apply early" }],
    });
  });

  it("maps provider 429 to RATE_LIMITED and auth failures to PROVIDER_AUTH", async () => {
    const f429 = (async () => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => "slow",
    })) as unknown as typeof fetch;
    const limited = await handleSearch({ query: "q" }, { ...DEPS, fetchImpl: f429 });
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.payload)).toContain("RATE_LIMITED");

    const f401 = (async () => ({ ok: false, status: 401, text: async () => "no" })) as unknown as typeof fetch;
    const auth = await handleSearch({ query: "q" }, { ...DEPS, fetchImpl: f401 });
    expect(auth.status).toBe(500);
    expect(JSON.stringify(auth.payload)).toContain("PROVIDER_AUTH");
  });
});
