/**
 * Audio Controller scheduling tests: priority order, preemption, dedupe,
 * stop semantics, fallback + latch, cache, half-duplex gate state.
 * Fake backends only — no audio hardware, no network. Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import { AudioController } from "./audio-controller.js";
import type {
  FallbackBackend,
  PlayBackend,
  SynthBackend,
} from "./audio-controller.js";
import { BackendError } from "../../../shared/api.js";
import type { AudioRequest } from "../../../shared/types.js";

let reqCounter = 0;
function req(text: string, priority: 1 | 2 | 3 | 4 | 5, lang: "en" | "hi" | "mixed" = "en"): AudioRequest {
  reqCounter += 1;
  return {
    text,
    lang,
    priority,
    interruptible: priority >= 3,
    requestId: `req_${reqCounter}`,
  };
}

class FakeSynth implements SynthBackend {
  readonly name = "fake-synth";
  calls: Array<{ text: string; lang: string }> = [];
  failMode: "none" | "auth" | "error" = "none";

  async synthesize(text: string, lang: "en" | "hi" | "mixed"): Promise<Blob> {
    this.calls.push({ text, lang });
    if (this.failMode === "auth") throw new BackendError(401, "BACKEND_AUTH", "rejected");
    if (this.failMode === "error") throw new Error("synth boom");
    return new Blob(["audio-bytes"], { type: "audio/mp3" });
  }
}

interface PendingPlay {
  resolve: () => void;
  reject: (err: Error) => void;
}

class FakePlayer implements PlayBackend {
  readonly name = "fake-player";
  started = 0;
  stopped = 0;
  pending: PendingPlay[] = [];
  /** When true (default), playback completes on the next microtask. */
  auto = true;

  play(_blob: Blob): Promise<void> {
    void _blob;
    this.started += 1;
    if (this.auto) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve: () => resolve(), reject });
    });
  }

  stop(): void {
    this.stopped += 1;
    const waiting = this.pending;
    this.pending = [];
    for (const p of waiting) p.reject(new Error("stopped"));
  }

  finishOne(): void {
    const next = this.pending.shift();
    next?.resolve();
  }
}

class FakeFallback implements FallbackBackend {
  readonly name = "fake-fallback";
  spoken: Array<{ text: string; lang: string }> = [];
  stops = 0;

  async speak(text: string, lang: "en" | "hi" | "mixed"): Promise<void> {
    this.spoken.push({ text, lang });
  }

  stop(): void {
    this.stops += 1;
  }
}

function makeController(): {
  controller: AudioController;
  synth: FakeSynth;
  player: FakePlayer;
  fallback: FakeFallback;
} {
  const synth = new FakeSynth();
  const player = new FakePlayer();
  const fallback = new FakeFallback();
  const controller = new AudioController(
    synth,
    player,
    fallback,
    { beep: () => undefined },
    async () => ({ url: "http://127.0.0.1:8787" }),
  );
  return { controller, synth, player, fallback };
}

async function drained(c: AudioController): Promise<void> {
  await vi.waitFor(() => {
    expect(c.queueDepth()).toBe(0);
  });
}

describe("priority and preemption", () => {
  it("preempts interruptible lower-priority speech (safety wins)", async () => {
    const { controller, synth, player } = makeController();
    expect(controller.enqueue(req("Focus announcement.", 5))).toEqual({
      disposition: "queued",
    });
    // Synchronous second enqueue while the first is still starting.
    expect(controller.enqueue(req("Confirm submission?", 1))).toEqual({
      disposition: "preempted",
    });
    await drained(controller);
    expect(synth.calls.map((c) => c.text)).toEqual([
      "Focus announcement.",
      "Confirm submission?",
    ]);
    expect(player.stopped).toBeGreaterThanOrEqual(1);
  });

  it("plays FIFO within the same priority level", async () => {
    const { controller, player } = makeController();
    player.auto = false;
    controller.enqueue(req("First.", 4));
    controller.enqueue(req("Second.", 4));
    await vi.waitFor(() => {
      expect(player.started).toBe(1);
    });
    player.finishOne();
    await vi.waitFor(() => {
      expect(player.started).toBe(2);
    });
    player.finishOne();
    await drained(controller);
  });

  it("never preempts with equal or lower priority", async () => {
    const { controller, player } = makeController();
    controller.enqueue(req("Question?", 2));
    expect(controller.enqueue(req("Status update.", 4)).disposition).toBe("queued");
    await drained(controller);
    expect(player.started).toBe(2);
  });
});

