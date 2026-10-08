// @vitest-environment happy-dom
/**
 * Phase 1 behavioral tests: real DOM extraction, naming, registry,
 * announcements, triggers, highlight, Layer B policy.
 * Run: npm test
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectInteractives,
  extractStates,
  getForms,
  getHeadings,
  isVisible,
  resolveRole,
} from "./dom-extractor.js";
import {
  classifyField,
  computeAccessibleName,
  fieldHasValue,
} from "./aria-extractor.js";
import { ElementRegistry } from "./element-registry.js";
import {
  FocusMonitor,
  buildAnnouncement,
  isMeaningfulFocusTarget,
} from "./focus-monitor.js";
import { PageObserver } from "./page-observer.js";
import { clearHighlight, highlight } from "./highlighter.js";
import { layerBPolicy } from "../background/page-state-store.js";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  setBody("");
  clearHighlight();
});

describe("role resolution", () => {
  it("resolves implicit native roles", () => {
    setBody(
      `<button id="b">x</button><a id="l" href="/x">x</a><a id="p">x</a>
       <input id="c" type="checkbox"><input id="pw" type="password">
       <input id="s" type="search"><input id="h" type="hidden">
       <select id="sel"></select><h2 id="h2">T</h2><nav id="n"></nav>`,
    );
    const byId = (id: string): Element => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`missing ${id}`);
      return el;
    };
    expect(resolveRole(byId("b"))).toBe("button");
    expect(resolveRole(byId("l"))).toBe("link");
    expect(resolveRole(byId("p"))).toBe("generic");
    expect(resolveRole(byId("c"))).toBe("checkbox");
    expect(resolveRole(byId("pw"))).toBe("textbox");
    expect(resolveRole(byId("s"))).toBe("searchbox");
    expect(resolveRole(byId("h"))).toBe("none");
    expect(resolveRole(byId("sel"))).toBe("combobox");
    expect(resolveRole(byId("h2"))).toBe("heading");
    expect(resolveRole(byId("n"))).toBe("navigation");
  });

  it("explicit valid role wins; unknown role falls back to implicit", () => {
    setBody(`<div id="a" role="button">x</div><div id="b" role="frobnicate">x</div>`);
    const byId = (id: string): Element => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`missing ${id}`);
      return el;
    };
    expect(resolveRole(byId("a"))).toBe("button");
    expect(resolveRole(byId("b"))).toBe("generic");
  });
});

describe("visibility", () => {
  it("excludes hidden/aria-hidden/display-none, keeps empty labelled controls", () => {
    setBody(
      `<button id="v">x</button><button id="h" hidden>x</button>
       <div id="a" aria-hidden="true"><button id="ai">x</button></div>
       <button id="d" style="display:none">x</button>
       <button id="icon" aria-label="Close"></button>`,
    );
    const byId = (id: string): Element => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`missing ${id}`);
      return el;
    };
    expect(isVisible(byId("v"))).toBe(true);
    expect(isVisible(byId("h"))).toBe(false);
    expect(isVisible(byId("a"))).toBe(false);
    expect(isVisible(byId("d"))).toBe(false);
    // Empty icon button with accessible name must NOT be dropped.
    expect(isVisible(byId("icon"))).toBe(true);
  });
});

describe("accessible names", () => {
  it("follows the label → labelledby → aria-label → native → text → weak chain", () => {
    setBody(
      `<label for="i1">Full name</label><input id="i1" type="text">
       <div id="ref">Apply <b>Now</b></div><button id="i2" aria-labelledby="ref">x</button>
       <button id="i3" aria-label="Close dialog">x</button>
       <img id="i4" alt="Company logo">
       <input id="i5" type="submit" value="Send it">
       <button id="i6">Click <span>me</span></button>
       <input id="i7" type="text" placeholder="Type here">
       <span id="i8">plain</span>`,
    );
    const n = (id: string): { name: string; source: string } => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`missing ${id}`);
      const r = computeAccessibleName(el, document);
      return { name: r.name, source: r.source };
    };
    expect(n("i1")).toEqual({ name: "Full name", source: "label" });
    expect(n("i2")).toEqual({ name: "Apply Now", source: "labelledby" });
    expect(n("i3")).toEqual({ name: "Close dialog", source: "aria-label" });
    expect(n("i4")).toEqual({ name: "Company logo", source: "native" });
    expect(n("i5")).toEqual({ name: "Send it", source: "native" });
    expect(n("i6")).toEqual({ name: "Click me", source: "text" });
    expect(n("i7")).toEqual({ name: "Type here", source: "weak" });
    expect(n("i8").source).toBe("text");
  });

  it("terminates on labelledby cycles", () => {
    setBody(
      `<button id="a" aria-labelledby="b">A</button><span id="b" aria-labelledby="a">B</span>`,
    );
    const el = document.getElementById("a");
    if (el === null) throw new Error("missing a");
    const r = computeAccessibleName(el, document);
    expect(typeof r.name).toBe("string"); // terminates; content may vary by cycle cut
  });
});

describe("states and field classification", () => {
  it("extracts checked/required/level/disabled", () => {
    setBody(
      `<input id="c" type="checkbox" checked>
       <input id="t" type="text" required>
       <h3 id="h">Title</h3>
       <button id="b" disabled aria-expanded="true">Menu</button>`,
    );
    const byId = (id: string): Element => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`missing ${id}`);
      return el;
    };
    expect(extractStates(byId("c"), "checkbox")["checked"]).toBe(true);
    expect(extractStates(byId("t"), "textbox")["required"]).toBe(true);
    expect(extractStates(byId("h"), "heading")["level"]).toBe(3);
    expect(extractStates(byId("b"), "button")["disabled"]).toBe(true);
    expect(extractStates(byId("b"), "button")["expanded"]).toBe(true);
  });

  it("classifies fields and marks password/OTP/file sensitive", () => {
    setBody(
      `<input id="pw" type="password"><input id="otp" type="text" autocomplete="one-time-code">
       <input id="otp2" name="otp_code" type="text"><input id="em" type="email">
       <input id="f" type="file"><input id="s" type="submit" value="Go">
       <textarea id="ta"></textarea><select id="se"></select>`,
    );
    const byId = (id: string): Element => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`missing ${id}`);
      return el;
    };
    expect(classifyField(byId("pw"))).toEqual({ kind: "password", sensitive: true });
    expect(classifyField(byId("otp"))?.sensitive).toBe(true);
    expect(classifyField(byId("otp2"))?.sensitive).toBe(true);
    expect(classifyField(byId("em"))).toEqual({ kind: "email", sensitive: false });
    expect(classifyField(byId("f"))?.sensitive).toBe(true);
    expect(classifyField(byId("s"))).toBeNull();
    expect(classifyField(byId("ta"))).toEqual({ kind: "textarea", sensitive: false });
    expect(classifyField(byId("se"))).toEqual({ kind: "select", sensitive: false });
  });

  it("reports has-value as boolean only", () => {
    setBody(`<input id="pw" type="password" value="supersecret">`);
    const el = document.getElementById("pw");
    if (el === null) throw new Error("missing pw");
    expect(fieldHasValue(el)).toBe(true);
  });
});

describe("collectInteractives + structure", () => {
  it("collects widgets and counts hidden skips", () => {
    setBody(
      `<button>A</button><a href="/x">B</a><input type="text">
       <div tabindex="0" role="button">C</div>
       <button hidden>D</button><h2>Title</h2>
       <form aria-label="Apply"><input type="email"></form>`,
    );
    const { items, skippedHidden } = collectInteractives(document);
    expect(items.length).toBe(5);
    expect(skippedHidden).toBe(1);
    expect(getHeadings(document)).toEqual([{ level: 2, text: "Title" }]);
    expect(getForms(document)).toEqual([{ name: "Apply", fieldCount: 1 }]);
  });
});

describe("shadow DOM piercing (YouTube-style renderers)", () => {
  // Video cards mounted inside open shadow roots, the way component
  // frameworks render them. Before piercing, the registry saw the page
  // chrome but none of the content, so "play the 1st video" had no target.
  function mountVideoPage(): void {
    setBody(
      `<div id="header"><input id="search" type="search" aria-label="Search"></div>
       <div id="feed"></div>`,
    );
    const feed = document.getElementById("feed");
    if (feed === null) throw new Error("missing feed");
    for (const title of ["First video title", "Second video title"]) {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const link = document.createElement("a");
      link.setAttribute("href", "/watch?v=x");
      link.textContent = title;
      shadow.appendChild(link);
      feed.appendChild(host);
    }
  }

  const namesOf = (items: Element[]): string[] =>
    items.map((el) => (el.textContent ?? "").trim());

  it("collects video links mounted inside open shadow roots", () => {
    mountVideoPage();
    const { items, shadowPierced } = collectInteractives(document);
    expect(namesOf(items)).toContain("First video title");
    expect(namesOf(items)).toContain("Second video title");
    expect(shadowPierced).toBe(2);
  });

  it("keeps document order: shadow content follows its host", () => {
    mountVideoPage();
    const { items } = collectInteractives(document);
    const names = namesOf(items);
    expect(names.indexOf("First video title")).toBeLessThan(
      names.indexOf("Second video title"),
    );
  });

  it("leaves closed shadow roots invisible by design", () => {
    setBody(`<div id="host"></div>`);
    const host = document.getElementById("host");
    if (host === null) throw new Error("missing host");
    const shadow = host.attachShadow({ mode: "closed" });
    const link = document.createElement("a");
    link.setAttribute("href", "/secret");
    link.textContent = "Secret video";
    shadow.appendChild(link);
    const { items } = collectInteractives(document);
    expect(namesOf(items)).not.toContain("Secret video");
  });

  it("surfaces shadow headings for page structure", () => {
    setBody(`<div id="host"></div>`);
    const host = document.getElementById("host");
    if (host === null) throw new Error("missing host");
    const shadow = host.attachShadow({ mode: "open" });
    const heading = document.createElement("h2");
    heading.textContent = "Trending";
    shadow.appendChild(heading);
    expect(getHeadings(document)).toEqual([{ level: 2, text: "Trending" }]);
  });
});

describe("element registry lifecycle", () => {
  it("scopes IDs to generations and rejects stale targets", () => {
    const reg = new ElementRegistry();
    setBody(`<button id="a">A</button>`);
    const a = document.getElementById("a");
    if (a === null) throw new Error("missing a");
    const g1 = reg.rebuild([
      { element: a, role: "button", name: "A", states: {}, field: null },
    ]);
    expect(g1).toBe(1);
    expect(reg.resolve("e1", 1).ok).toBe(true);
    expect(reg.resolve("e2", 1)).toEqual({ ok: false, code: "ELEMENT_NOT_FOUND" });
    expect(reg.resolve("nope", 1)).toEqual({ ok: false, code: "ELEMENT_NOT_FOUND" });

    setBody(`<button id="b">B</button>`);
    const b = document.getElementById("b");
    if (b === null) throw new Error("missing b");
    const g2 = reg.rebuild([
      { element: b, role: "button", name: "B", states: {}, field: null },
    ]);
    expect(g2).toBe(2);
    expect(reg.resolve("e1", 1)).toEqual({ ok: false, code: "STALE_TARGET" });

    b.remove(); // disconnected element is stale even in its own generation
    expect(reg.resolve("e1", 2)).toEqual({ ok: false, code: "STALE_TARGET" });
  });
});

describe("focus announcements", () => {
  it("filters non-meaningful targets", () => {
    setBody(`<div id="g" tabindex="0">x</div><button id="b">Go</button>`);
    const g = document.getElementById("g");
    const b = document.getElementById("b");
    if (g === null || b === null) throw new Error("missing nodes");
    expect(isMeaningfulFocusTarget(g, "generic")).toBe(false);
    expect(isMeaningfulFocusTarget(b, "button")).toBe(true);
  });

  it("builds EN + HI announcements with state bits and hints", () => {
    setBody(`<input id="s" type="search" aria-label="Search">`);
    const s = document.getElementById("s");
    if (s === null) throw new Error("missing s");
    const en = buildAnnouncement({
      elementId: "e1",
      name: "Search",
      role: "searchbox",
      states: {},
      element: s,
      lang: "en",
      verbosity: "standard",
    });
    expect(en.text).toBe("Search. Search box. Type your search query.");
    const hi = buildAnnouncement({
      elementId: "e1",
      name: "खोज",
      role: "searchbox",
      states: {},
      element: s,
      lang: "hi",
      verbosity: "standard",
    });
    expect(hi.text).toContain("खोज");
    expect(hi.text).toContain("अपनी खोज लिखें।");
  });

  it("includes checked state and dedupes identical focus", () => {
    setBody(`<input id="c" type="checkbox" checked aria-label="Remember me">`);
    const c = document.getElementById("c");
    if (c === null) throw new Error("missing c");
    const monitor = new FocusMonitor((el) => ({
      elementId: "e1",
      name: computeAccessibleName(el, document).name,
      role: resolveRole(el),
      states: extractStates(el, resolveRole(el)),
    }));
    monitor.setVerbosity("standard");
    const first = monitor.handleFocus(c);
    expect(first?.text).toContain("checked");
    expect(monitor.handleFocus(c)).toBeNull(); // dedupe
    monitor.setLang("hi");
    const hiAgain = monitor.handleFocus(c);
    expect(hiAgain?.text).toContain("चयनित"); // language switch re-announces
  });

  it("defaults to terse: speaks the name alone", () => {
    setBody(`<input id="e" type="email" aria-label="Email" aria-required="true">`);
    const e = document.getElementById("e");
    if (e === null) throw new Error("missing e");
    const monitor = new FocusMonitor((el) => ({
      elementId: "e2",
      name: computeAccessibleName(el, document).name,
      role: resolveRole(el),
      states: extractStates(el, resolveRole(el)),
    }));
    expect(monitor.handleFocus(e)?.text).toBe("Email");
  });
});

describe("page observer triggers", () => {
  it("classifies modal, form-structure, results, and minor changes", () => {
    setBody(`<div id="app"><ul id="list"><li>one</li></ul></div>`);
    const triggers: string[] = [];
    const obs = new PageObserver(document, {
      onTrigger: (t) => {
        triggers.push(t);
      },
    });
    // Minor text tick → minor.
    const p = document.createElement("p");
    p.textContent = "tick";
    document.getElementById("app")?.appendChild(p);
    expect(obs.classifyNow()).toBe("minor");

    // Modal open → modal.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.textContent = "Hello";
    document.getElementById("app")?.appendChild(dialog);
    expect(obs.classifyNow()).toBe("modal");

    // New form field → form-structure.
    const input = document.createElement("input");
    input.type = "text";
    document.getElementById("app")?.appendChild(input);
    expect(obs.classifyNow()).toBe("form-structure");

    // Results growth → results.
    const li = document.createElement("li");
    li.textContent = "two";
    document.getElementById("list")?.appendChild(li);
    expect(obs.classifyNow()).toBe("results");
    expect(triggers).toEqual(["modal", "form-structure", "results"]);
    obs.stop();
  });

  it("fires route trigger on pushState URL change", () => {
    setBody(`<div>page</div>`);
    const seen: string[] = [];
    const obs = new PageObserver(document, {
      onTrigger: (t) => {
        seen.push(t);
      },
    });
    obs.start();
    history.pushState({}, "", "/next");
    obs.stop();
    expect(seen).toContain("route");
  });
});

describe("highlighter", () => {
  it("marks one element at a time and clears", () => {
    setBody(`<button id="a">A</button><button id="b">B</button>`);
    const a = document.getElementById("a");
    const b = document.getElementById("b");
    if (a === null || b === null) throw new Error("missing nodes");
    highlight(a);
    expect(a.getAttribute("data-vl-highlight")).toBe("true");
    highlight(b);
    expect(a.getAttribute("data-vl-highlight")).toBeNull();
    expect(b.getAttribute("data-vl-highlight")).toBe("true");
    clearHighlight();
    expect(b.getAttribute("data-vl-highlight")).toBeNull();
  });
});

describe("Layer B policy shell", () => {
  it("empty Layer B is never fresh", () => {
    expect(layerBPolicy.isFresh(null)).toBe(false);
    expect(layerBPolicy.isFresh(layerBPolicy.empty(42))).toBe(false);
  });
});

describe("page-state store quota (chrome.storage mocked)", () => {
  it("truncates oversized snapshots to the per-tab cap and records the cut", async () => {
    const mem = new Map<string, unknown>();
    const chromeMock = {
      storage: {
        session: {
          get: vi.fn(async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) {
              if (mem.has(key)) out[key] = mem.get(key);
            }
            return out;
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) mem.set(k, v);
          }),
          remove: vi.fn(async (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) mem.delete(key);
          }),
        },
      },
    };
    (globalThis as Record<string, unknown>)["chrome"] = chromeMock;

    const { storePageState } = await import("../background/page-state-store.js");
    const big = Array.from({ length: 20000 }, (_, i) => ({
      id: `e${i + 1}`,
      role: "link",
      name: `Result link number ${i + 1} with a fairly long accessible name attached to force quota pressure`,
      states: {},
      fieldKind: null,
      sensitive: false,
    }));
    const result = await storePageState({
      tabId: 7,
      url: "https://example.com/",
      title: "Big",
      generation: 1,
      items: big,
      skipped: { hidden: 0, frames: 0, shadow: 0 },
      savedAt: Date.now(),
      truncated: false,
    });
    expect(result.stored).toBe(true);
    expect(result.truncated).toBe(true);
    const raw = await chromeMock.storage.session.get("page:tab:7");
    const saved = (
      raw as Record<string, { items: unknown[]; truncated: boolean }>
    )["page:tab:7"];
    if (saved === undefined) throw new Error("snapshot was not stored");
    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(saved.truncated).toBe(true);
    expect(saved.items.length).toBeGreaterThan(0);
    expect(saved.items.length).toBeLessThan(big.length);
    delete (globalThis as Record<string, unknown>)["chrome"];
  });
});
