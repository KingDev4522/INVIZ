// @vitest-environment happy-dom
/**
 * Announcement noise suppression.
 *
 * Live bug: opening an article announced the site-logo link — a bare "Link"
 * with no name — plus the site name from the logo image. Both are chrome, not
 * content, and a nameless announcement carries no information for a listener.
 */
import { describe, expect, it } from "vitest";
import {
  FocusMonitor,
  isAnnounceableTarget,
  isSiteBranding,
} from "./focus-monitor.js";
import { resolveRole, extractStates } from "./dom-extractor.js";
import { computeAccessibleName } from "./aria-extractor.js";

const PAGE = `<!doctype html><html lang="en"><body>
<header>
  <a href="/" id="brand"><img src="/logo.svg" alt="Example News"></a>
  <nav aria-label="Main"><a href="/world" id="world">World</a></nav>
</header>
<main><article>
  <h1>Understanding Screen Readers</h1>
  <p>A screen reader reads text aloud.</p>
  <button id="go">Search</button>
</article></main>
</body></html>`;

function mount(html: string): Document {
  document.documentElement.innerHTML = html;
  return document;
}

function makeMonitor(doc: Document): { monitor: FocusMonitor; spoken: string[] } {
  const monitor = new FocusMonitor((el) => {
    const role = resolveRole(el);
    const { name } = computeAccessibleName(el, doc);
    return { elementId: null, name, role, states: extractStates(el, role) };
  });
  const spoken: string[] = [];
  monitor.onAnnouncement((a) => spoken.push(a.text));
  return { monitor, spoken };
}

describe("isAnnounceableTarget", () => {
  it("rejects a widget with no accessible name", () => {
    mount(PAGE);
    const brand = document.querySelector("#brand") as Element;
    expect(isAnnounceableTarget(brand, "link", "")).toBe(false);
  });

  it("accepts a named control", () => {
    mount(PAGE);
    const btn = document.querySelector("#go") as Element;
    expect(isAnnounceableTarget(btn, "button", "Search")).toBe(true);
  });

  it("rejects a whitespace-only name", () => {
    mount(PAGE);
    const btn = document.querySelector("#go") as Element;
    expect(isAnnounceableTarget(btn, "button", "   ")).toBe(false);
  });
});

describe("isSiteBranding", () => {
  it("flags a header anchor wrapping a logo image", () => {
    mount(PAGE);
    expect(isSiteBranding(document.querySelector("#brand") as Element, "link", "")).toBe(true);
  });

  it("flags a root href link in the header", () => {
    mount(PAGE);
    expect(isSiteBranding(document.querySelector("#brand") as Element, "link", "Example News")).toBe(
      true,
    );
  });

  it("does not flag an ordinary header nav link", () => {
    mount(PAGE);
    expect(isSiteBranding(document.querySelector("#world") as Element, "link", "World")).toBe(false);
  });

  it("does not flag a nav link outside the banner", () => {
    mount(`<body><main><a href="/" id="home">Home</a></main></body>`);
    expect(isSiteBranding(document.querySelector("#home") as Element, "link", "Home")).toBe(false);
  });
});

describe("FocusMonitor announcement filtering", () => {
  it("stays silent for the site-logo link on load", () => {
    const doc = mount(PAGE);
    const { monitor, spoken } = makeMonitor(doc);
    expect(monitor.handleFocus(doc.querySelector("#brand") as Element)).toBeNull();
    expect(spoken).toEqual([]);
  });

  it("does not speak a bare 'Link' for a nameless anchor", () => {
    const doc = mount(`<body><header><a href="/"></a></header></body>`);
    const { monitor, spoken } = makeMonitor(doc);
    const el = doc.querySelector("header a") as Element;
    const result = monitor.handleFocus(el);
    expect(result).toBeNull();
    expect(spoken.join(" ")).not.toContain("Link");
  });

  it("still announces a real navigation link", () => {
    const doc = mount(PAGE);
    const { monitor, spoken } = makeMonitor(doc);
    monitor.handleFocus(doc.querySelector("#world") as Element);
    expect(spoken).toEqual(["World"]);
  });

  it("still announces a named button", () => {
    const doc = mount(PAGE);
    const { monitor, spoken } = makeMonitor(doc);
    monitor.handleFocus(doc.querySelector("#go") as Element);
    expect(spoken).toEqual(["Search"]);
  });

  it("speaks the page's real links, not the logo, when both are visited", () => {
    const doc = mount(PAGE);
    const { monitor, spoken } = makeMonitor(doc);
    monitor.handleFocus(doc.querySelector("#brand") as Element);
    monitor.handleFocus(doc.querySelector("#world") as Element);
    expect(spoken).toEqual(["World"]);
  });
});