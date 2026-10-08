// @vitest-environment happy-dom
/**
 * Site qualification: test-page/ as the baseline qualified site (PRD 6.7 §1.1,
 * PRD 6 §9). Runs the REAL extraction pipeline over the REAL fixture markup and
 * asserts every checklist item that is statically decidable. Live-browser items
 * (heartbeat, reload diff, timing) are marked and measured at demo time; the
 * static evidence here already rules out whole failure classes.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { collectInteractives } from "./src/content/dom-extractor.js";
import { computeAccessibleName } from "./src/content/aria-extractor.js";
import { ElementRegistry } from "./src/content/element-registry.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(DIR, "..", "test-page", "index.html"), "utf8");
const APP_JS = fs.readFileSync(path.join(DIR, "..", "test-page", "app.js"), "utf8");

function loadPage(): Document {
  const window = new Window();
  window.document.write(HTML);
  // happy-dom's Document is structurally compatible for extraction purposes.
  return window.document as unknown as Document;
}

describe("test-page qualification (PRD 6 §9)", () => {
  it("check 1 — injectable: manifest matcher covers the fixture origin", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"),
    ) as { content_scripts?: Array<{ matches?: string[] }> };
    const matches = manifest.content_scripts?.[0]?.matches ?? [];
    // Whole-browser scoping (user-approved): <all_urls> covers the fixture
    // origins (127.0.0.1:8080, localhost:8080) plus every other http(s) site.
    // Restricted surfaces (chrome://, web store, PDFs) stay guarded by the
    // page-support policy, not by the matcher.
    expect(matches).toContain("<all_urls>");
  });

  it("check 2 — no cross-origin iframe/shadow encapsulation on task paths", () => {
    const doc = loadPage();
    expect(doc.querySelectorAll("iframe,frame,embed,object").length).toBe(0);
    const hosts = [...doc.querySelectorAll("*")].filter(
      (el) => (el as HTMLElement).shadowRoot !== null,
    );
    expect(hosts.length).toBe(0);
  });

  it("check 3 — no CAPTCHA/payment in demo paths; OTP field documented out of scope", () => {
    const doc = loadPage();
    const haystack = (doc.body.innerHTML + HTML).toLowerCase();
    expect(haystack).not.toContain("captcha");
    expect(haystack).not.toContain("card-number");
    expect(haystack).not.toContain("cc-number");
    // The OTP field exists for sensitive-path testing (Phase 5/6) and is
    // EXCLUDED from both demo scripts by scoped rule (recorded in the doc).
    const otp = doc.querySelector('input[autocomplete="one-time-code"]');
    expect(otp).not.toBeNull();
  });

  it("check 4 — accessible names are static and deterministic", () => {
    const namesOf = (): string[] => {
      const doc = loadPage();
      const { items } = collectInteractives(doc);
      return items.map((el) => computeAccessibleName(el, doc).name);
    };
    const first = namesOf();
    expect(namesOf()).toEqual(first); // reload-stable by construction
    expect(namesOf()).toEqual(first);
    // Result links come from a static literal array, not fetched content.
    expect(APP_JS).toContain("TUTORIALS");
  });

  it("check 5 — dynamic settles fit verification budgets (≤3000ms)", () => {
    const delays = [...APP_JS.matchAll(/setTimeout\s*\([\s\S]*?,\s*(\d+)\s*\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(3000);
    }
    const doc = loadPage();
    expect(doc.querySelectorAll("[aria-busy]").length).toBeGreaterThan(0);
  });

  it("check 6 — Layer A weight fits the 1MB per-tab cap with huge headroom", () => {
    const doc = loadPage();
    const { items } = collectInteractives(doc);
    const reg = new ElementRegistry();
    reg.rebuild(
      items.map((element) => ({
        element,
        role: "link",
        name: "x",
        states: {},
        field: null,
      })),
    );
    const bytes = JSON.stringify(reg.snapshot()).length;
    expect(bytes).toBeLessThan(100 * 1024); // 100KB internal bar, 10x under cap
  });

  it("demo-readiness — every interactive on task paths has a real name", () => {
    const doc = loadPage();
    const { items } = collectInteractives(doc);
    expect(items.length).toBeGreaterThan(10); // search + form + modal + results
    const unnamed = items.filter(
      (el) => computeAccessibleName(el, doc).name === "",
    );
    expect(unnamed).toEqual([]);
  });

  it("demo-readiness — required fields are label-associated (never weak/none)", () => {
    const doc = loadPage();
    const required = [...doc.querySelectorAll("input[required]")];
    expect(required.length).toBeGreaterThan(0);
    for (const el of required) {
      const named = computeAccessibleName(el, doc);
      expect(["label", "labelledby", "aria-label"].includes(named.source)).toBe(true);
    }
  });

  it("demo-readiness — modal is a real dialog with a close path", () => {
    const doc = loadPage();
    const dialog = doc.querySelector("dialog#info-dialog");
    expect(dialog).not.toBeNull();
    expect(doc.querySelector("#open-modal")).not.toBeNull();
    expect(doc.querySelector("#close-modal")).not.toBeNull();
  });
});
