/**
 * Visual focus/target highlighting (PRD 6.1; secondary output for low-vision
 * users and demos). Inline styles only — no stylesheet injection, no CSP risk.
 * Audio remains primary; highlighting never gates blind-user operation.
 */
const ATTR = "data-vl-highlight";

export function highlight(el: Element): void {
  clearHighlight();
  if (!(el instanceof HTMLElement)) return;
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    // Non-scrollable test DOM: highlighting still applies.
  }
  el.style.outline = "3px solid #1a73e8";
  el.style.outlineOffset = "2px";
  el.setAttribute(ATTR, "true");
}

export function clearHighlight(): void {
  document.querySelectorAll(`[${ATTR}]`).forEach((node) => {
    if (node instanceof HTMLElement) {
      node.style.outline = "";
      node.style.outlineOffset = "";
    }
    (node as Element).removeAttribute(ATTR);
  });
}
