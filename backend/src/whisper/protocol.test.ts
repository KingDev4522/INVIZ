/**
 * Whisper protocol tests: multipart shape, pool rotation, fallback discipline,
 * 429/401 mapping. Fake fetch only. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { transcribeViaPool, TranscriptionError } from "./protocol.js";
import { GroqKeyPool } from "../gateway/gateway.js";
import {
  WHISPER_FALLBACK_MODEL,
  WHISPER_PRIMARY_MODEL,
} from "../../../shared/constants.js";

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

function formEntries(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of (body as FormData).entries()) {
    out[k] = typeof v === "string" ? v : `FILE(${(v as File).name})`;
  }
  return out;
}

const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

describe("transcribeViaPool", () => {
  it("posts multipart with file + primary model", async () => {
    const seen: Array<{ url: string; auth: string; fields: Record<string, string> }> = [];
    const fetchImpl = (async (
      url: string,
      init: { headers?: Record<string, string>; body?: unknown },
    ) => {
      seen.push({
        url,
        auth: init.headers?.["Authorization"] ?? "",
        fields: formEntries(init.body),
      });
      return okJson({ text: "hello world" });
    }) as unknown as typeof fetch;
    const result = await transcribeViaPool(AUDIO, "audio/webm;codecs=opus", {
      pool: new GroqKeyPool(["k1"]),
      fetchImpl,
    });
    expect(result).toEqual({ text: "hello world" });
    expect(seen[0]?.url).toContain("/audio/transcriptions");
    expect(seen[0]?.auth).toBe("Bearer k1");
    expect(seen[0]?.fields["model"]).toBe(WHISPER_PRIMARY_MODEL);
    expect(seen[0]?.fields["file"]).toMatch(/^FILE\(/);
    expect(seen[0]?.fields["language"]).toBeUndefined();
  });

  it("rotates keys on 401 and falls back models on 400", async () => {
    const calls: Array<{ key: string; model: string }> = [];
    const fetchImpl = (async (
      _url: string,
      init: { headers?: Record<string, string>; body?: unknown },
    ) => {
      const key = (init.headers?.["Authorization"] ?? "").replace("Bearer ", "");
      const fields = formEntries(init.body);
      calls.push({ key, model: fields["model"] ?? "?" });
      if (key === "bad") return httpError(401, "invalid");
      if (calls.length === 2) return httpError(400, "model busy");
      return okJson({ text: "recovered" });
    }) as unknown as typeof fetch;
    const result = await transcribeViaPool(AUDIO, "audio/webm", {
      pool: new GroqKeyPool(["bad", "good"]),
      fetchImpl,
    });
    expect(result).toEqual({ text: "recovered" });
    expect(calls[0]).toEqual({ key: "bad", model: WHISPER_PRIMARY_MODEL });
    expect(calls[1]).toEqual({ key: "good", model: WHISPER_PRIMARY_MODEL });
    expect(calls[2]).toEqual({ key: "good", model: WHISPER_FALLBACK_MODEL });
  });

  it("maps 429 to retryable and 401-exhaustion to fatal", async () => {
    const fetch429 = (async () => httpError(429, "slow")) as unknown as typeof fetch;
    const err = await transcribeViaPool(AUDIO, "audio/webm", {
      pool: new GroqKeyPool(["k1"]),
      fetchImpl: fetch429,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionError).fatal).toBe(false);

    const fetch401 = (async () => httpError(401, "bad")) as unknown as typeof fetch;
    await expect(
      transcribeViaPool(AUDIO, "audio/webm", {
        pool: new GroqKeyPool(["only"]),
        fetchImpl: fetch401,
      }),
    ).rejects.toMatchObject({ fatal: true, status: 401 });
  });
});
