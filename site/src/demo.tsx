import { VaporText } from "@/components/ui/countdown-vapor-digits";

const CYCLING = ["BY VOICE", "BY SOUND", "OUT LOUD"];

export function VaporDemo() {
  return (
    <main className="wrap py-16 md:py-24">
      <p className="eyebrow">VaporText / letters</p>

      <section className="mt-10 border-t border-border pt-10">
        <p className="font-mono text-[12px] tracking-[0.14em] text-muted-foreground uppercase">
          Cycling words, 3.6s
        </p>
        <VaporText
          words={CYCLING}
          cycleMs={3600}
          className="mt-6 text-[clamp(3rem,10vw,7rem)]"
        />
      </section>

      <section className="mt-14 border-t border-border pt-10">
        <p className="font-mono text-[12px] tracking-[0.14em] text-muted-foreground uppercase">
          Single word, static
        </p>
        <VaporText words={["INVIZ"]} className="mt-6 text-[clamp(3rem,10vw,7rem)]" />
      </section>

      <section className="mt-14 border-t border-border pt-10">
        <p className="font-mono text-[12px] tracking-[0.14em] text-muted-foreground uppercase">
          Small size, no cycle
        </p>
        <VaporText words={["SPEAK", "LISTEN"]} cycleMs={4200} className="mt-6 text-4xl" />
      </section>

      <p className="mt-14 max-w-[54ch] text-[14px] leading-[1.7] text-muted-foreground">
        With prefers-reduced-motion the canvas is skipped entirely and the
        letters render as plain text. Append ?static to the URL for the same
        behavior during capture.
      </p>
    </main>
  );
}
