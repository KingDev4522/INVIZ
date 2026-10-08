/**
 * Q&A + element-find tests with a fake reasoner (PRD 6.4 §1.6).
 * Grounding honesty is asserted here; model quality is a live concern.
 * Run: npm test
 */
import { describe, expect, it, vi } from "vitest";
import { answerQuestion, findElement } from "./qa.js";
import { reasonOnce } from "./qwen-client.js";
import { GroqKeyPool } from "../gateway/gateway.js";
import type { AgentOutcome } from "../../../shared/types.js";

type ReasonFn = typeof reasonOnce;

function depsFor(outcome: AgentOutcome | Error): {
  pool: GroqKeyPool;
  reason: ReasonFn;
  calls: number;
} {
  const state = { calls: 0 };
  const reason = (async () => {
    state.calls += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as ReasonFn;
  return { pool: new GroqKeyPool(["k1"]), reason, calls: 0 };
}

const CANDIDATES = [
  { id: "e1", role: "link", name: "Login" },
  { id: "e2", role: "button", name: "Apply Now" },
  { id: "e3", role: "button", name: "Help" },
];

describe("answerQuestion", () => {
  it("returns grounded answer text", async () => {
    const deps = depsFor({ type: "answer", text: "This page is a job application form." });
    const answer = await answerQuestion(
      { question: "What is this page about?", lang: "en", pageText: "PAGE…" },
      deps,
    );
    expect(answer).toBe("This page is a job application form.");
  });

  it("rejects non-answer and empty outcomes instead of speaking them", async () => {
    const deps = depsFor({ type: "action", action: { action: "click", target: "e1" } });
    await expect(
      answerQuestion({ question: "Q?", lang: "en", pageText: "P" }, deps),
    ).rejects.toThrow();
    const empty = depsFor({ type: "answer", text: "   " });
    await expect(
      answerQuestion({ question: "Q?", lang: "en", pageText: "P" }, empty),
    ).rejects.toThrow();
  });
});

describe("findElement", () => {
  it("returns the registry ID when grounded", async () => {
    const deps = depsFor({ type: "answer", text: "e2" });
    await expect(
      findElement(
        { query: "application button", lang: "en", pageText: "P", candidates: CANDIDATES },
        deps,
      ),
    ).resolves.toBe("e2");
  });

  it("returns null on NO_MATCH (honesty path, PRD 2 §20)", async () => {
    const deps = depsFor({ type: "answer", text: "NO_MATCH" });
    await expect(
      findElement(
        { query: "unicorn button", lang: "en", pageText: "P", candidates: CANDIDATES },
        deps,
      ),
    ).resolves.toBeNull();
  });

  it("rejects invented IDs instead of passing them on", async () => {
    const deps = depsFor({ type: "answer", text: "e99" });
    await expect(
      findElement(
        { query: "application button", lang: "en", pageText: "P", candidates: CANDIDATES },
        deps,
      ),
    ).resolves.toBeNull();
  });

  it("short-circuits empty candidate sets without calling the model", async () => {
    const spyReason = vi.fn(async () => ({ type: "answer", text: "e1" }) as AgentOutcome);
    const result = await findElement(
      { query: "x", lang: "en", pageText: "P", candidates: [] },
      { pool: new GroqKeyPool(["k1"]), reason: spyReason as ReasonFn },
    );
    expect(result).toBeNull();
    expect(spyReason).not.toHaveBeenCalled();
  });
});
