/**
 * EXPERIMENTAL (CONTEXT_MODE=hybrid): serializeRegistry contract tests.
 *
 * The registry serializer is the ONLY new context view the model gets. These
 * tests pin the properties that keep it a view of the one authoritative target
 * registry rather than a second system that could drift:
 *
 *  - ids are echoed, never renumbered or deduped;
 *  - generation is always present (WebGuard freshness needs it);
 *  - sensitive field kinds are printed; values never are;
 *  - the cap is honest about what it dropped.
 */
import { describe, expect, it } from "vitest";
import { serializeRegistry } from "./hybrid-registry.js";
import type { BudgetItem, ProseRegionInput } from "./context-budget.js";
import { MAX_ELEMENT_CANDIDATES } from "../../../shared/constants.js";

function item(partial: Partial<BudgetItem> & { id: string }): BudgetItem {
  return {
    role: "generic",
    name: "",
    states: {},
    fieldKind: null,
    sensitive: false,
    ...partial,
  };
}

const BASE = {
  url: "https://example.test/checkout",
  title: "Checkout",
  generation: 42,
};

describe("serializeRegistry — target identity", () => {
  it("echoes the supplied eNN ids verbatim (no renumbering)", () => {
    const out = serializeRegistry({
      ...BASE,
      items: [
        item({ id: "e7", role: "button", name: "Pay now" }),
        item({ id: "e12", role: "link", name: "Back" }),
        item({ id: "e103", role: "textbox", name: "Email" }),
      ],
    });
    expect(out.text).toContain("e7 button \"Pay now\"");
    expect(out.text).toContain("e12 link \"Back\"");
    expect(out.text).toContain("e103 textbox \"Email\"");
    expect(out.includedItems).toBe(3);
  });

  it("NEVER dedupes identical controls — both keep their own id", () => {
    // Two visually identical "Star" buttons are two registry entries with two
    // ids. Folding them would make the registry a subset of what the
    // screenshot shows and manufacture hallucinated-target failures.
    const out = serializeRegistry({
      ...BASE,
      items: [
        item({ id: "e1", role: "button", name: "Star" }),
        item({ id: "e2", role: "button", name: "Star" }),
      ],
    });
    expect(out.text).toContain("e1 button \"Star\"");
    expect(out.text).toContain("e2 button \"Star\"");
    expect(out.includedItems).toBe(2);
  });

  it("declares the exact count so the model cannot invent ids beyond it", () => {
    const out = serializeRegistry({
      ...BASE,
      items: [item({ id: "e1" }), item({ id: "e2" })],
    });
    expect(out.text).toContain("TARGETS: 2 of 2 executable element ids (eNN).");
    expect(out.text).toContain("Ids not listed here do not exist.");
  });
});

describe("serializeRegistry — safety signals", () => {
  it("always carries generation (WebGuard freshness depends on it)", () => {
    const out = serializeRegistry({ ...BASE, items: [] });
    expect(out.text).toContain("PAGE url=https://example.test/checkout title=\"Checkout\" generation=42");
  });

  it("prints sensitive field kinds — a safety signal, not budget", () => {
    const out = serializeRegistry({
      ...BASE,
      items: [item({ id: "e3", role: "textbox", name: "Card number", fieldKind: "password", sensitive: true })],
    });
    expect(out.text).toContain("e3 textbox \"Card number\" <password>");
  });

  it("never serializes a field value, even if one reaches it", () => {
    const out = serializeRegistry({
      ...BASE,
      items: [item({ id: "e3", role: "textbox", name: "Card number", value: "4111111111111111" })],
    });
    expect(out.text).not.toContain("4111111111111111");
    expect(out.text).toContain("<redacted>");
  });

  it("prints element state (disabled) so the model does not click dead controls", () => {
    const out = serializeRegistry({
      ...BASE,
      items: [item({ id: "e4", role: "button", name: "Submit", states: { disabled: true } })],
    });
    expect(out.text).toContain("e4 button \"Submit\" [disabled=true]");
  });
});

describe("serializeRegistry — cap honesty", () => {
  it("reports both included and omitted counts when the cap bites", () => {
    const many = Array.from({ length: MAX_ELEMENT_CANDIDATES + 5 }, (_, i) =>
      item({ id: `e${i + 1}`, role: "link", name: `L${i + 1}` }),
    );
    const out = serializeRegistry({ ...BASE, items: many });
    expect(out.includedItems).toBe(MAX_ELEMENT_CANDIDATES);
    expect(out.omittedItems).toBe(5);
    expect(out.text).toContain(`TARGETS: ${MAX_ELEMENT_CANDIDATES} of ${many.length}`);
    expect(out.text).toContain("[5 additional targets omitted by context cap]");
    expect(out.text).toContain("e1 link \"L1\"");
    expect(out.text).not.toContain("e1001 ");
  });
});

describe("serializeRegistry — prose (read capability)", () => {
  const region: ProseRegionInput = {
    id: "r1",
    label: "main",
    text: "Your total is $42. ".repeat(50),
    chars: 1000,
  };

  it("omits prose entirely when the caller did not ask for it", () => {
    const out = serializeRegistry({ ...BASE, items: [] });
    expect(out.text).not.toContain("PROSE");
    expect(out.includedRegions).toBe(0);
  });

  it("passes read regions through with their rNN ids", () => {
    const out = serializeRegistry({ ...BASE, items: [], prose: [region] });
    expect(out.text).toContain("PROSE (readable page text — use these region ids for read actions):");
    expect(out.text).toContain("r1 \"main\" (1000 chars):");
    expect(out.includedRegions).toBe(1);
  });

  it("truncates each region body so one region cannot eat the budget", () => {
    const out = serializeRegistry({ ...BASE, items: [], prose: [region] });
    const body = out.text.slice(out.text.indexOf("(1000 chars):"));
    expect(body.length).toBeLessThan(500);
  });
});

describe("serializeRegistry — drops structural furniture (screenshot conveys it)", () => {
  it("does not emit landmark/heading/form sections", () => {
    const out = serializeRegistry({
      ...BASE,
      items: [item({ id: "e1", role: "heading", name: "Order summary" })],
    });
    expect(out.text).not.toContain("LANDMARKS:");
    expect(out.text).not.toContain("HEADINGS:");
    expect(out.text).not.toContain("FORMS:");
    // The element itself is still a target if it carries an id.
    expect(out.text).toContain("e1 heading \"Order summary\"");
  });
});
