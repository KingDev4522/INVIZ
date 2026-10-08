// @vitest-environment happy-dom
/**
 * EXPERIMENTAL (CONTEXT_MODE=hybrid): DOM vs HYBRID benchmark — Phase 10.
 *
 * GATED: runs ONLY with INVIZ_BENCH=1 (never in the normal suite — it makes
 * real Ollama inference calls and takes minutes). Usage from repo root:
 *
 *   npm run test-page &          # serve test-page/ on :8080 (screenshots need it)
 *   INVIZ_BENCH=1 npx vitest run src/ai/hybrid-benchmark.test.ts
 *     --workspace=frontend  (or: cd frontend && INVIZ_BENCH=1 npx vitest run src/ai/hybrid-benchmark.test.ts)
 *
 * What it measures, per task × {dom, hybrid}:
 *   valid schema % | correct target % | hallucinated target % | wrong-target %
 *   | non-action % | re-ask % | latency
 *
 * Honesty notes (read before citing numbers):
 * - Context building uses the REAL code (ContextLens.extract, serializePage,
 *   serializeRegistry, buildUserPayload) in happy-dom. Ground truth eNN ids
 *   are resolved at runtime via lens.identify(), never hardcoded.
 * - Screenshots are REAL headless-Chrome renders (test-page/bench/*.png),
 *   regenerated with: chrome --headless --screenshot --window-size=1280,800.
 * - The MODEL REQUEST mirrors backend/src/ai/qwen-client.ts localChatBody +
 *   gateway/ollama.ts EXACTLY (system prompt + hybrid suffix, images[] on the
 *   user message, think:false, format:"json", single attempt + one corrective
 *   re-ask). It bypasses the backend HTTP server only to avoid restarting the
 *   operator's running backend to flip CONTEXT_MODE.
 * - Deviation: production ships JPEG q0.6 (≤1024px); the bench ships the PNG
 *   screenshot as-is (15–28 KB, far under the 1.5M-char transport cap), because
 *   Node has no JPEG encoder without new dependencies.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextLens } from "../content/contextlens/index.js";
import { serializePage } from "./context-budget.js";
import { serializeRegistry } from "./hybrid-registry.js";
import { buildUserPayload } from "../../../shared/api.js";
import {
  validateModelOutput,
  ModelOutputError,
} from "../../../shared/response-validator.js";
import {
  SYSTEM_PROMPT_V2,
  HYBRID_SYSTEM_SUFFIX_V1,
} from "../../../backend/src/ai/schemas.js";

const RUN = process.env["INVIZ_BENCH"] === "1";
const OLLAMA_URL = (process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "qwen3.5:9b-q4_K_M";
const BENCH_DIR = path.resolve(process.cwd(), "..", "test-page", "bench");
const OUT_DIR = path.join(BENCH_DIR, "out");

interface BenchTask {
  id: string;
  prompt: string;
  expectBench: string;
  category: string;
}
interface BenchPage {
  file: string;
  shot: string;
  tasks: BenchTask[];
}

interface ArmResult {
  taskId: string;
  arm: "dom" | "hybrid";
  category: string;
  expectedId: string;
  /** Whether the expected id is even visible in THIS arm's page text. */
  expectedInText: boolean;
  valid: boolean;
  outcomeType: string;
  target: string | null;
  correct: boolean;
  hallucinated: boolean;
  wrongTarget: boolean;
  reAsks: number;
  latencyMs: number;
  error?: string;
}

function readPngSize(buf: Buffer): { width: number; height: number } {
  // Minimal IHDR parse (zero-dep): width/height are BE u32 at offsets 16/20.
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG file");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function ollamaChat(
  messages: Array<Record<string, unknown>>,
): Promise<{ content: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      format: "json",
      keep_alive: "30m",
      messages,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { message?: { content?: unknown } };
  const content = data.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Ollama returned empty content");
  }
  return { content, ms };
}

