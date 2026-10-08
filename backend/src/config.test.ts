/**
 * Config tests: env parsing, validation errors carry no secret values.
 * Groq is required (reasoning + transcription + speech); OpenRouter is an
 * optional second reasoning vendor (chat + enrichment round-robin).
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { OPENROUTER_DEFAULT_MODEL, OLLAMA_DEFAULT_MODEL } from "../../shared/constants.js";
import { configSummary, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses keys, port, and optional token", () => {
    const config = loadConfig({
      GROQ_API_KEYS: "gsk_one, gsk_two ",
      TAVILY_API_KEY: "tvly-test",
      PORT: "9999",
      BACKEND_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(config.groqKeys).toEqual(["gsk_one", "gsk_two"]);
    expect(config.tavilyKey).toBe("tvly-test");
    expect(config.port).toBe(9999);
    expect(config.backendToken).toBe("tok");
    expect(config.openrouterKey).toBe("");
    expect(config.openrouterModel).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it("parses the optional OpenRouter reasoning key + model override", () => {
    const config = loadConfig({
      GROQ_API_KEYS: "k",
      TAVILY_API_KEY: "tvly-test",
      PORT: "8787",
      OPENROUTER_API_KEY: " or-key ",
      OPENROUTER_MODEL: "some/model:free",
    } as NodeJS.ProcessEnv);
    expect(config.openrouterKey).toBe("or-key");
    expect(config.openrouterModel).toBe("some/model:free");
  });

  it("rejects missing credentials without echoing values", () => {
    let message = "";
    try {
      loadConfig({ GROQ_API_KEYS: "", TAVILY_API_KEY: "t", PORT: "8787" } as NodeJS.ProcessEnv);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("GROQ_API_KEYS");
  });

  it("rejects a missing Tavily key without echoing values", () => {
    let message = "";
    try {
      loadConfig({ GROQ_API_KEYS: "k", PORT: "8787" } as NodeJS.ProcessEnv);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("TAVILY_API_KEY");
  });

  it("boots Groq-only when OpenRouter is absent (audio always Groq)", () => {
    // OpenRouter is optional reasoning-only: Groq + Tavily boot without it,
    // and transcription + speech never need a second provider key.
    const config = loadConfig({
      GROQ_API_KEYS: "k",
      TAVILY_API_KEY: "tvly-test",
      PORT: "8787",
    } as NodeJS.ProcessEnv);
    expect(Object.keys(config).sort()).toEqual([
      "backendToken",
      "groqKeys",
      "llmProvider",
      "ollamaKeepAlive",
      "ollamaModel",
      "ollamaTimeoutMs",
      "ollamaUrl",
      "openrouterKey",
      "openrouterModel",
      "port",
      "tavilyKey",
    ]);
    expect(config.openrouterKey).toBe("");
    expect(config.ollamaUrl).toBe("");
  });

  it("additive: Ollama is optional — absent/disabled means cloud-only, never fatal", () => {
    const absent = loadConfig({
      GROQ_API_KEYS: "k",
      TAVILY_API_KEY: "t",
      PORT: "8787",
    } as NodeJS.ProcessEnv);
    expect(absent.ollamaUrl).toBe("");
    const disabled = loadConfig({
      GROQ_API_KEYS: "k",
      TAVILY_API_KEY: "t",
      PORT: "8787",
      OLLAMA_URL: "disabled",
    } as NodeJS.ProcessEnv);
    expect(disabled.ollamaUrl).toBe("");
    expect(loadConfig({ GROQ_API_KEYS: "k", TAVILY_API_KEY: "t", PORT: "8787" } as NodeJS.ProcessEnv)
      .groqKeys).toEqual(["k"]); // Groq still boots without the local provider
  });

  it("parses the local provider + provider selector, normalizing the URL", () => {
    const config = loadConfig({
      GROQ_API_KEYS: "k",
      TAVILY_API_KEY: "t",
      PORT: "8787",
      OLLAMA_URL: "http://127.0.0.1:11434/",
      OLLAMA_MODEL: "qwen3.5:9b-q4_K_M",
      LLM_PROVIDER: "ollama",
    } as NodeJS.ProcessEnv);
    expect(config.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(config.ollamaModel).toBe("qwen3.5:9b-q4_K_M");
    expect(config.llmProvider).toBe("ollama");
  });

  it("falls back to auto + the default model on a bogus selector / blank model", () => {
    const config = loadConfig({
      GROQ_API_KEYS: "k",
      TAVILY_API_KEY: "t",
      PORT: "8787",
      OLLAMA_URL: "http://127.0.0.1:11434",
      LLM_PROVIDER: "nonsense",
      OLLAMA_MODEL: "  ",
    } as NodeJS.ProcessEnv);
    expect(config.llmProvider).toBe("auto");
    expect(config.ollamaModel).toBe(OLLAMA_DEFAULT_MODEL);
  });

  it("bounds the local timeout and passes keep_alive through (Phase 2)", () => {
    const base = { GROQ_API_KEYS: "k", TAVILY_API_KEY: "t", PORT: "8787", OLLAMA_URL: "u" };
    // Measured: cold ≈60s, warm ≈1-3s → 180s default with 10s..900s bounds.
    expect(loadConfig(base as NodeJS.ProcessEnv).ollamaTimeoutMs).toBe(180_000);
    expect(
      loadConfig({ ...base, OLLAMA_TIMEOUT_MS: "900000" } as NodeJS.ProcessEnv).ollamaTimeoutMs,
    ).toBe(900_000);
    for (const bad of ["0", "5000", "9999999", "abc"]) {
      expect(
        loadConfig({ ...base, OLLAMA_TIMEOUT_MS: bad } as NodeJS.ProcessEnv).ollamaTimeoutMs,
      ).toBe(180_000);
    }
    expect(
      loadConfig({ ...base, OLLAMA_KEEP_ALIVE: "30m" } as NodeJS.ProcessEnv).ollamaKeepAlive,
    ).toBe("30m");
    expect(loadConfig(base as NodeJS.ProcessEnv).ollamaKeepAlive).toBe("");
  });

  it("rejects bad ports", () => {
    expect(() =>
      loadConfig({ GROQ_API_KEYS: "k", TAVILY_API_KEY: "t", PORT: "abc" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("summarizes without any secret or provider-name leakage", () => {
    const summary = configSummary(
      loadConfig({ GROQ_API_KEYS: "k1,k2", TAVILY_API_KEY: "t", PORT: "8787" } as NodeJS.ProcessEnv),
    );
    expect(summary["groqKeysConfigured"]).toBe(2);
    expect(summary["tavilyConfigured"]).toBe(1);
    expect(summary["openrouterConfigured"]).toBe(0);
    expect(summary["authMode"]).toBe("open-loopback-dev");
    expect(JSON.stringify(summary)).not.toContain("k1");
  });

  it("summarizes OpenRouter presence without the key value", () => {
    const summary = configSummary(
      loadConfig({
        GROQ_API_KEYS: "k",
        TAVILY_API_KEY: "t",
        PORT: "8787",
        OPENROUTER_API_KEY: "or-secret",
      } as NodeJS.ProcessEnv),
    );
    expect(summary["openrouterConfigured"]).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("or-secret");
  });
});