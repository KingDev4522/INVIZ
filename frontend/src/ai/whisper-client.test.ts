/**
 * Whisper backend-client tests with a fake fetch (architecture split).
 * Base64 JSON contract, backend URL + optional token auth, 429/401 mapping,
 * empty-text rejection. Provider fallback discipline is tested backend-side.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TRANSCRIBE_ATTEMPTS,
  parseRetryAfterMs,
  transcribeAudio,
  TranscriptionError,
} from "./whisper-client.js";
import { ENDPOINTS } from "../../../shared/api.js";

const BACKEND = { url: "http://127.0.0.1:8787" };

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function httpError(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as Response;
}

describe("whisper backend client", () => {
  it("posts base64 audio JSON to /v1/transcribe", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: { body?: string }) => {
      seen.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      return okJson({ text: "hello world" });
    }) as unknown as typeof fetch;

    const audio = new Blob(["x"], { type: "audio/webm;codecs=opus" });
    const result = await transcribeAudio(audio, { backend: BACKEND, fetchImpl });
    expect(result).toEqual({ text: "hello world" });
    expect(seen.length).toBe(1);
    expect(seen[0]?.url).toBe(`http://127.0.0.1:8787${ENDPOINTS.transcribe}`);
    const body = seen[0]?.body ?? {};
    expect(typeof body["audioBase64"]).toBe("string");
    expect((body["audioBase64"] as string).length).toBeGreaterThan(0);
    expect(body["mimeType"]).toBe("audio/webm;codecs=opus");
    expect(body["language"]).toBeUndefined(); // auto-detect default
    expect(JSON.stringify(body)).not.toContain("gsk_"); // no provider keys here
  });

  it("sends the bearer token and language hint when configured", async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (
      _url: string,
      init: { headers?: Record<string, string>; body?: string },
    ) => {
      headers = init.headers ?? {};
      body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return okJson({ text: "नमस्ते" });
    }) as unknown as typeof fetch;
    await transcribeAudio(new Blob(["x"]), {
      backend: { url: "http://127.0.0.1:8787", token: "secret-token" },
      language: "hi",
      fetchImpl,
    });
    expect(headers["Authorization"]).toBe("Bearer secret-token");
    expect(body["language"]).toBe("hi");
  });

  it("maps 429 to retryable and 401 to fatal", async () => {
    const fetch401 = (async () => httpError(401, "unauthorized")) as unknown as typeof fetch;
    await expect(
      transcribeAudio(new Blob(["x"]), { backend: BACKEND, fetchImpl: fetch401 }),
    ).rejects.toMatchObject({ fatal: true, status: 401 });

    const fetch429 = (async () => httpError(429, "slow down")) as unknown as typeof fetch;
    const err = await transcribeAudio(new Blob(["x"]), {
      backend: BACKEND,
      fetchImpl: fetch429,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionError).fatal).toBe(false);
    expect((err as TranscriptionError).status).toBe(429);
  });

  it("rejects empty transcripts instead of forwarding them", async () => {
    const fetchImpl = (async () => okJson({ text: "   " })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(new Blob(["x"]), { backend: BACKEND, fetchImpl }),
    ).rejects.toBeInstanceOf(TranscriptionError);
  });

  it("makes exactly one attempt per call (no blind 429 retries)", async () => {
    expect(MAX_TRANSCRIBE_ATTEMPTS).toBe(1);
    let calls = 0;
    const fetch429 = (async () => {
      calls += 1;
      return httpError(429, "slow down");
    }) as unknown as typeof fetch;
    await expect(
      transcribeAudio(new Blob(["x"]), { backend: BACKEND, fetchImpl: fetch429 }),
    ).rejects.toBeInstanceOf(TranscriptionError);
    expect(calls).toBe(1);
  });

  it("parses retry-after hints without retrying", async () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });

  it("rejects empty audio input without touching the network", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return okJson({ text: "x" });
    }) as unknown as typeof fetch;
    // A zero-byte blob still base64-encodes (empty string is the failure case
    // only when encoding yields nothing); assert the client validates output.
    await expect(
      transcribeAudio(new Blob([]), { backend: BACKEND, fetchImpl }),
    ).rejects.toBeInstanceOf(TranscriptionError);
    expect(calls).toBe(0); // rejected before any network traffic
  });
});
