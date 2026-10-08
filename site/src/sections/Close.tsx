import { ButtonLink } from "@/components/ui/button";
import { revealProps } from "@/lib/reveal";

const SHORTCUTS = [
  {
    action: "VoiceLens on/off",
    win: "Ctrl+Shift+Y",
    mac: "Cmd+Shift+Y",
  },
  {
    action: "Start one voice turn",
    win: "Ctrl+Shift+V",
    mac: "Cmd+Shift+V",
  },
  {
    action: "Stop speech and cancel",
    win: "Ctrl+Shift+X",
    mac: "Cmd+Shift+X",
  },
  {
    action: "Repeat last announcement",
    win: "Alt+Shift+R",
    mac: "Alt+Shift+R",
  },
];

const FOOTER_LINKS = [
  { href: "https://github.com/KingDev4522/INVIZ", label: "GitHub" },
  {
    href: "https://github.com/KingDev4522/INVIZ/blob/main/docs/quick-start.md",
    label: "Quick start",
  },
  {
    href: "https://github.com/KingDev4522/INVIZ/blob/main/backend/README.md",
    label: "Backend README",
  },
];

export function Band() {
  return (
    <section className="bg-inverse py-20 text-inverse-foreground md:py-28">
      <div className="wrap max-w-[900px]">
        <p
          {...revealProps(0)}
          className="text-[clamp(2rem,4.4vw,3.5rem)] leading-[1.08] font-semibold tracking-[-0.035em]"
        >
          You are always in charge.
        </p>
        <p
          {...revealProps(1)}
          className="mt-6 max-w-[54ch] text-[16px] leading-[1.65] opacity-70"
        >
          Your own Tab, click, or typing pauses the agent immediately. The stop
          shortcut halts the task, the speech, and the capture.
        </p>
      </div>
    </section>
  );
}

export function Install() {
  return (
    <section id="install" className="py-20 md:py-28">
      <div className="wrap">
        <div {...revealProps(0)} className="max-w-[54ch]">
          <h2 className="text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.03em]">
            Run it locally.
          </h2>
          <p className="mt-5 text-[16px] leading-[1.65] text-muted-foreground">
            Node.js 20 or newer and Chrome 116 or newer. The backend and the
            extension both build from this repository.
          </p>
        </div>

        <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-16">
          <div {...revealProps(0)}>
            <pre className="overflow-x-auto border border-border bg-muted p-5 font-mono text-[13px] leading-[1.9]">
              <code>
                {"npm install\nnpm run build --workspace=frontend"}
              </code>
            </pre>
            <p className="mt-5 max-w-[46ch] text-[15px] leading-[1.65] text-muted-foreground">
              Open chrome://extensions, turn on Developer mode, choose Load
              unpacked, and select frontend/dist.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <ButtonLink href="https://github.com/KingDev4522/INVIZ/blob/main/docs/quick-start.md">
                Quick start
              </ButtonLink>
              <ButtonLink
                href="https://github.com/KingDev4522/INVIZ"
                variant="outline"
              >
                View on GitHub
              </ButtonLink>
            </div>
          </div>

          <div {...revealProps(1)}>
            <table className="w-full border-collapse text-left text-[14px]">
              <caption className="mb-4 text-left font-mono text-[12px] tracking-[0.14em] text-muted-foreground uppercase">
                Keyboard shortcuts, remappable in Chrome
              </caption>
              <thead>
                <tr className="border-y border-border text-muted-foreground">
                  <th scope="col" className="py-3 pr-4 font-medium">
                    Action
                  </th>
                  <th scope="col" className="py-3 pr-4 font-medium">
                    Windows / Linux
                  </th>
                  <th scope="col" className="py-3 font-medium">
                    macOS
                  </th>
                </tr>
              </thead>
              <tbody>
                {SHORTCUTS.map((row) => (
                  <tr key={row.action} className="border-b border-border">
                    <th
                      scope="row"
                      className="py-3 pr-4 text-left font-normal text-muted-foreground"
                    >
                      {row.action}
                    </th>
                    <td className="py-3 pr-4 font-mono text-[13px]">{row.win}</td>
                    <td className="py-3 font-mono text-[13px]">{row.mac}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="relative isolate overflow-hidden bg-black text-[#fafafa]">
      <img
        src="./footer-inviz.jpg"
        alt=""
        width={1838}
        height={856}
        loading="eager"
        decoding="sync"
        className="absolute inset-0 z-0 h-full w-full object-cover object-center"
      />

      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 z-10 h-40 backdrop-blur-[6px] md:h-56"
        style={{
          background:
            "linear-gradient(to bottom, var(--background) 0%, color-mix(in srgb, var(--background) 55%, transparent) 42%, transparent 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 z-10 h-3/5"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.74) 38%, transparent 100%)",
        }}
      />

      <div className="wrap relative z-20 flex min-h-[440px] flex-col justify-end pt-40 pb-12 md:min-h-[600px] md:pt-56 md:pb-16">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_auto] md:items-start">
          <div>
            <p className="font-mono text-[15px] font-semibold tracking-[0.18em]">
              INVIZ
            </p>
            <p className="mt-3 max-w-[36ch] text-[14px] leading-[1.6] text-white/65">
              A Chrome extension and a local AI gateway. Keys stay in your
              backend.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-col gap-3 text-[14px]">
            {FOOTER_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-white/65 transition-colors hover:text-white"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex flex-wrap gap-3">
            <ButtonLink
              href="#install"
              className="bg-white text-black focus-visible:ring-white/70 hover:bg-white/85"
            >
              Get started
            </ButtonLink>
            <ButtonLink
              href="https://github.com/KingDev4522/INVIZ"
              variant="outline"
              className="border-white/30 text-white hover:border-white/60 focus-visible:ring-white/70"
            >
              View on GitHub
            </ButtonLink>
          </div>
        </div>
      </div>
    </footer>
  );
}

