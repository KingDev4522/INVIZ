import shotThink from "@/assets/shot-think.png";
import { ButtonLink } from "@/components/ui/button";
import { VaporText } from "@/components/ui/countdown-vapor-digits";
import { revealProps } from "@/lib/reveal";

const NAV_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#capabilities", label: "Capabilities" },
  { href: "#privacy", label: "Privacy" },
  { href: "#install", label: "Install" },
];

const HERO_WORDS = ["BY VOICE", "BY SOUND", "OUT LOUD"];

const STATS = [
  { value: "16/16", label: "security cases pass in the shipped suite" },
  { value: "0", label: "provider keys shipped to the browser" },
  { value: "25", label: "action ceiling per task" },
  { value: "3", label: "languages supported" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="wrap flex h-[68px] items-center gap-8">
        <a
          href="#top"
          className="font-mono text-[15px] font-semibold tracking-[0.18em]"
        >
          INVIZ
        </a>
        <nav
          aria-label="Primary"
          className="ml-auto hidden items-center gap-7 text-[14px] text-muted-foreground md:flex"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <ButtonLink href="#install" className="ml-auto md:ml-0">
          Get started
        </ButtonLink>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section className="pt-14 pb-16 md:pt-24 md:pb-24">
      <div className="wrap grid items-center gap-10 md:grid-cols-[0.92fr_1.08fr] md:gap-14">
        <div>
          <h1
            {...revealProps(0)}
            className="max-w-[14ch] text-[clamp(2.5rem,5.4vw,4.5rem)] leading-[1.04] font-semibold tracking-[-0.035em]"
          >
            <span className="block">Navigate the web</span>
            <VaporText
              words={HERO_WORDS}
              cycleMs={3600}
              className="mt-2 text-[clamp(2.5rem,5.4vw,4.5rem)]"
            />
          </h1>
          <p
            {...revealProps(1)}
            className="mt-6 max-w-[46ch] text-[17px] leading-[1.6] text-muted-foreground"
          >
            INVIZ reads the page, follows your spoken instructions, and asks
            before anything consequential. Provider keys never reach the
            browser.
          </p>
          <div {...revealProps(2)} className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="#install">Get started</ButtonLink>
            <ButtonLink
              href="https://github.com/KingDev4522/INVIZ"
              variant="outline"
            >
              View on GitHub
            </ButtonLink>
          </div>
        </div>

        <figure
          {...revealProps(2)}
          className="overflow-hidden border border-border bg-muted"
        >
          <img
            src={shotThink}
            alt="A web page with the INVIZ voice overlay reporting that it is finding the login button."
            width={2200}
            height={1600}
            fetchPriority="high"
            decoding="async"
            className="block h-auto w-full"
          />
        </figure>
      </div>
    </section>
  );
}

export function Stats() {
  return (
    <section
      aria-label="Project facts"
      className="border-y border-border bg-muted/50"
    >
      <div className="wrap grid grid-cols-2 md:grid-cols-4">
        {STATS.map((stat, i) => (
          <div
            key={stat.value + stat.label}
            {...revealProps(i)}
            className="border-border px-1 py-7 [&:nth-child(even)]:border-l md:border-l md:first:border-l-0 md:px-6 md:first:pl-0"
          >
            <p className="font-mono text-[clamp(1.75rem,3vw,2.5rem)] leading-none font-medium tracking-[-0.02em]">
              {stat.value}
            </p>
            <p className="mt-3 max-w-[22ch] text-[13px] leading-[1.5] text-muted-foreground">
              {stat.label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
