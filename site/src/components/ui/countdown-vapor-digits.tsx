import * as React from "react";
import { cn } from "@/lib/utils";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  alpha: number;
  targetAlpha: number;
  start: number;
  seed: number;
};

type Cell = {
  el: HTMLElement;
  rect: { x: number; y: number; w: number; h: number };
  fontSize: number;
  cache: Map<string, Float32Array>;
  particles: Particle[];
  char: string;
};

const MAX_PARTICLES = 160;
const SPRING = 0.06;
const DRAG = 0.86;
const CELL_STAGGER = 40;
const PARTICLE_SPREAD = 110;

let rasterCanvas: HTMLCanvasElement | null = null;

function prefersReduced(): boolean {
  if (typeof window === "undefined") return true;
  if (document.documentElement.classList.contains("static")) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rasterize(ch: string, w: number, h: number, fontSize: number): Float32Array {
  if (!rasterCanvas) rasterCanvas = document.createElement("canvas");
  const canvas = rasterCanvas;
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new Float32Array(0);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${fontSize}px "Geist", sans-serif`;
  ctx.fillText(ch, canvas.width / 2, canvas.height / 2);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const step = Math.max(2, fontSize * 0.07);
  const points: number[] = [];
  const half = step / 2;

  for (let y = half; y < canvas.height && points.length < MAX_PARTICLES * 2; y += step) {
    for (let x = half; x < canvas.width && points.length < MAX_PARTICLES * 2; x += step) {
      const px = Math.min(canvas.width - 1, Math.round(x));
      const py = Math.min(canvas.height - 1, Math.round(y));
      const alpha = data[(py * canvas.width + px) * 4 + 3] ?? 0;
      if (alpha > 110) {
        const jx = (Math.random() - 0.5) * step * 0.7;
        const jy = (Math.random() - 0.5) * step * 0.7;
        points.push(x + jx, y + jy);
      }
    }
  }

  return Float32Array.from(points);
}

function measure(el: HTMLElement, root: HTMLElement) {
  const a = el.getBoundingClientRect();
  const b = root.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
}

function createParticles(rect: { x: number; y: number; w: number; h: number }): Particle[] {
  const list: Particle[] = [];
  for (let i = 0; i < MAX_PARTICLES; i += 1) {
    const hx = rect.x + Math.random() * Math.max(rect.w, 1);
    const hy = rect.y + Math.random() * Math.max(rect.h, 1);
    list.push({
      x: hx,
      y: hy,
      vx: 0,
      vy: 0,
      hx,
      hy,
      tx: hx,
      ty: hy,
      alpha: 0,
      targetAlpha: 0,
      start: 0,
      seed: Math.random() * Math.PI * 2,
    });
  }
  return list;
}

export type VaporTextProps = {
  /** Words shown in sequence. Every word must have the same length. */
  words: readonly string[];
  /** Milliseconds between words. 0 keeps the first word on screen. */
  cycleMs?: number;
  /** Optional caption under each glyph cell. */
  labels?: readonly string[] | null;
  className?: string;
};

export function VaporText({
  words,
  cycleMs = 0,
  labels = null,
  className,
}: VaporTextProps) {
  const normalized = React.useMemo(() => {
    const list = words.length > 0 ? words : [""];
    const width = Math.max(...list.map((w) => w.length));
    return list.map((w) => w.padEnd(width, " ").slice(0, width));
  }, [words]);

  const count = normalized[0]?.length ?? 0;
  const [index, setIndex] = React.useState(0);
  const current = normalized[index % normalized.length] ?? "";

  const [reduced, setReduced] = React.useState(() =>
    typeof window === "undefined" ? false : prefersReduced(),
  );

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const letterRefs = React.useRef<(HTMLElement | null)[]>([]);
  const engineRef = React.useRef<((word: string) => void) | null>(null);
  const wordRef = React.useRef(current);

  React.useEffect(() => {
    const sync = () => setReduced(prefersReduced());
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  React.useEffect(() => {
    if (cycleMs <= 0 || normalized.length < 2 || reduced) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % normalized.length);
    }, cycleMs);
    return () => window.clearInterval(id);
  }, [cycleMs, normalized, reduced]);

  React.useEffect(() => {
    if (reduced) return;
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const els = letterRefs.current.slice(0, count).filter((el): el is HTMLElement => el !== null);
    if (els.length !== count) return;

    const build = () => {
      const rootRect = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rootRect.width * dpr));
      canvas.height = Math.max(1, Math.round(rootRect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      return els.map((el) => {
        const rect = measure(el, root);
        const fontSize = Number.parseFloat(window.getComputedStyle(el).fontSize) || 16;
        return { el, rect, fontSize, cache: new Map<string, Float32Array>(), particles: createParticles(rect), char: "" };
      });
    };

    let cells: Cell[] = build();
    let raf = 0;
    let running = false;

    const samplesFor = (cell: Cell, ch: string): Float32Array => {
      const hit = cell.cache.get(ch);
      if (hit) return hit;
      const built = rasterize(ch, cell.rect.w, cell.rect.h, cell.fontSize);
      cell.cache.set(ch, built);
      return built;
    };

    const setWord = (word: string) => {
      const now = performance.now();
      cells.forEach((cell, i) => {
        const ch = word[i] ?? " ";
        if (cell.char === ch) return;
        cell.char = ch;
        const samples = samplesFor(cell, ch);
        const pairs = Math.floor(samples.length / 2);
        const active = Math.min(pairs, MAX_PARTICLES);
        for (let p = 0; p < MAX_PARTICLES; p += 1) {
          const pt = cell.particles[p];
          if (!pt) continue;
          if (p < active) {
            const s = (p % pairs) * 2;
            pt.tx = cell.rect.x + (samples[s] ?? 0);
            pt.ty = cell.rect.y + (samples[s + 1] ?? 0);
            pt.targetAlpha = 1;
            pt.start = now + i * CELL_STAGGER + (p / MAX_PARTICLES) * PARTICLE_SPREAD;
          } else {
            pt.tx = pt.hx;
            pt.ty = pt.hy;
            pt.targetAlpha = 0;
            pt.start = now + i * CELL_STAGGER;
          }
        }
      });
      start();
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = window.requestAnimationFrame(tick);
    };

    const tick = (now: number) => {
      const color = window.getComputedStyle(root).color;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;

      let settled = true;
      for (const cell of cells) {
        for (const pt of cell.particles) {
          if (now < pt.start) {
            settled = false;
            continue;
          }
          const dx = pt.tx - pt.x;
          const dy = pt.ty - pt.y;
          const distance = Math.abs(dx) + Math.abs(dy);
          if (distance > 0.4 || Math.abs(pt.vx) > 0.05 || Math.abs(pt.vy) > 0.05) {
            settled = false;
            const wobble = Math.sin(now * 0.003 + pt.seed) * 0.14;
            pt.vx = (pt.vx + dx * SPRING + wobble * 0.3) * DRAG;
            pt.vy = (pt.vy + dy * SPRING + Math.cos(now * 0.003 + pt.seed) * 0.1) * DRAG;
            pt.x += pt.vx;
            pt.y += pt.vy;
          } else {
            pt.x = pt.tx;
            pt.y = pt.ty;
            pt.vx = 0;
            pt.vy = 0;
          }
          if (Math.abs(pt.targetAlpha - pt.alpha) > 0.01) {
            pt.alpha += (pt.targetAlpha - pt.alpha) * 0.14;
            settled = false;
          } else {
            pt.alpha = pt.targetAlpha;
          }
          if (pt.alpha > 0.012) {
            ctx.globalAlpha = pt.alpha * 0.16;
            ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
            ctx.globalAlpha = pt.alpha;
            ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
          }
        }
      }
      ctx.globalAlpha = 1;

      if (settled) {
        running = false;
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };

    engineRef.current = setWord;

    let disposed = false;
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      cells = build();
      setWord(wordRef.current);
    });
    ro.observe(root);

    const fonts = document.fonts;
    void fonts?.ready.then(() => {
      if (disposed) return;
      cells = build();
      setWord(wordRef.current);
    });
    setWord(wordRef.current);

    return () => {
      disposed = true;
      engineRef.current = null;
      ro.disconnect();
      window.cancelAnimationFrame(raf);
      running = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, count]);

  React.useEffect(() => {
    wordRef.current = current;
    engineRef.current?.(current);
  }, [current]);

  const rows = labels ? "auto auto" : "auto";

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative inline-grid leading-none font-semibold tracking-[-0.03em]",
        "text-[clamp(2.5rem,7vw,4.5rem)]",
        className,
      )}
      style={{
        gridTemplateColumns: `repeat(${count}, auto)`,
        gridTemplateRows: rows,
        columnGap: "0.03em",
        rowGap: labels ? "0.4em" : undefined,
      }}
    >
      <span className="sr-only">{current.trim()}</span>
      {Array.from(current, (ch, i) => (
        <span
          key={`glyph-${i}`}
          ref={(el) => {
            letterRefs.current[i] = el;
          }}
          aria-hidden="true"
          className="justify-self-center"
          style={{ lineHeight: 1, opacity: reduced ? 1 : 0 }}
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
      {labels?.map((label, i) => (
        <span
          key={`label-${i}`}
          aria-hidden="true"
          className="justify-self-center font-mono text-[11px] font-normal tracking-[0.14em] whitespace-nowrap uppercase"
          style={{ color: "var(--ns-muted)", lineHeight: 1 }}
        >
          {label}
        </span>
      ))}
      {!reduced && (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
        />
      )}
    </div>
  );
}

export const VaporCountdown = VaporText;
