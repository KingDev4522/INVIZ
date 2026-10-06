/**
 * Context budget tests (PRD 6.4 §1.3; PRD 6 §4.5).
 * Cap enforcement, priority order, value-payload refusal, cut-logging.
 * Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  serializePage,
  type BudgetInput,
} from "./context-budget.js";
import { MAX_ELEMENT_CANDIDATES, QWEN_INPUT_TOKEN_BUDGET } from "../../../shared/constants.js";

function item(id: string, role: string, fieldKind: string | null = null): BudgetInput["items"][number] {
  return { id, role, name: `${role} ${id}`, states: {}, fieldKind, sensitive: false };
}

const base: BudgetInput = {
  url: "https://example.com/apply",
  title: "Apply",
  generation: 7,
  items: [
    item("e1", "link"),
    item("e2", "textbox", "text"),
    item("e3", "button"),
  ],
  headings: [{ level: 1, text: "Application" }],
  landmarks: [{ role: "main", name: "" }],
  forms: [{ name: "Apply", fieldCount: 2 }],
};

describe("serializePage", () => {
  it("fits small pages whole with zero cuts", () => {
    const out = serializePage(base);
    expect(out.cut.droppedItems).toBe(0);
    expect(out.cut.droppedHeadings).toBe(0);
    expect(out.includedItems).toBe(3);
    expect(out.text).toContain("generation=7");
    expect(out.estimatedTokens).toBeLessThanOrEqual(QWEN_INPUT_TOKEN_BUDGET);
  });

  it("prioritizes focus, then fields, then the rest", () => {
    const out = serializePage({ ...base, focusId: "e3" }, 400);
    const firstElementLine = out.text.split("\n").find((l) => l.startsWith("e"));
    expect(firstElementLine?.startsWith("e3")).toBe(true);
  });

  it("enforces the token cap with an explicit cut-log on huge pages", () => {
    const huge: BudgetInput = {
      ...base,
      items: Array.from({ length: 5000 }, (_, i) =>
        item(`e${i + 1}`, "link"),
      ),
    };
    const out = serializePage(huge);
    expect(out.estimatedTokens).toBeLessThanOrEqual(QWEN_INPUT_TOKEN_BUDGET);
    expect(out.includedItems).toBeLessThanOrEqual(MAX_ELEMENT_CANDIDATES);
    // 5000 items → the cap, the rest recorded as capped (not silently lost).
    expect(out.cut.cappedItems).toBe(5000 - MAX_ELEMENT_CANDIDATES);
    expect(out.includedItems + out.cut.droppedItems + out.cut.cappedItems).toBe(5000);
  });

  // A real GitHub repo page carries 22 identical "Star" links, 18 "Fork" and 12
  // avatars. Those lines cannot be told apart by the model, so they were pure
  // distraction — and on a 3B model, measurable id-guessing noise.
  describe("dedupe of identical controls", () => {
    const repetitive: BudgetInput = {
      ...base,
      items: [
        ...Array.from({ length: 22 }, (_, i) => ({
          ...item(`s${i + 1}`, "link"),
          name: "Star",
        })),
        ...Array.from({ length: 18 }, (_, i) => ({
          ...item(`f${i + 1}`, "link"),
          name: "Fork",
        })),
      ],
    };

    it("collapses identical role+name into one line carrying the count", () => {
      const out = serializePage(repetitive);
      expect(out.text).toContain("[+21 more identical]");
      expect(out.text).toContain("[+17 more identical]");
      // One line per group, not one per element.
      expect(out.text.match(/link "Star"/g)).toHaveLength(1);
      expect(out.text.match(/link "Fork"/g)).toHaveLength(1);
    });

    it("keeps the highest-priority occurrence usable as a target", () => {
      const out = serializePage(repetitive);
      expect(out.text).toContain("s1 link \"Star\"");
      expect(out.text).not.toContain("s7 link \"Star\"");
    });

    it("reports the folded count so nothing is silently lost", () => {
      const out = serializePage(repetitive);
      expect(out.cut.dedupedItems).toBe(21 + 17);
      expect(out.includedItems + out.cut.dedupedItems).toBe(40);
    });

    it("leaves distinct controls untouched", () => {
      const out = serializePage(base);
      expect(out.cut.dedupedItems).toBe(0);
      expect(out.text).not.toContain("more identical");
    });
  });

  // Live bug: the serialized page carried no prose at all, so the model was
  // asked to read or answer about article content it had never received.
  describe("prose inclusion", () => {
    const prose: BudgetInput["prose"] = [
      { id: "r1", label: "Understanding Screen Readers", text: "A screen reader reads text aloud so people who cannot see the screen can navigate the page by ear.", chars: 108 },
    ];

    it("includes prose regions with their readable ids", () => {
      const out = serializePage({ ...base, prose });
      expect(out.text).toContain("PROSE");
      expect(out.text).toContain('r1 "Understanding Screen Readers"');
      expect(out.text).toContain("A screen reader reads text aloud");
      expect(out.cut.proseChars).toBeGreaterThan(0);
    });

    it("keeps prose that fits whole, with no truncation marker", () => {
      const body = "Sentence of article prose. ".repeat(200);
      const out = serializePage({
        ...base,
        prose: [{ id: "r1", label: "Fits", text: body, chars: body.length }],
      });
      expect(out.text).toContain(body);
      expect(out.text).not.toContain("…");
      expect(out.cut.proseChars).toBe(body.length);
    });

    it("truncates prose that exceeds the budget but keeps the region addressable", () => {
      // Far larger than the 10k-token input cap.
      const long = "word ".repeat(40000);
      const out = serializePage({
        ...base,
        prose: [{ id: "r1", label: "Long", text: long, chars: long.length }],
      });
      expect(out.text).toContain('r1 "Long"');
      expect(out.text).toContain("…");
      expect(out.text.length).toBeLessThan(long.length);
      expect(out.cut.proseChars).toBeGreaterThan(0);
      expect(out.estimatedTokens).toBeLessThanOrEqual(QWEN_INPUT_TOKEN_BUDGET);
    });

    it("still enforces the token cap with prose present", () => {
      const many = Array.from({ length: 40 }, (_, i) => ({
        id: `r${i + 1}`,
        label: `Region ${i + 1}`,
        text: "Sentence of body prose here. ".repeat(200),
        chars: 6000,
      }));
      const out = serializePage({ ...base, prose: many });
      expect(out.estimatedTokens).toBeLessThanOrEqual(QWEN_INPUT_TOKEN_BUDGET);
    });

    it("reports zero prose chars when the page has no prose", () => {
      const out = serializePage(base);
      expect(out.cut.proseChars).toBe(0);
      expect(out.text).not.toContain("PROSE");
    });

    it("refuses an item carrying a value payload even with prose present", () => {
      expect(() =>
        serializePage({
          ...base,
          items: [{ ...item("e9", "textbox", "password"), value: "hunter2" }],
          prose,
        }),
      ).toThrow(/refusing to serialize value payload/);
    });

    it("never puts a secret in prose output", () => {
      const out = serializePage({ ...base, prose });
      expect(out.text).not.toMatch(/password|secret|token/i);
    });
  });

  it("records budget drops when items do not fit even under the cap", () => {
    const heavy: BudgetInput = {
      ...base,
      items: Array.from({ length: 120 }, (_, i) => ({
        ...item(`e${i + 1}`, "link"),
        name: `Result link number ${i + 1} ` + "with a very long accessible name ".repeat(40),
      })),
    };
    const out = serializePage(heavy);
    expect(out.estimatedTokens).toBeLessThanOrEqual(QWEN_INPUT_TOKEN_BUDGET);
    expect(out.cut.droppedItems).toBeGreaterThan(0);
  });

  it("refuses value payloads structurally (never serialized)", () => {
    const poisoned: BudgetInput = {
      ...base,
      items: [{ ...item("e9", "textbox", "password"), value: "secret123" }],
    };
    expect(() => serializePage(poisoned)).toThrow(/refusing to serialize/);
  });

  it("estimates conservatively", () => {
    expect(estimateTokens("x".repeat(400))).toBeGreaterThanOrEqual(100);
  });
});
