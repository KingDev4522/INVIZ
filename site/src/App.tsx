import { useReveal } from "@/lib/reveal";
import { useSmoothScroll } from "@/lib/smooth-scroll";
import { Band, Footer, Install } from "@/sections/Close";
import { Hero, Nav, Stats } from "@/sections/Intro";
import { Capabilities, HowItWorks, Privacy } from "@/sections/Product";

export default function App() {
  useReveal();
  useSmoothScroll();

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-4 focus:z-50 focus:bg-inverse focus:px-4 focus:py-2 focus:text-sm focus:text-inverse-foreground"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Stats />
        <HowItWorks />
        <Capabilities />
        <Privacy />
        <Band />
        <Install />
      </main>
      <Footer />
    </>
  );
}