describe("dedupe", () => {
  it("drops identical consecutive focus announcements", async () => {
    const { controller, synth } = makeController();
    expect(controller.enqueue(req("Search. Button.", 5))).toEqual({ disposition: "queued" });
    expect(controller.enqueue(req("Search. Button.", 5))).toEqual({ disposition: "deduped" });
    await drained(controller);
    expect(synth.calls.filter((c) => c.text === "Search. Button.").length).toBe(1);
  });

  it("focus interrupts focus — Tab never stacks speech", async () => {
    const { controller, synth } = makeController();
    expect(controller.enqueue(req("Email. Edit box.", 5))).toEqual({ disposition: "queued" });
    expect(controller.enqueue(req("Phone. Edit box.", 5))).toEqual({ disposition: "preempted" });
    await drained(controller);
    const spoken = synth.calls.map((c) => c.text);
    expect(spoken).toContain("Phone. Edit box.");
    expect(spoken.filter((t) => t === "Email. Edit box.").length).toBeLessThanOrEqual(1);
  });

  it("queued focus announcements collapse to the newest", async () => {
    const { controller, synth, player } = makeController();
    player.auto = false;
    controller.enqueue(req("Confirm submission?", 1)); // higher priority holds the floor
    controller.enqueue(req("Email box.", 5));
    controller.enqueue(req("Phone box.", 5));
    expect(controller.queueDepth()).toBe(2); // priority-1 + newest focus only
    await vi.waitFor(() => {
      expect(player.started).toBe(1);
    });
    player.finishOne();
    await vi.waitFor(() => {
      expect(player.started).toBe(2);
    });
    player.finishOne();
    await drained(controller);
    const spoken = synth.calls.map((c) => c.text);
    expect(spoken).toContain("Phone box.");
    expect(spoken).not.toContain("Email box.");
  });
});

describe("stop semantics", () => {
  it("stop(true) halts speech and clears the queue", async () => {
    const { controller, player } = makeController();
    player.auto = false;
    controller.enqueue(req("Long passage one.", 4));
    controller.enqueue(req("Long passage two.", 4));
    await vi.waitFor(() => {
      expect(player.started).toBe(1);
    });
    expect(controller.isSpeaking()).toBe(true);
    controller.stop(true);
    expect(controller.isSpeaking()).toBe(false);
    expect(controller.queueDepth()).toBe(0);
    player.finishOne(); // late finish must not resume anything
    await new Promise((r) => setTimeout(r, 20));
    expect(player.started).toBe(1);
  });
});

describe("fallback and latch", () => {
  it("falls back per-utterance and latches after 3 consecutive primary failures", async () => {
    const { controller, synth, fallback } = makeController();
    synth.failMode = "error";
    controller.enqueue(req("One.", 4));
    controller.enqueue(req("Two.", 4));
    controller.enqueue(req("Three.", 4));
    await drained(controller);
    expect(fallback.spoken.length).toBe(3);
    expect(controller.isPrimaryLatchedOff()).toBe(true);

    const callsBefore = synth.calls.length;
    controller.enqueue(req("Four.", 4));
    await drained(controller);
    expect(synth.calls.length).toBe(callsBefore); // latched: primary not attempted
    expect(fallback.spoken.length).toBe(4);
  });

  it("single failure does not latch; next utterance retries primary", async () => {
    const { controller, synth, fallback } = makeController();
    synth.failMode = "error";
    controller.enqueue(req("One.", 4));
    await drained(controller);
    expect(controller.isPrimaryLatchedOff()).toBe(false);
    synth.failMode = "none";
    controller.enqueue(req("Two.", 4));
    await drained(controller);
    expect(fallback.spoken.length).toBe(1);
    expect(synth.calls.length).toBe(2);
  });
});

describe("cache", () => {
  it("synthesizes repeated non-focus text once", async () => {
    const { controller, synth } = makeController();
    controller.enqueue(req("Task complete.", 4));
    await drained(controller);
    controller.enqueue(req("Task complete.", 4));
    await drained(controller);
    expect(synth.calls.length).toBe(1);
    expect(controller.cacheSize()).toBe(1);
  });
});

describe("half-duplex gate state", () => {
  it("isSpeaking tracks real playback", async () => {
    const { controller, player } = makeController();
    player.auto = false;
    expect(controller.isSpeaking()).toBe(false);
    controller.enqueue(req("Something to say.", 4));
    await vi.waitFor(() => {
      expect(player.started).toBe(1);
    });
    expect(controller.isSpeaking()).toBe(true);
    player.finishOne();
    await drained(controller);
    expect(controller.isSpeaking()).toBe(false);
  });
});

describe("mixed-language routing", () => {
  it("synthesizes Devanagari spans with hi and the rest with en", async () => {
    const { controller, synth } = makeController();
    controller.enqueue(req("Hello दुनिया test", 4, "mixed"));
    await drained(controller);
    expect(synth.calls).toEqual([
      { text: "Hello", lang: "en" },
      { text: "दुनिया", lang: "hi" },
      { text: "test", lang: "en" },
    ]);
  });
});
