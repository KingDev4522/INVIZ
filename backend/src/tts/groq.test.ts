/**
 * Groq TTS tests (verified REST contract).
 * Request shape, WAV handling, Devanagari romanization, and the error mapping
 * that lets the Options page tell a rate limit from an unaccepted-terms
 * account state.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  buildGroqSpeechRequest,
  isWavContainer,
  synthesizeChunk,
  TtsAuthError,
  TtsRequestError,
  TtsTermsError,
  wavWrap,
} from "./groq-tts.js";
import { TTS_MODEL, TTS_RESPONSE_FORMAT, TTS_VOICE } from "../../../shared/constants.js";
import { GroqKeyPool } from "../gateway/gateway.js";

const POOL = new GroqKeyPool(["k1"]);

function wavBytes(sampleBytes = 128): Uint8Array {
  const out = new Uint8Array(44 + sampleBytes);
  const view = new DataView(out.buffer);
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + sampleBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  ascii(36, "data");
  view.setUint32(40, sampleBytes, true);
  return out;
}

describe("groq speech request shape", () => {
  it("targets the pinned voice on the OpenAI-compatible speech endpoint", () => {
    const req = buildGroqSpeechRequest("Hello.");
    expect(req.model).toBe("canopylabs/orpheus-v1-english");
    expect(req.model).toBe(TTS_MODEL);
    expect(req.input).toBe("Hello.");
    expect(req.voice).toBe(TTS_VOICE);
    expect(req.response_format).toBe(TTS_RESPONSE_FORMAT);
  });

  it("sends no provider-specific fields beyond the shared contract", () => {
    expect(Object.keys(buildGroqSpeechRequest("x")).sort()).toEqual([
      "input",
      "model",
      "response_format",
      "voice",
    ]);
  });

  it("never wraps the text in a prompt preamble", () => {
    expect(buildGroqSpeechRequest("Read this aloud.").input).toBe("Read this aloud.");
  });
});

describe("wavWrap", () => {
  it("emits a valid RIFF/WAVE header", () => {
    const pcm = new Uint8Array(100).fill(3);
    const wav = wavWrap(pcm, 24000);
    expect(wav.length).toBe(44 + 100);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(100);
  });

  it("recognizes a container and rejects bare PCM", () => {
    expect(isWavContainer(wavBytes())).toBe(true);
    expect(isWavContainer(new Uint8Array(200).fill(1))).toBe(false);
    expect(isWavContainer(new Uint8Array(4))).toBe(false);
  });
});

describe("synthesizeChunk", () => {
  it("returns a playable WAV blob", async () => {
    const wav = wavBytes();
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/wav" }),
      arrayBuffer: async () => wav.buffer.slice(0),
    })) as unknown as typeof fetch;
    const blob = await synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl });
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(wav.length);
  });

  it("wraps a bare PCM response", async () => {
    const pcm = new Uint8Array(200).fill(9);
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/pcm" }),
      arrayBuffer: async () => pcm.buffer.slice(0),
    })) as unknown as typeof fetch;
    const blob = await synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl });
    expect(blob.size).toBe(44 + 200);
  });

  it("romanizes Devanagari for this English-only voice", async () => {
    let sentBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/wav" }),
        arrayBuffer: async () => wavBytes(32).buffer.slice(0),
      };
    }) as unknown as typeof fetch;
    await synthesizeChunk("नमस्ते दुनिया", "hi", { pool: POOL }, { fetchImpl });
    expect(sentBody).not.toMatch(/[\u0900-\u097F]/);
    expect(sentBody).toContain("namaste");
  });

  it("leaves English text untouched", async () => {
    let sentBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/wav" }),
        arrayBuffer: async () => wavBytes(32).buffer.slice(0),
      };
    }) as unknown as typeof fetch;
    await synthesizeChunk("Hello world", "en", { pool: POOL }, { fetchImpl });
    expect(JSON.parse(sentBody).input).toBe("Hello world");
  });

  it("authorizes with a bearer token and the speech endpoint", async () => {
    let url = "";
    let auth = "";
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = String(u);
      auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/wav" }),
        arrayBuffer: async () => wavBytes(32).buffer.slice(0),
      };
    }) as unknown as typeof fetch;
    await synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl });
    expect(url).toContain("/audio/speech");
    expect(auth).toBe("Bearer k1");
  });

  it("raises an auth error when the key is rejected", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid key",
    })) as unknown as typeof fetch;
    await expect(
      synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TtsAuthError);
  });

  it("raises a rate-limit error on 429", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    })) as unknown as typeof fetch;
    await expect(
      synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TtsRequestError);
  });

  it("raises the dedicated terms error on model_terms_required", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: { code: "model_terms_required", message: "requires terms acceptance" },
        }),
    })) as unknown as typeof fetch;
    await expect(
      synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TtsTermsError);
  });

  it("detects the terms block even without the machine-readable code", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "This model requires terms acceptance." } }),
    })) as unknown as typeof fetch;
    await expect(
      synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TtsTermsError);
  });

  it("rejects empty audio instead of returning silence", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/wav" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    await expect(
      synthesizeChunk("Hello.", "en", { pool: POOL }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TtsRequestError);
  });

  it("fails honestly when the pool has no usable key", async () => {
    const emptyPool = new GroqKeyPool([]);
    await expect(
      synthesizeChunk("Hello.", "en", { pool: emptyPool }),
    ).rejects.toBeInstanceOf(TtsAuthError);
  });
});