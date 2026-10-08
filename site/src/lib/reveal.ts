import * as React from "react";

export function revealProps(delay = 0): {
  "data-reveal": string;
  style: React.CSSProperties;
} {
  return {
    "data-reveal": "",
    style: { "--reveal-delay": `${delay * 90}ms` } as React.CSSProperties,
  };
}

export function useReveal(): void {
  React.useEffect(() => {
    if (document.documentElement.classList.contains("static")) return;

    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (nodes.length === 0) return;

    if (!("IntersectionObserver" in window)) {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );

    nodes.forEach((node) => observer.observe(node));
    const failsafe = window.setTimeout(() => {
      nodes.forEach((node) => node.classList.add("is-visible"));
    }, 3000);

    return () => {
      observer.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);
}