/**
 * One reasoning turn with the production contract policy: a single attempt,
 * then at most ONE corrective re-ask on a rejected reply (mirrors
 * CONTRACT_ATTEMPTS=2 in backend/src/ai/qwen-client.ts).
 */
async function reasonTurn(
  messages: Array<Record<string, unknown>>,
): Promise<{ outcome: ReturnType<typeof validateModelOutput>; reAsks: number; ms: number }> {
  let reAsks = 0;
  let ms = 0;
  let current = messages;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ollamaChat(current);
    ms += res.ms;
    try {
      return { outcome: validateModelOutput(res.content), reAsks, ms };
    } catch (err) {
      if (err instanceof ModelOutputError && attempt === 0) {
        reAsks = 1;
        const lastMessage = messages[messages.length - 1] as Record<string, unknown> | undefined;
        const lastContent = String(lastMessage?.["content"] ?? "");
        current = [
          ...messages.slice(0, -1),
          {
            ...(lastMessage ?? {}),
            content:
              `${lastContent}` +
              `\n\n[FORMAT CORRECTION — your previous reply was rejected. ` +
              `Reply again with ONLY the single JSON object. No prose, no code fences.]`,
          },
        ];
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

function targetOf(outcome: ReturnType<typeof validateModelOutput>): string | null {
  if (outcome.type !== "action") return null;
  const action = (outcome as { action?: { target?: unknown } }).action;
  return typeof action?.target === "string" ? action.target : null;
}

describe("hybrid benchmark (INVIZ_BENCH=1 only)", () => {
  it(
    "measures DOM vs HYBRID on the bench pages",
    async () => {
      if (!RUN) {
        console.log("hybrid benchmark skipped (set INVIZ_BENCH=1 to run against live Ollama)");
        return;
      }
      const tasks = JSON.parse(
        fs.readFileSync(path.join(BENCH_DIR, "tasks.json"), "utf8"),
      ) as { pages: BenchPage[] };
      const results: ArmResult[] = [];

      for (const page of tasks.pages) {
        const html = fs.readFileSync(path.join(BENCH_DIR, page.file), "utf8");
        document.documentElement.innerHTML = html;
        const lens = new ContextLens();
        const state = lens.extract(document);
        const items = lens.registry.snapshot();
        const idSet = new Set(items.map((i) => i.id));
        const url = `http://127.0.0.1:8080/bench/${page.file}`;

        const domText = serializePage({
          url,
          title: state.title,
          generation: state.generation,
          items,
          headings: state.structure.headings,
          landmarks: state.structure.landmarks,
          forms: state.structure.forms,
          prose: [],
        }).text;
        const hybridText = serializeRegistry({
          url,
          title: state.title,
          generation: state.generation,
          items,
          prose: [],
        }).text;

        const shotBuf = fs.readFileSync(path.join(BENCH_DIR, page.shot));
        const { width, height } = readPngSize(shotBuf);
        const b64 = shotBuf.toString("base64");

        for (const task of page.tasks) {
          const el = document.querySelector(`[data-bench="${task.expectBench}"]`);
          expect(el, `${page.file}: marker ${task.expectBench} must exist`).not.toBeNull();
          const expectedId = lens.identify(el as Element).elementId;
          expect(expectedId, `${task.id}: marker must resolve to a registry id`).not.toBeNull();
          // Bench sanity: the compact hybrid registry MUST contain the expected
          // id (it never dedupes). The DOM text may legitimately NOT contain it
          // (dedupeByIdentity folds identical controls) — that absence is the
          // experiment's independent variable, recorded per arm below.
          expect(hybridText).toContain(expectedId as string);
          const expectedInDomText = domText.includes(expectedId as string);

          const intent = `User goal: ${task.prompt} Determine ONLY the next action.`;
          const domMessages = [
            { role: "system", content: SYSTEM_PROMPT_V2 },
            { role: "user", content: buildUserPayload({ intent, lang: "en", pageText: domText }) },
          ];
          const hybridMessages = [
            { role: "system", content: `${SYSTEM_PROMPT_V2}${HYBRID_SYSTEM_SUFFIX_V1}` },
            {
              role: "user",
              content: buildUserPayload({ intent, lang: "en", pageText: hybridText }),
              images: [b64],
            },
          ];
          console.log(
            `bench ${task.id} [${task.category}] expected=${expectedId} ` +
              `domChars=${(domMessages[1] as { content: string }).content.length} ` +
              `hybridChars=${(hybridMessages[1] as { content: string }).content.length} ` +
              `imageB64=${b64.length} (${width}x${height})`,
          );

          for (const arm of ["dom", "hybrid"] as const) {
            const expectedInText =
              arm === "dom" ? expectedInDomText : hybridText.includes(expectedId as string);
            const t0 = Date.now();
            try {
              // eslint-disable-next-line no-await-in-loop
              const { outcome, reAsks, ms } = await reasonTurn(
                arm === "dom" ? domMessages : hybridMessages,
              );
              const target = targetOf(outcome);
              const inRegistry = target !== null && idSet.has(target);
              results.push({
                taskId: task.id,
                arm,
                category: task.category,
                expectedId: expectedId as string,
                expectedInText,
                valid: true,
                outcomeType: outcome.type,
                target,
                correct: target === expectedId,
                hallucinated:
                  target !== null && (/^e\d+$/.test(target) || /^r\d+$/.test(target)) && !inRegistry,
                wrongTarget: target !== null && inRegistry && target !== expectedId,
                reAsks,
                latencyMs: Date.now() - t0,
              });
              console.log(
                `  ${arm}: ${outcome.type} target=${target ?? "-"} ` +
                  `${target === expectedId ? "CORRECT" : ""} reAsks=${reAsks} ${ms}ms`,
              );
            } catch (err) {
              results.push({
                taskId: task.id,
                arm,
                category: task.category,
                expectedId: expectedId as string,
                expectedInText,
                valid: false,
                outcomeType: "invalid",
                target: null,
                correct: false,
                hallucinated: false,
                wrongTarget: false,
                reAsks: 0,
                latencyMs: Date.now() - t0,
                error: err instanceof Error ? err.message.slice(0, 160) : "unknown",
              });
              console.log(`  ${arm}: INVALID (${err instanceof Error ? err.message.slice(0, 120) : err})`);
            }
          }
        }
      }

      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, "results.json"),
        JSON.stringify(
          { model: OLLAMA_MODEL, ranAt: new Date().toISOString(), results },
          null,
          2,
        ),
      );

      const summarize = (arm: "dom" | "hybrid"): string => {
        const rows = results.filter((r) => r.arm === arm);
        const pct = (n: number): string => `${Math.round((100 * n) / rows.length)}%`;
        const avg = Math.round(rows.reduce((a, r) => a + r.latencyMs, 0) / rows.length);
        return (
          `${arm}: valid=${pct(rows.filter((r) => r.valid).length)} ` +
          `correct=${pct(rows.filter((r) => r.correct).length)} ` +
          `hallucinated=${pct(rows.filter((r) => r.hallucinated).length)} ` +
          `wrongTarget=${pct(rows.filter((r) => r.wrongTarget).length)} ` +
          `nonAction=${pct(rows.filter((r) => r.valid && r.target === null).length)} ` +
          `expectedHidden=${rows.filter((r) => !r.expectedInText).length}/${rows.length} ` +
          `reAsk=${pct(rows.filter((r) => r.reAsks > 0).length)} avgLatency=${avg}ms`
        );
      };
      console.log(`\nBENCH SUMMARY (n=${results.length / 2} tasks × 2 arms, model=${OLLAMA_MODEL})`);
      console.log(summarize("dom"));
      console.log(summarize("hybrid"));
    },
    1_800_000,
  );
});
