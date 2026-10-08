/**
 * Phase 0 shared-contract tests. Must be green for the Phase 0 exit gate.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  isExtensionMessage,
  validateStructuredAction,
} from "./types.js";
import {
  ERROR_CODES,
  ERROR_SPEECH,
  getErrorSpeech,
  isKnownMessageType,
} from "./messages.js";
import {
  MAX_ACTIONS_PER_TASK,
  MAX_TASK_DURATION_MS,
  SESSION_QUOTA_BYTES,
  TTS_MAX_BYTES_PER_REQUEST,
  WAITING_FOR_CONFIRMATION_TTL_MS,
} from "./constants.js";
import { REDACTED, redactObject, redactString } from "./redact.js";

describe("extension message envelope", () => {
  it("accepts a well-formed message", () => {
    expect(
      isExtensionMessage({
        type: "FOCUS_CHANGED",
        requestId: "req_1",
        tabId: 42,
        payload: {},
      }),
    ).toBe(true);
  });

  it("rejects unknown-shape messages", () => {
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage({ type: "X" })).toBe(false);
    expect(
      isExtensionMessage({ type: "X", requestId: "", payload: {} }),
    ).toBe(false);
    expect(
      isExtensionMessage({ type: "X", requestId: "r", payload: [] }),
    ).toBe(false);
  });

  it("registry covers the PRD 4 §73 vocabulary used by routers", () => {
    for (const t of ["CANCEL_TASK", "TTS_SPEAK", "VOICE_TRANSCRIPT"]) {
      expect(isKnownMessageType(t)).toBe(true);
    }
    expect(isKnownMessageType("ACTION_EXECUTE_JAVASCRIPT")).toBe(false);
  });
});

describe("structured action validation (PRD 6 §5)", () => {
  it("accepts a valid click with expect", () => {
    const r = validateStructuredAction({
      action: "click",
      target: "e37",
      pageGeneration: 42,
      expect: { type: "element_present", target: "e52" },
      timeout_ms: 3000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown action types", () => {
    const r = validateStructuredAction({
      action: "execute_javascript",
      target: "e1",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects malformed targets", () => {
    expect(
      validateStructuredAction({ action: "click", target: "submit-btn" }).ok,
    ).toBe(false);
    expect(validateStructuredAction({ action: "click" }).ok).toBe(false);
  });

  it("rejects negative page generations and out-of-range timeouts", () => {
    expect(
      validateStructuredAction({
        action: "click",
        target: "e1",
        pageGeneration: -1,
      }).ok,
    ).toBe(false);
    expect(
      validateStructuredAction({
        action: "click",
        target: "e1",
        timeout_ms: 50,
      }).ok,
    ).toBe(false);
  });

  it("rejects javascript: navigation (arbitrary-code front door)", () => {
    const r = validateStructuredAction({
      action: "navigate",
      parameters: { url: "javascript:alert(1)" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/scheme/);
  });

  it("rejects non-allowlisted keys and all modifiers", () => {
    expect(
      validateStructuredAction({
        action: "press_key",
        target: "e1",
        parameters: { key: "F5" },
      }).ok,
    ).toBe(false);
    expect(
      validateStructuredAction({
        action: "press_key",
        target: "e1",
        parameters: { key: "T", modifiers: ["Ctrl"] },
      }).ok,
    ).toBe(false);
    expect(
      validateStructuredAction({
        action: "press_key",
        target: "e1",
        parameters: { key: "Enter" },
      }).ok,
    ).toBe(true);
  });

  it("rejects oversized type values", () => {
    expect(
      validateStructuredAction({
        action: "type",
        target: "e41",
        value: "x".repeat(2001),
      }).ok,
    ).toBe(false);
  });

  it("requires option resolution for select", () => {
    expect(
      validateStructuredAction({ action: "select", target: "e9" }).ok,
    ).toBe(false);
    expect(
      validateStructuredAction({
        action: "select",
        target: "e9",
        parameters: { option: { by: "label", ref: "Email" } },
      }).ok,
    ).toBe(true);
  });

  // Prose regions (rNN) are readable body text, so `read` may target them.
  // They must never be a target for anything with side effects.
  it("accepts a prose region id for read", () => {
    for (const target of ["r1", "r2", "r42"]) {
      expect(validateStructuredAction({ action: "read", target }).ok).toBe(true);
    }
  });

  it("refuses a prose region id for any side-effecting action", () => {
    for (const action of ["click", "type", "focus", "select", "scroll", "press_key"]) {
      const result = validateStructuredAction({ action, target: "r1" });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("eNN");
    }
  });

  it("still rejects selectors, urls and expressions as targets", () => {
    for (const target of [
      "#main",
      "div.content",
      "javascript:alert(1)",
      "https://evil.example",
      "e1, e2",
      "E1",
      "r",
      "r1a",
      "",
    ]) {
      expect(validateStructuredAction({ action: "read", target }).ok).toBe(false);
    }
  });

  it("still requires a target on read", () => {
    expect(validateStructuredAction({ action: "read" }).ok).toBe(false);
  });
});

describe("redaction", () => {
  it("masks card-length digit runs", () => {
    expect(redactString("card 4111111111111111 here")).toContain(REDACTED);
    expect(redactString("card 4111111111111111 here")).not.toContain("4111");
  });

  it("redacts secret-named keys deeply", () => {
    const out = redactObject({
      taskId: "task_1",
      password: "Cx9!qW-canary-01",
      nested: { otp: "000000", note: "hello" },
    }) as Record<string, unknown>;
    expect(out["password"]).toBe(REDACTED);
    expect((out["nested"] as Record<string, unknown>)["otp"]).toBe(REDACTED);
    expect(out["taskId"]).toBe("task_1");
    expect((out["nested"] as Record<string, unknown>)["note"]).toBe("hello");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactString("Search. Button.")).toBe("Search. Button.");
  });

  it("matches whole key words only, never substrings", () => {
    const out = redactObject({
      authMode: "bearer",
      author: "mehul",
      discard: "pile",
      monkey: "business",
      groqKeys: ["gsk_secret"],
      providerApiKey: "AIza-secret",
    }) as Record<string, unknown>;
    expect(out["authMode"]).toBe("bearer");
    expect(out["author"]).toBe("mehul");
    expect(out["discard"]).toBe("pile");
    expect(out["monkey"]).toBe("business");
    expect(out["groqKeys"]).toBe(REDACTED);
    expect(out["providerApiKey"]).toBe(REDACTED);
  });

  it("preserves metadata counts even on sensitive stems (live-log proof)", () => {
    const out = redactObject({
      groqKeysConfigured: 2,
      ttsConfigured: true,
      authMode: "bearer",
    }) as Record<string, unknown>;
    expect(out["groqKeysConfigured"]).toBe(2);
    expect(out["ttsConfigured"]).toBe(true);
    expect(out["authMode"]).toBe("bearer");
  });
});

describe("bilingual error catalog", () => {
  it("covers every code in EN and HI with non-empty strings", () => {
    expect(ERROR_CODES.length).toBe(16);
    for (const code of ERROR_CODES) {
      expect(ERROR_SPEECH[code]["en"].length).toBeGreaterThan(0);
      expect(ERROR_SPEECH[code]["hi"].length).toBeGreaterThan(0);
    }
  });

  it("serves the exact inaccessible-page strings", () => {
    expect(getErrorSpeech("CANNOT_ACCESS_PAGE", "en")).toBe(
      "I can't access this page.",
    );
    expect(getErrorSpeech("CANNOT_ACCESS_PAGE", "hi")).toBe(
      "मैं इस पेज तक नहीं पहुँच सकता।",
    );
  });
});

describe("pinned constants sanity", () => {
  it("budgets and caps are positive and ordered", () => {
    expect(MAX_ACTIONS_PER_TASK).toBe(25);
    expect(MAX_TASK_DURATION_MS).toBeGreaterThan(0);
    expect(WAITING_FOR_CONFIRMATION_TTL_MS).toBe(90_000);
    expect(SESSION_QUOTA_BYTES).toBe(10_485_760);
    expect(TTS_MAX_BYTES_PER_REQUEST).toBeLessThanOrEqual(5000);
  });
});
