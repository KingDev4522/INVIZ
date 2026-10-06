/**
 * Canary-leak suite (PRD 6.6 §1.1; PRD 5 §37–40).
 * Synthetic secrets are driven through the real sensitive-value flows; every
 * surface that must never carry them is asserted empty of them. One grep-able
 * occurrence anywhere below = phase failure.
 * Run: npm test
 */
import { afterEach, describe, expect, it } from "vitest";
import { AgentController } from "../background/agent-controller/controller.js";
import { buildConfirmationSpeech } from "../background/agent-controller/controller.js";
import { serializePage } from "../ai/context-budget.js";
import { ENDPOINTS } from "../../../shared/api.js";
import { ERROR_SPEECH, ERROR_CODES } from "../../../shared/messages.js";
import { redactString } from "../../../shared/redact.js";
import {
  setTelemetryEnabled,
  trackEvent,
} from "../../../shared/logger.js";
import type { AgentOutcome } from "../../../shared/types.js";
import type { TaskSnapshot } from "../background/task-state/store.js";

const PASSWORD_CANARY = "Cx9!qW-canary-01";
const OTP_CANARY = "000000";
const CARD_CANARY = "4111111111111111";

const SECRET_ITEMS = [
  { id: "e1", role: "link", name: "Open form", states: {}, fieldKind: null, sensitive: false },
  { id: "e4", role: "textbox", name: "One-time code", states: {}, fieldKind: "text", sensitive: true },
  { id: "e5", role: "textbox", name: "Password", states: {}, fieldKind: "password", sensitive: true },
];

function consoleSpy(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const methods = ["log", "warn", "error"] as const;
  const originals = methods.map((m) => console[m]);
  console.log = (...args: unknown[]) => {
    calls.push(JSON.stringify(args));
  };
  console.warn = (...args: unknown[]) => {
    calls.push(JSON.stringify(args));
  };
  console.error = (...args: unknown[]) => {
    calls.push(JSON.stringify(args));
  };
  return {
    calls,
    restore: () => {
      console.log = originals[0] ?? console.log;
      console.warn = originals[1] ?? console.warn;
      console.error = originals[2] ?? console.error;
    },
  };
}

describe("canary containment", () => {
  afterEach(() => {
    setTelemetryEnabled(false);
  });

  it("spoken confirmation never carries model-echoed secrets for sensitive targets", () => {
    const sensitive = {
      id: "e5",
      role: "textbox",
      name: "Password",
      fieldKind: "password",
      sensitive: true,
      isSubmit: false,
    };
    const speech = buildConfirmationSpeech(
      { action: "type", target: "e5" },
      sensitive,
      `Filling password ${PASSWORD_CANARY} now`,
      "en",
    );
    expect(speech).not.toContain(PASSWORD_CANARY);
    expect(speech).toContain("sensitive field");

    const ordinary = { ...sensitive, sensitive: false, name: "Email", fieldKind: "email" };
    const ordinarySpeech = buildConfirmationSpeech(
      { action: "type", target: "e3" },
      ordinary,
      "Filling the email field",
      "en",
    );
    expect(ordinarySpeech).toContain("Filling the email field"); // context kept
  });

  it("error catalog strings are canary-free by construction", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_SPEECH[code]["en"]).toBe(redactString(ERROR_SPEECH[code]["en"]));
      expect(ERROR_SPEECH[code]["hi"]).toBe(redactString(ERROR_SPEECH[code]["hi"]));
    }
  });

  it("Layer-A serialization carries states, never values", () => {
    const out = serializePage({
      url: "https://example.com/",
      title: "T",
      generation: 1,
      items: SECRET_ITEMS,
      headings: [],
      landmarks: [],
      forms: [],
    });
    expect(out.text).not.toMatch(/"value"/);
    expect(out.text).toContain("Password"); // names identify; values never exist
  });

  it("telemetry redacts secret-shaped metadata even when enabled", () => {
    const spy = consoleSpy();
    try {
      setTelemetryEnabled(true);
      trackEvent("action_executed", {
        taskId: "task_1",
        targetId: "e5",
        password: PASSWORD_CANARY,
        card: CARD_CANARY,
      });
      const dump = spy.calls.join("\n");
      expect(dump).not.toContain(PASSWORD_CANARY);
      expect(dump).not.toContain(CARD_CANARY);
      expect(dump).toContain("action_executed"); // metadata survives
    } finally {
      spy.restore();
      setTelemetryEnabled(false);
    }
  });

  it("full sensitive fill leaks nothing to snapshots, logs, or model input", async () => {
    const spy = consoleSpy();
    const saved: TaskSnapshot[] = [];
    let current: TaskSnapshot | null = null;
    const getCurrent = (): TaskSnapshot | null => current;
    const reasonPayloads: string[] = [];
    try {
      const controller = new AgentController({
        backend: { url: "http://127.0.0.1:8787" },
        reason: async (input) => {
          reasonPayloads.push(input.userPayload);
          if (reasonPayloads.length === 1) {
            const outcome: AgentOutcome = {
              type: "ask_user",
              question: "What is the code?",
              field: "One-time code",
              sensitivity: "high",
            };
            return outcome;
          }
          return { type: "task_complete" };
        },
        executeFn: async () => ({
          status: "executed",
          action: "type",
          target: "e4",
          pageGeneration: 1,
          timestamp: 1,
        }),
        verifyFn: async () => ({
          success: true,
          outcome: "VERIFIED_SUCCESS",
          expected: {},
          observed: null,
          timedOut: false,
          pageGeneration: 1,
        }),
        speak: async () => undefined,
        stopAudio: async () => undefined,
        setAgentActive: async () => undefined,
        loadSnapshot: async () => ({
          url: "https://example.com/",
          title: "T",
          generation: 1,
          items: SECRET_ITEMS,
        }),
        loadLayerB: async () => ({
          interpretation: "x",
          pageGeneration: 1,
          producedAt: Date.now(),
          provenance: "MODEL_INFERENCE" as const,
        }),
        saveLayerB: async () => undefined,
        store: {
          load: async () => current,
          save: async (s) => {
            current = { ...s };
            saved.push(JSON.parse(JSON.stringify(s)) as TaskSnapshot);
          },
          clear: async () => {
            current = null;
          },
        },
      });
      await controller.routeVoice(
        { text: "Fill the login.", lang: "en", source: "voice", timestamp: 1 },
        7,
      );
      await controller.routeVoice(
        { text: OTP_CANARY, lang: "en", source: "voice", timestamp: 2 },
        7,
      );
      expect(getCurrent()?.status).toBe("COMPLETE");
      const snapshotDump = JSON.stringify(saved);
      expect(snapshotDump).not.toContain(OTP_CANARY);
      expect(reasonPayloads.join("\n")).not.toContain(OTP_CANARY);
      expect(spy.calls.join("\n")).not.toContain(OTP_CANARY);
    } finally {
      spy.restore();
    }
  });

  it("backend contract exposes same-origin paths only (keys cannot leak by URL)", () => {
    // Positive property (stronger than any denylist): every contract path is
    // a same-origin /v1/* route. Provider endpoints therefore cannot appear.
    for (const route of Object.values(ENDPOINTS)) {
      expect(route.startsWith("/v1/")).toBe(true);
    }
  });
});
