// @vitest-environment happy-dom
/**
 * Readable-prose extraction + read-target resolution.
 *
 * Live bug: on an article page the element registry held only nav links, so
 * the model was asked to read an article it had never been shown, and a `read`
 * against the <h1> returned the headline text instead of the body.
 */
import { describe, expect, it } from "vitest";
import {
  getProseRegions,
  resolveProseRegionFor,
} from "./dom-extractor.js";
import { ContextLens } from "./contextlens/index.js";

const ARTICLE = `<!doctype html><html lang="en"><body>
<header><a href="/" id="brand"><img src="/logo.svg" alt="Example News"></a>
<nav><a href="/world">World</a></nav></header>
<main><article>
  <h1>Understanding Screen Readers</h1>
  <p>A screen reader reads text aloud so people who cannot see the screen can navigate.</p>
  <h2>Why structure matters</h2>
  <p>Assistive technology depends on semantic markup and a real document outline.</p>
  <blockquote>Structure is the difference between reading and enduring a page.</blockquote>
</article></main>
<footer><p>&copy; 2026 Example</p></footer>
</body></html>`;

function mount(html: string): void {
  document.documentElement.innerHTML = html;
}

describe("getProseRegions", () => {
  it("captures the article body that the registry never held", () => {
    mount(ARTICLE);
    const regions = getProseRegions(document);
    expect(regions.length).toBeGreaterThan(0);
    const text = regions.map((r) => r.text).join(" ");
    expect(text).toContain("A screen reader reads text aloud");
    expect(text).toContain("Assistive technology depends on semantic markup");
    expect(text).toContain("Structure is the difference");
  });

  it("labels a region with its heading", () => {
    mount(ARTICLE);
    expect(getProseRegions(document)[0]?.label).toBe("Understanding Screen Readers");
  });

  it("excludes navigation and footer chrome", () => {
    mount(ARTICLE);
    const text = getProseRegions(document)
      .map((r) => r.text)
      .join(" ");
    expect(text).not.toContain("World");
    expect(text).not.toContain("2026 Example");
  });

  it("does not duplicate text from nested containers", () => {
    mount(`<body><main><article><p>${"Body sentence here. ".repeat(20)}</p></article></main></body>`);
    const regions = getProseRegions(document);
    expect(regions.length).toBe(1);
    const bodyOccurrences = (regions[0]?.text.match(/Body sentence here\./g) ?? []).length;
    expect(bodyOccurrences).toBe(20);
  });

  it("skips hidden and script content", () => {
    mount(`<body><main><article>
      <p>Visible sentence one.</p>
      <p style="display:none">Hidden sentence.</p>
      <script>var secret = "script text";</script>
      <p aria-hidden="true">Aria hidden sentence.</p>
    </article></main></body>`);
    const text = getProseRegions(document)
      .map((r) => r.text)
      .join(" ");
    expect(text).toContain("Visible sentence one.");
    expect(text).not.toContain("Hidden sentence.");
    expect(text).not.toContain("script text");
    expect(text).not.toContain("Aria hidden sentence.");
  });

  it("returns no region for a page with no prose", () => {
    mount(`<body><nav><a href="/">Home</a></nav></body>`);
    expect(getProseRegions(document)).toEqual([]);
  });

  it("respects the region limit", () => {
    const parts = Array.from(
      { length: 10 },
      (_, i) => `<section><p>Section ${i} sentence. ${"filler ".repeat(30)}</p></section>`,
    ).join("");
    mount(`<body><main>${parts}</main></body>`);
    expect(getProseRegions(document, 3).length).toBeLessThanOrEqual(3);
  });
});

describe("resolveProseRegionFor", () => {
  it("maps a headline to the article that contains it", () => {
    mount(ARTICLE);
    const h1 = document.querySelector("h1");
    expect(h1).not.toBeNull();
    const region = resolveProseRegionFor(h1 as Element);
    expect(region?.tagName.toLowerCase()).toBe("article");
    expect(region?.textContent ?? "").toContain("A screen reader reads text aloud");
  });

  it("maps a mid-article heading to the article too", () => {
    mount(ARTICLE);
    const h2 = document.querySelector("h2");
    const region = resolveProseRegionFor(h2 as Element);
    expect(region?.textContent ?? "").toContain("Assistive technology");
  });

  it("returns null for chrome outside any prose region", () => {
    mount(ARTICLE);
    const navLink = document.querySelector("nav a");
    expect(resolveProseRegionFor(navLink as Element)).toBeNull();
  });
});

describe("ContextLens prose wiring", () => {
  it("exposes prose regions from extract() and via proseRegions()", () => {
    mount(ARTICLE);
    const lens = new ContextLens();
    const state = lens.extract(document);
    expect(state.prose.length).toBeGreaterThan(0);
    expect(lens.proseRegions()[0]?.id).toBe("r1");
  });

  it("proseFor expands a heading to the article", () => {
    mount(ARTICLE);
    const lens = new ContextLens();
    lens.extract(document);
    const h1 = document.querySelector("h1");
    const expanded = lens.proseFor(h1 as Element);
    expect(expanded.textContent ?? "").toContain("A screen reader reads text aloud");
  });

  it("registry still holds only widgets, which is why prose was needed", () => {
    mount(ARTICLE);
    const lens = new ContextLens();
    lens.extract(document);
    const roles = lens.registry.snapshot().map((i) => i.role);
    expect(roles).not.toContain("heading");
    expect(lens.proseRegions().length).toBeGreaterThan(0);
  });
});