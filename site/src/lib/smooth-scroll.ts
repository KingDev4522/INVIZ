import * as React from "react";
import Lenis from "lenis";

const NAV_OFFSET = 84;

function isReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useSmoothScroll(): void {
  React.useEffect(() => {
    if (document.documentElement.classList.contains("static")) return;

    let lenis: Lenis | null = null;

    const mount = () => {
      if (lenis !== null || isReduced()) return;
      lenis = new Lenis({
        autoRaf: true,
        anchors: { offset: -NAV_OFFSET },
        duration: 1.1,
        smoothWheel: true,
        syncTouch: false,
      });
    };

    const unmount = () => {
      lenis?.destroy();
      lenis = null;
    };

    const sync = () => {
      if (isReduced()) unmount();
      else mount();
    };

    mount();

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", sync);

    return () => {
      mq.removeEventListener("change", sync);
      unmount();
    };
  }, []);
}
