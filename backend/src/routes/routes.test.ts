/**
 * Route tests: request validation, status mapping, secret-free responses.
 * Handlers are pure (deps-injected); no sockets needed. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { handleChat } from "./chat.js";
import { handleEnrich } from "./enrich.js";
import { handleTranscribe } from "./transcribe.js";
import { handleTts } from "./tts.js";
import { handleHealth, handleValidation } from "./health.js";
import { GroqKeyPool } from "../gateway/gateway.js";

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

const CHAT_OK = {
  choices: [{ message: { content: JSON.stringify({ type: "answer", text: "Hi." }) } }],
};

describe("POST /v1/chat", () => {
  it("rejects malformed bodies with 400", async () => {
    const deps = { pool: new GroqKeyPool(["k1"]) };
    for (const body of [
      null,
      {},
      { userPayload: "   " },
      { userPayload: "x".repeat(60001) },
      { userPayload: "hi", effort: "turbo" },
      { userPayload: "hi", maxCompletionTokens: 5 },
    ]) {
      const res = await handleChat(body, deps);
      expect(res.status).toBe(400);
    }
  });

  it("returns validated outcomes and maps provider failures", async () => {
    const okFetch = (async () => okJson(CHAT_OK)) as unknown as typeof fetch;
    const ok = await handleChat(
      { userPayload: "What is this?" },
      { pool: new GroqKeyPool(["k1"]), fetchImpl: okFetch },
    );
    expect(ok.status).toBe(200);
    expect(ok.payload).toEqual({ type: "answer", text: "Hi." });

    const limited = await handleChat(
      { userPayload: "What is this?" },
      {
        pool: new GroqKeyPool(["k1"]),
        fetchImpl: (async () => httpError(429, "slow")) as unknown as typeof fetch,
      },
    );
    expect(limited.status).toBe(429);
  });
});

describe("POST /v1/enrich", () => {
  it("validates input and returns advisory layers", async () => {
    const deps = { pool: new GroqKeyPool(["k1"]) };
    expect((await handleEnrich({}, deps)).status).toBe(400);
    expect((await handleEnrich({ pageText: "x", generation: "7", lang: "en" }, deps)).status).toBe(400);
    const okFetch = (async () =>
      okJson({
        choices: [{ message: { content: JSON.stringify({ type: "answer", text: "A form page." }) } }],
      })) as unknown as typeof fetch;
    const res = await handleEnrich(
      { pageText: "PAGE e1 button", generation: 3, lang: "en" },
      { pool: new GroqKeyPool(["k1"]), fetchImpl: okFetch },
    );
    expect(res.status).toBe(200);
    const layer = res.payload as { provenance: string; pageGeneration: number };
    expect(layer.provenance).toBe("MODEL_INFERENCE");
    expect(layer.pageGeneration).toBe(3);
  });
});

describe("POST /v1/transcribe", () => {
  const audioBase64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");

  it("validates input shape and size", async () => {
    const deps = { pool: new GroqKeyPool(["k1"]) };
    expect((await handleTranscribe({}, deps)).status).toBe(400);
    expect((await handleTranscribe({ audioBase64: "" }, deps)).status).toBe(400);
    expect(
      (await handleTranscribe({ audioBase64: "a".repeat(7_000_001) }, deps)).status,
    ).toBe(413);
    expect(
      (await handleTranscribe({ audioBase64, language: 42 }, deps)).status,
    ).toBe(400);
  });

  it("returns transcript text on success", async () => {
    const okFetch = (async () => okJson({ text: "hello" })) as unknown as typeof fetch;
    const res = await handleTranscribe(
      { audioBase64 },
      { pool: new GroqKeyPool(["k1"]), fetchImpl: okFetch },
    );
    expect(res).toEqual({ status: 200, payload: { text: "hello" } });
  });
});

describe("POST /v1/tts", () => {
  const deps = { pool: new GroqKeyPool(["k1"]) };

  /** A real WAV container, as the Groq speech endpoint returns. */
  function wavBytes(sampleBytes = 4800): Buffer {
    const out = Buffer.alloc(44 + sampleBytes);
    out.write("RIFF", 0);
    out.writeUInt32LE(36 + sampleBytes, 4);
    out.write("WAVE", 8);
    out.write("data", 36);
    out.writeUInt32LE(sampleBytes, 40);
    return out;
  }

  it("validates text and lang", async () => {
    expect((await handleTts({}, deps)).status).toBe(400);
    expect((await handleTts({ text: "   ", lang: "en" }, deps)).status).toBe(400);
    expect((await handleTts({ text: "x".repeat(4001), lang: "en" }, deps)).status).toBe(400);
    expect((await handleTts({ text: "hi", lang: "fr" }, deps)).status).toBe(400);
  });

  it("returns the provider's WAV audio verbatim", async () => {
    const wav = wavBytes();
    const okFetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/wav" }),
      arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: okFetch });
    expect(res.status).toBe(200);
    const payload = res.payload as { audioBase64: string; mimeType: string; sampleRate: number };
    expect(payload.mimeType).toBe("audio/wav");
    expect(payload.sampleRate).toBe(24000);
    const out = Buffer.from(payload.audioBase64, "base64");
    expect(out.subarray(0, 4).toString()).toBe("RIFF");
    expect(out.length).toBe(wav.length);
  });

  it("wraps a bare PCM payload so the browser can still play it", async () => {
    const pcm = Buffer.alloc(4800, 7);
    const pcmFetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/pcm" }),
      arrayBuffer: async () => pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: pcmFetch });
    expect(res.status).toBe(200);
    const payload = res.payload as { audioBase64: string };
    const out = Buffer.from(payload.audioBase64, "base64");
    expect(out.subarray(0, 4).toString()).toBe("RIFF");
    expect(out.length).toBe(44 + 4800);
  });

  it("rejects empty audio rather than returning silence", async () => {
    const emptyFetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/wav" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: emptyFetch });
    expect(res.status).toBe(500);
  });

  it("maps rate limiting to 429", async () => {
    const limitedFetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: limitedFetch });
    expect(res.status).toBe(429);
  });

  it("maps a rejected key to 500 PROVIDER_AUTH", async () => {
    const deniedFetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: deniedFetch });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.payload)).toContain("PROVIDER_AUTH");
  });

  it("reports unaccepted model terms as an actionable 503, not a generic failure", async () => {
    const termsFetch = (async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message: "The model `canopylabs/orpheus-v1-english` requires terms acceptance.",
            code: "model_terms_required",
          },
        }),
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: termsFetch });
    expect(res.status).toBe(503);
    const payload = res.payload as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("TTS_TERMS");
    expect(payload.error.message).toContain("terms");
  });

  it("romanizes Devanagari before synthesis (the voice is English-only)", async () => {
    let sent = "";
    const captureFetch = (async (_url: string, init?: RequestInit) => {
      sent = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/wav" }),
        arrayBuffer: async () => wavBytes(64).buffer.slice(0),
      };
    }) as unknown as typeof fetch;
    await handleTts({ text: "नमस्ते", lang: "hi" }, { ...deps, fetchImpl: captureFetch });
    expect(sent).not.toContain("नमस्ते");
    expect(sent).toContain("namaste");
  });

  it("never lets a rejected provider status leak its body to the client", async () => {
    const leakyFetch = (async () => ({
      ok: false,
      status: 418,
      text: async () => "internal provider stack trace and key material",
    })) as unknown as typeof fetch;
    const res = await handleTts({ text: "Hello.", lang: "en" }, { ...deps, fetchImpl: leakyFetch });
    expect(JSON.stringify(res.payload)).not.toContain("stack trace");
  });
});

