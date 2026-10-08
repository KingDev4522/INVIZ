// @vitest-environment happy-dom
/**
 * VoiceLens hover-path regression tests (Phase 1).
 *
 * The keyboard-focus path (handleFocus) is intentionally unchanged; these pin
 * the NEW cursor-aware path (handleHover + resolveHoverTarget + coalescer):
 * headings, plain text, images with alt, cards, shadow-DOM innards, the
 * stale-hover contract, and rapid-movement coalescing.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import { computeAccessibleName } from "./aria-extractor.js";
import { extractStates, resolveRole } from "./dom-extractor.js";
import {
  FocusMonitor,
  HoverCoalescer,
  isDescendantComposed,
  resolveHoverTarget,
  type HoverClock,
} from "./focus-monitor.js";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): Element {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

/** Same resolve shape as content.ts (live element, registry id stubbed). */
function monitor(): FocusMonitor {
  return new FocusMonitor((el) => ({
    elementId: null,
    name: computeAccessibleName(el, document).name,
    role: resolveRole(el),
    states: extractStates(el, resolveRole(el)),
  }));
}

describe("hover eligibility — previously silent content", () => {
  it("announces a heading without requiring focusability", () => {
    setBody(`<h1 id="h">Order summary</h1>`);
    const h = byId("h");
    // Keyboard path stays silent (proves the paths are separate).
    expect(monitor().handleFocus(h)).toBeNull();
    expect(monitor().handleHover(h)?.text).toBe("Order summary");
  });

  it("announces paragraph / plain text", () => {
    setBody(`<p id="p">Your total is $42, due Friday.</p>`);
    expect(monitor().handleHover(byId("p"))?.text).toBe("Your total is $42, due Friday.");
  });

  it("resolves a bare span to its readable text", () => {
    setBody(`<div><span id="s">Free shipping over $50</span></div>`);
    expect(monitor().handleHover(byId("s"))?.text).toBe("Free shipping over $50");
  });

  it("announces an image with alt text; stays silent without it", () => {
    setBody(`<img id="a" src="/x.png" alt="Golden retriever puppy"><img id="b" src="/y.png">`);
    expect(monitor().handleHover(byId("a"))?.text).toBe("Golden retriever puppy");
    expect(monitor().handleHover(byId("b"))).toBeNull();
  });

  it("resolves an empty nested element to the readable card around it", () => {
    setBody(
      `<div id="card"><h2>Pro plan</h2><p>$12 per month.</p><i id="icon"></i></div>`,
    );
    const text = monitor().handleHover(byId("icon"))?.text ?? "";
    expect(text).toContain("Pro plan");
    expect(text).toContain("$12 per month.");
  });

  it("keeps brand chrome silent on hover", () => {
    setBody(
      `<header><a href="/" id="brand"><img src="/logo.svg" alt="Example News"></a></header>`,
    );
    expect(monitor().handleHover(byId("brand"))).toBeNull();
  });

  it("stays silent on empty containers and hidden text", () => {
    setBody(`<div id="empty"></div><div id="hid" aria-hidden="true">secret</div>`);
    expect(monitor().handleHover(byId("empty"))).toBeNull();
    expect(monitor().handleHover(byId("hid"))).toBeNull();
  });
});

describe("hover eligibility — existing widget behavior preserved", () => {
  it("announces button, link and labelled input exactly as focus does", () => {
    setBody(
      `<button id="b">Pay now</button><a id="l" href="/x">Details</a>` +
        `<label for="e">Email</label><input id="e" type="email">`,
    );
    expect(monitor().handleHover(byId("b"))?.text).toBe("Pay now");
    expect(monitor().handleHover(byId("l"))?.text).toBe("Details");
    expect(monitor().handleHover(byId("e"))?.text).toBe("Email");
  });

  it("keeps nameless widgets silent when no readable block surrounds them", () => {
    setBody(`<button id="x" aria-label=""></button>`);
    expect(monitor().handleHover(byId("x"))).toBeNull();
  });

  it("dedupes identical consecutive hover announcements", () => {
    setBody(`<h1 id="h">Same</h1>`);
    const m = monitor();
    expect(m.handleHover(byId("h"))?.text).toBe("Same");
    expect(m.handleHover(byId("h"))).toBeNull();
  });
});

describe("hover target resolution", () => {
  it("resolves open shadow-DOM innards instead of the host", () => {
    setBody(`<div id="host"></div>`);
    const host = byId("host");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button id="inner">Inner action</button>`;
    const inner = shadow.querySelector("#inner") as Element;
    expect(isDescendantComposed(host, inner)).toBe(true);
    expect(isDescendantComposed(byId("host"), document.body)).toBe(false);
    // The inner target itself resolves (the content-script hit-test feeds it
    // via elementFromPoint; here the resolution half is pinned directly).
    const role = resolveRole(inner);
    const name = computeAccessibleName(inner, document).name;
    expect(resolveHoverTarget(inner, role, name)?.name).toBe("Inner action");
    expect(monitor().handleHover(inner)?.text).toBe("Inner action");
  });

  it("never climbs out to body/html (no whole-page reads)", () => {
    setBody(`<div id="wrap"><b id="b"></b></div>`);
    // Nearest readable block is #wrap only if it has text; empty chain → null.
    expect(resolveHoverTarget(byId("b"), "generic", "")).toBeNull();
  });
});

describe("stale hover contract", () => {
  it("returns null for non-readable targets so the caller clears lastAnnouncement", () => {
    setBody(`<div id="empty"></div>`);
    // Contract: content.ts sets lastAnnouncement = null on exactly this
    // outcome, so FOCUS_CHANGED can never describe a previous element.
    expect(monitor().handleHover(byId("empty"))).toBeNull();
  });
});

describe("hover coalescing", () => {
  function fakeClock(): HoverClock & { advance(ms: number): void; pending(): number } {
    let t = 1_000_000;
    const queue: Array<() => void> = [];
    return {
      now: () => t,
      schedule: (fn) => {
        queue.push(fn);
      },
      advance: (ms) => {
        t += ms;
        queue.splice(0).forEach((fn) => fn());
      },
      pending: () => queue.length,
    };
  }

  function el(id: string): Element {
    const d = document.createElement("div");
    d.id = id;
    return d;
  }

  it("processes slow movement immediately (old cadence preserved)", () => {
    setBody(``);
    const clock = fakeClock();
    const seen: string[] = [];
    const c = new HoverCoalescer((e) => seen.push(e.id), clock);
    c.push(el("a")); // first event: immediate (lastProcessAt = 0)
    expect(seen).toEqual(["a"]);
  });

  it("coalesces bursts: intermediates skipped, latest flushed on settle", () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const c = new HoverCoalescer((e) => seen.push(e.id), clock);
    c.push(el("a")); // immediate
    c.push(el("b")); // within 600ms → coalesce
    c.push(el("c")); // supersedes b
    expect(seen).toEqual(["a"]);
    expect(clock.pending()).toBe(1); // exactly one trailing flush queued
    clock.advance(250);
    expect(seen).toEqual(["a", "c"]); // latest wins, b never processed
  });

  it("resumes immediate processing after the cursor settles", () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const c = new HoverCoalescer((e) => seen.push(e.id), clock);
    c.push(el("a"));
    clock.advance(1000); // cursor rests
    c.push(el("d"));
    expect(seen).toEqual(["a", "d"]);
  });
});
