import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VaporText } from "@/components/ui/countdown-vapor-digits";

function markup(words: readonly string[], labels?: readonly string[]) {
  return renderToStaticMarkup(
    <VaporText words={words} labels={labels} className="text-4xl" />,
  );
}

function glyphs(html: string): number {
  return html.split("justify-self-center").length - 1;
}

describe("VaporText", () => {
  it("renders one glyph cell per character plus a screen reader label", () => {
    const html = markup(["BY VOICE"]);
    expect(glyphs(html)).toBe(8);
    expect(html).toContain('<span class="sr-only">BY VOICE</span>');
  });

  it("pads short words so every word shares one grid", () => {
    const html = markup(["HI", "HELLO"]);
    expect(glyphs(html)).toBe(5);
    expect(html).toContain('<span class="sr-only">HI</span>');
  });

  it("keeps spaces as cells but drops them from the spoken label", () => {
    const html = markup(["OUT LOUD"]);
    expect(glyphs(html)).toBe(8);
    expect(html).toContain(" ");
    expect(html).toContain('<span class="sr-only">OUT LOUD</span>');
  });

  it("renders a caption under every cell when labels are given", () => {
    const html = markup(["STOP"], ["S", "T", "O", "P"]);
    expect(glyphs(html)).toBe(8);
    expect(html).toContain(">S<");
  });
});