describe("GET /v1/health", () => {
  it("reports capability presence without secret material", async () => {
    const res = await handleHealth({ groqKeysConfigured: 2 });
    expect(res.status).toBe(200);
    const dump = JSON.stringify(res.payload);
    expect(dump).toContain('"groqKeysConfigured":2');
    expect(dump).toContain("canopylabs/orpheus-v1-english");
    expect(dump).not.toMatch(/gsk_|AIza/);
  });
});

describe("POST /v1/validation", () => {
  it("reports per-capability results with sanitized details", async () => {
    const wav = Buffer.alloc(44 + 128);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    wav.write("data", 36);
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("openai/v1/models")) {
        return okJson({
          data: [
            { id: "qwen/qwen3.8-27b" },
            { id: "openai/gpt-oss-20b" },
            { id: "whisper-large-v3-turbo" },
            { id: "canopylabs/orpheus-v1-english" },
          ],
        });
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/wav" }),
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      };
    }) as unknown as typeof fetch;
    const { handleValidation } = await import("./health.js");
    const res = await handleValidation({
      pool: new GroqKeyPool(["k1"]),
      fetchImpl,
    });
    expect(res.status).toBe(200);
    const payload = res.payload as { groq: { ok: boolean }; tts: { ok: boolean } };
    expect(payload.groq.ok).toBe(true);
    expect(payload.tts.ok).toBe(true);
  });

  it("flags a missing TTS voice as a missing-model-access failure", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("openai/v1/models")) {
        return okJson({
          data: [
            { id: "qwen/qwen3.8-27b" },
            { id: "openai/gpt-oss-20b" },
            { id: "whisper-large-v3-turbo" },
          ],
        });
      }
      throw new Error("should not synthesize when the voice is unavailable");
    }) as unknown as typeof fetch;
    const { handleValidation } = await import("./health.js");
    const res = await handleValidation({ pool: new GroqKeyPool(["k1"]), fetchImpl });
    const payload = res.payload as { groq: { ok: boolean; detail: string } };
    expect(payload.groq.ok).toBe(false);
    expect(payload.groq.detail).toContain("canopylabs/orpheus-v1-english");
  });
});
