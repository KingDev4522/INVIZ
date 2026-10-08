/**
 * INVIZ_AI_TRACE redaction + gating tests.
 *
 * The trace is a debugging facility: it must be OFF unless explicitly
 * enabled, and must never print secrets, typed values, or image bytes even
 * when ON. These tests pin both properties.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTraceEnabled, sanitizeOutcome, traceRequestSeen } from "./trace.js";

afterEach(() => {
  delete process.env["INVIZ_AI_TRACE"];
  vi.restoreAllMocks();
});

describe("aiTraceEnabled", () => {
  it("defaults to OFF (unset, empty, or anything but exactly true)", () => {
    delete process.env["INVIZ_AI_TRACE"];
    expect(aiTraceEnabled()).toBe(false);
    process.env["INVIZ_AI_TRACE"] = "";
    expect(aiTraceEnabled()).toBe(false);
    process.env["INVIZ_AI_TRACE"] = "1";
    expect(aiTraceEnabled()).toBe(false);
  });

  it("enables only on exactly true", () => {
    process.env["INVIZ_AI_TRACE"] = "true";
    expect(aiTraceEnabled()).toBe(true);
  });
});

describe("trace output redaction", () => {
  it("prints nothing when disabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    delete process.env["INVIZ_AI_TRACE"];
    traceRequestSeen({
      provider: "ollama",
      model: "m",
      contextMode: "dom",
      userPayload: "[USER INTENT]\ngo\n\n[VERIFIED PAGE STATE]\ne1 button \"Go\"",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("prints metadata + registry excerpt but never image bytes when enabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env["INVIZ_AI_TRACE"] = "true";
    const b64 = "aGVsbG8=".repeat(100);
    traceRequestSeen({
      turnId: "t1",
      provider: "ollama",
      model: "m",
      contextMode: "hybrid",
      userPayload: `[USER INTENT, lang=en]\nUser goal: go\n\n[VERIFIED PAGE STATE]\nPAGE x\ne1 button "Go"\n${b64}`,
      imageMeta: { width: 10, height: 10, bytes: 8 },
    });
    expect(spy).toHaveBeenCalled();
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("image=true");
    expect(out).toContain("e1 button");
    expect(out).not.toContain(b64.slice(0, 32));
  });

  it("sanitizeOutcome redacts typed values and truncates text", () => {
    const clean = sanitizeOutcome({
      type: "action",
      action: { action: "type", target: "e1", value: "s3cr3t-pw", pageGeneration: 1 },
    }) as { action: Record<string, unknown> };
    expect(clean["action"]?.["target"]).toBe("e1");
    expect(clean["action"]?.["value"]).toBe("<redacted>");
    const long = sanitizeOutcome({ type: "answer", text: "x".repeat(2000) }) as { text: string };
    expect(long["text"].length).toBeLessThan(2000);
    expect(long["text"]).toContain("truncated");
  });
});
