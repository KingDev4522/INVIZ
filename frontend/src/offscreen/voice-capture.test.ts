/**
 * SilenceDetector + rms tests (PRD 6.3 §3.1). Synthetic energy sequences —
 * no microphone needed. Run: npm test
 */
import { describe, expect, it } from "vitest";
import { SilenceDetector, decideTick, rms } from "./voice-capture.js";

describe("rms", () => {
  it("computes root-mean-square energy", () => {
    expect(rms([])).toBe(0);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([1, 1, 1, 1])).toBeCloseTo(1, 6);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 6);
  });
});

describe("SilenceDetector", () => {
  it("never stops on leading silence (user thinking first)", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    for (let t = 0; t < 10000; t += 100) {
      expect(vad.push(0.001, t)).toBe("listening");
    }
  });

  it("fires silence-stop 1.5s after speech ends, exactly once", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    expect(vad.push(0.2, 100)).toBe("speech");
    expect(vad.push(0.001, 500)).toBe("listening");
    expect(vad.push(0.001, 1599)).toBe("listening");
    expect(vad.push(0.001, 1600)).toBe("silence-stop");
    expect(vad.push(0.001, 5000)).toBe("listening"); // fires once
  });

  it("resets the silence clock on new speech", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    vad.push(0.2, 100);
    vad.push(0.001, 1000);
    expect(vad.push(0.3, 1400)).toBe("speech");
    expect(vad.push(0.001, 2800)).toBe("listening");
    expect(vad.push(0.001, 2900)).toBe("silence-stop");
  });

  it("respects custom thresholds", () => {
    const vad = new SilenceDetector(500, 0.5);
    vad.reset(0);
    expect(vad.push(0.2, 100)).toBe("listening"); // below threshold
    expect(vad.push(0.6, 200)).toBe("speech");
    expect(vad.push(0.1, 800)).toBe("silence-stop");
  });
});

// Regression: the warmup window used to swallow the VAD entirely, so a user
// who started talking over the listening earcon never latched. The turn then
// ran to the 60s hard cap and was discarded as "empty" — which is exactly
// what broke short confirmations like "yes" / "no".
describe("decideTick warmup handling", () => {
  const base = { warmupMs: 450, onsetTimeoutMs: 3000, threshold: 0.02 };

  function tick(
    detector: SilenceDetector,
    energy: number,
    nowMs: number,
    heardAfterWarmup = false,
    lastTickMs = nowMs - 100,
  ) {
    return decideTick({
      energy,
      nowMs,
      startedAtMs: 0,
      lastTickMs,
      detector,
      heardAfterWarmup,
      ...base,
    });
  }

  it("does not count warmup energy as effective speech", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    const r = tick(vad, 0.2, 100);
    expect(r.effectiveDeltaMs).toBe(0); // inside warmup
    expect(r.heardAfterWarmup).toBe(false);
  });

  it("still latches the VAD on speech during warmup", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    const r = tick(vad, 0.2, 100);
    expect(r.verdict).toBe("speech");
    expect(vad.heardSpeech).toBe(true); // may now stop on silence
  });

  it("lets warmup speech reach the silence-stop path", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    tick(vad, 0.2, 100); // speech over the earcon
    expect(tick(vad, 0.001, 1700).verdict).toBe("silence-stop");
  });

  it("counts and marks speech after the warmup window", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    const r = tick(vad, 0.2, 600, false, 500);
    expect(r.effectiveDeltaMs).toBe(100);
    expect(r.heardAfterWarmup).toBe(true);
  });

  it("stops promptly when nothing is ever heard", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    // Still inside the onset window.
    expect(tick(vad, 0.001, 3000).onsetTimedOut).toBe(false);
    // Past warmup + onsetTimeout: give up instead of waiting 60s.
    expect(tick(vad, 0.001, 3500).onsetTimedOut).toBe(true);
  });

  it("does not let earcon-only noise hold the turn open", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    // Loud only during warmup (the earcon), silent afterwards.
    tick(vad, 0.5, 100);
    const r = tick(vad, 0.001, 3500);
    expect(r.onsetTimedOut).toBe(true); // warmup noise never counted
  });

  it("stays open once real speech has been heard", () => {
    const vad = new SilenceDetector(1500, 0.02);
    vad.reset(0);
    tick(vad, 0.2, 600);
    expect(tick(vad, 0.001, 3500, true).onsetTimedOut).toBe(false);
  });
});
