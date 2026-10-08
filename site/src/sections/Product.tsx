import * as React from "react";
import shotConfirm from "@/assets/shot-confirm.png";
import shotOptions from "@/assets/shot-options.png";
import { revealProps } from "@/lib/reveal";

const FLOW = [
  {
    name: "Speak",
    body: "Press the voice shortcut and say what you need. A high blip means the mic is open.",
  },
  {
    name: "Transcribe",
    body: "Whisper turns the capture into text through your backend.",
  },
  {
    name: "Reason",
    body: "A local model answers first. Cloud stands by and is used only when local fails.",
  },
  {
    name: "Act",
    body: "Clicks, fills, and navigation are guarded, budgeted, then checked against the page.",
  },
  {
    name: "Narrate",
    body: "The browser's own voice speaks every step, so no speech quota is spent.",
  },
];

const GLOW = {
  background:
    "radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--foreground) 7%, transparent), transparent 68%)",
};

export function HowItWorks() {
  const listRef = React.useRef<HTMLOListElement | null>(null);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (document.documentElement.classList.contains("static")) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const steps = Array.from(list.querySelectorAll<HTMLElement>("[data-step]"));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle("is-active", entry.isIntersecting);
        });
      },
      { rootMargin: "-38% 0px -48% 0px", threshold: 0 },
    );
    steps.forEach((step) => observer.observe(step));
    return () => observer.disconnect();
  }, []);

  return (
    <section id="how" className="py-20 md:py-28">
      <div className="wrap grid gap-12 md:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] md:gap-16 lg:gap-24">
        <div
          {...revealProps(0)}
          className="md:sticky md:top-[112px] md:self-start"
        >
          <p className="eyebrow">How it works</p>
          <h2 className="mt-4 max-w-[15ch] text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.03em]">
            Every turn runs the same loop.
          </h2>
          <p className="mt-5 max-w-[42ch] text-[16px] leading-[1.65] text-muted-foreground">
            One shortcut starts a turn. The agent reads the page and reports
            each step until the task finishes, you answer, or you say stop.
          </p>
          <p className="mt-8 font-mono text-[12px] tracking-[0.16em] text-muted-foreground uppercase">
            01 → 05 → 01, every turn
          </p>
        </div>

        <div className="relative">
          <span
            aria-hidden="true"
            className="absolute top-2 bottom-2 left-0 w-px bg-border"
          />
          <ol ref={listRef} className="relative">
            {FLOW.map((step, i) => (
              <li
                key={step.name}
                data-step
                {...revealProps(i)}
                className="relative pb-11 pl-8 last:pb-0 md:pl-10"
              >
                <span
                  aria-hidden="true"
                  className="step-dot absolute top-[7px] left-0 size-[7px] -translate-x-1/2"
                />
                <p className="step-num font-mono text-[12px] tracking-[0.16em]">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-2 text-[22px] font-semibold tracking-[-0.02em] md:text-[26px]">
                  {step.name}
                </h3>
                <p className="mt-2 max-w-[48ch] text-[15px] leading-[1.65] text-muted-foreground">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

export function Capabilities() {
  return (
    <section id="capabilities" className="border-t border-border py-20 md:py-28">
      <div className="wrap">
        <div {...revealProps(0)} className="max-w-[54ch]">
          <p className="eyebrow">Capabilities</p>
          <h2 className="mt-4 text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.03em]">
            What INVIZ does on a live page.
          </h2>
        </div>

        <div className="mt-12 grid gap-px border border-border bg-border md:grid-cols-12">
          <article className="flex flex-col bg-background md:col-span-7 md:row-span-2">
            <img
              src={shotConfirm}
              alt="The INVIZ voice overlay asking whether to submit an application form."
              width={2200}
              height={1600}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full border-b border-border"
            />
            <div className="flex-1 p-6 md:p-8">
              <h3 className="text-[20px] font-semibold tracking-[-0.02em]">
                It asks before it acts
              </h3>
              <p className="mt-3 max-w-[48ch] text-[15px] leading-[1.6] text-muted-foreground">
                Anything consequential is read back as a question. Answer out
                loud, or say stop.
              </p>
            </div>
          </article>

          <article
            {...revealProps(1)}
            className="bg-background p-6 md:col-span-5 md:p-8"
            style={GLOW}
          >
            <div>
              <h3 className="text-[20px] font-semibold tracking-[-0.02em]">
                Local first
              </h3>
              <p className="mt-3 text-[15px] leading-[1.6] text-muted-foreground">
                Ollama answers when it is up. OpenRouter and Groq stand by and
                are contacted only after local fails.
              </p>
            </div>
          </article>

          <article
            {...revealProps(2)}
            className="bg-background p-6 md:col-span-5 md:p-8"
          >
            <div>
              <h3 className="text-[20px] font-semibold tracking-[-0.02em]">
                Search when the page cannot
              </h3>
              <p className="mt-3 text-[15px] leading-[1.6] text-muted-foreground">
                Ask something the page cannot answer and the agent searches the
                web itself, then replies from the results.
              </p>
            </div>
          </article>

          <article
            {...revealProps(1)}
            className="bg-background p-6 md:col-span-4 md:p-8"
          >
            <div>
              <h3 className="text-[20px] font-semibold tracking-[-0.02em]">
                Three languages
              </h3>
              <p className="mt-3 text-[15px] leading-[1.6] text-muted-foreground">
                Confirmations, questions, and narration in English, Hindi, and
                Hinglish.
              </p>
            </div>
          </article>

          <article
            {...revealProps(2)}
            className="bg-background p-6 md:col-span-8 md:p-8"
          >
            <div>
              <h3 className="text-[20px] font-semibold tracking-[-0.02em]">
                Stop with one key
              </h3>
              <p className="mt-3 max-w-[52ch] text-[15px] leading-[1.6] text-muted-foreground">
                The stop shortcut cancels the task, the speech, and the
                capture. Manual input pauses the agent.
              </p>
              <p
                aria-hidden="true"
                className="mt-5 flex flex-wrap gap-2 font-mono text-[12px]"
              >
                {["Ctrl", "Shift", "X"].map((key) => (
                  <span
                    key={key}
                    className="border border-border-strong px-2 py-1 tracking-[0.08em]"
                  >
                    {key}
                  </span>
                ))}
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

export function Privacy() {
  return (
    <section id="privacy" className="border-t border-border py-20 md:py-28">
      <div className="wrap grid items-center gap-10 md:grid-cols-2 md:gap-16">
        <div {...revealProps(0)}>
          <p className="eyebrow">Privacy</p>
          <h2 className="mt-4 max-w-[16ch] text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.03em]">
            The browser never holds a key.
          </h2>
          <p className="mt-5 max-w-[46ch] text-[16px] leading-[1.65] text-muted-foreground">
            Provider keys live in backend/.env on your machine. The extension
            stores only a backend address and an optional token.
          </p>
          <p className="mt-4 max-w-[46ch] text-[14px] leading-[1.65] text-muted-foreground">
            Every request crosses a typed REST boundary, and the backend
            answers with capability counts instead of values, so nothing
            sensitive is ever logged.
          </p>
        </div>
        <figure
          {...revealProps(1)}
          className="overflow-hidden border border-border bg-muted"
        >
          <img
            src={shotOptions}
            alt="The INVIZ options page stating that the extension holds no provider keys."
            width={2200}
            height={1374}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
          />
        </figure>
      </div>
    </section>
  );
}
