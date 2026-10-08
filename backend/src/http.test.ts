/**
 * HTTP helper tests: bearer auth semantics + JSON body limits.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { checkAuth, readJsonBody } from "./http.js";
import { Readable } from "node:stream";

describe("checkAuth", () => {
  it("is open when no token is configured", () => {
    expect(checkAuth({ headers: {} } as never, "")).toBe(true);
  });

  it("accepts the exact bearer token and rejects everything else", () => {
    const req = (auth: string | undefined) =>
      ({ headers: auth === undefined ? {} : { authorization: auth } }) as never;
    expect(checkAuth(req("Bearer secret-token"), "secret-token")).toBe(true);
    expect(checkAuth(req("Bearer wrong"), "secret-token")).toBe(false);
    expect(checkAuth(req(undefined), "secret-token")).toBe(false);
    expect(checkAuth(req("Token secret-token"), "secret-token")).toBe(false);
    // Length-mismatch must not throw (timingSafeEqual guard).
    expect(checkAuth(req("Bearer short"), "a-much-longer-secret-token")).toBe(false);
  });
});

describe("readJsonBody", () => {
  function reqOf(text: string): never {
    return Readable.from([Buffer.from(text)]) as never;
  }

  it("parses valid JSON", async () => {
    await expect(readJsonBody(reqOf('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it("rejects empty and malformed bodies with shaped errors", async () => {
    await expect(readJsonBody(reqOf("   "))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonBody(reqOf("{nope"))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects oversized bodies", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    await expect(readJsonBody(reqOf(big))).rejects.toMatchObject({ status: 413 });
  });
});
