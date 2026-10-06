/**
 * Accessible-name pipeline + field classification (PRD 6.1 §1.1; PRD 4 §9).
 * Priority: label → aria-labelledby → aria-label → native → text → weak
 * (placeholder/title) → none. Page-provided strings stay untrusted content.
 */

import type { FieldInfo, FieldKind } from "./dom-extractor.js";

export type NameSource =
  | "label"
  | "labelledby"
  | "aria-label"
  | "native"
  | "text"
  | "weak"
  | "none";

export interface AccessibleName {
  name: string;
  source: NameSource;
}

const MAX_DEPTH = 5;

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** <label for> association + wrapping label. */
function fromLabel(el: Element, doc: Document): string {
  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    try {
      const labelled = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = labelled?.textContent;
      if (text !== undefined && collapse(text) !== "") {
        return collapse(text).slice(0, 200);
      }
    } catch {
      // Invalid selector characters: fall through.
    }
  }
  const wrapping = el.closest("label");
  const text = wrapping?.textContent;
  if (text !== undefined && collapse(text) !== "") {
    // Exclude the control's own value text for inputs.
    return collapse(text).slice(0, 200);
  }
  return "";
}

function nameFromLabelledBy(
  el: Element,
  doc: Document,
  visited: Set<Element>,
  depth: number,
): string {
  if (depth > MAX_DEPTH) return "";
  const ref = el.getAttribute("aria-labelledby");
  if (ref === null || ref.trim() === "") return "";
  const parts: string[] = [];
  for (const id of ref.trim().split(/\s+/)) {
    if (id === "") continue;
    let target: Element | null = null;
    try {
      target = doc.getElementById(id);
    } catch {
      continue;
    }
    if (target === null || visited.has(target)) continue; // cycle guard
    visited.add(target);
    const nested = target.getAttribute("aria-labelledby");
    if (nested !== null && nested.trim() !== "") {
      parts.push(nameFromLabelledBy(target, doc, visited, depth + 1));
    } else {
      parts.push(collapse(target.textContent ?? ""));
    }
  }
  return collapse(parts.join(" ")).slice(0, 200);
}

function nativeName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "img" || tag === "area") {
    return collapse(el.getAttribute("alt") ?? "");
  }
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "image") return collapse(el.getAttribute("alt") ?? "");
    if (type === "submit" || type === "button" || type === "reset") {
      const v = el.getAttribute("value");
      return collapse(v ?? (type === "submit" ? "Submit" : type));
    }
  }
  return "";
}

function textName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  // Replaced/form elements have no text-name step.
  if (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    tag === "img" ||
    tag === "video" ||
    tag === "audio"
  ) {
    return "";
  }
  return collapse(el.textContent ?? "").slice(0, 200);
}

export function computeAccessibleName(
  el: Element,
  doc: Document = (el.getRootNode() as Document) ?? document,
): AccessibleName {
  const labelled = fromLabel(el, doc);
  if (labelled !== "") return { name: labelled, source: "label" };

  const byIds = nameFromLabelledBy(el, doc, new Set<Element>([el]), 0);
  if (byIds !== "") return { name: byIds, source: "labelledby" };

  const ariaLabel = collapse(el.getAttribute("aria-label") ?? "");
  if (ariaLabel !== "") {
    return { name: ariaLabel.slice(0, 200), source: "aria-label" };
  }

  const native = nativeName(el);
  if (native !== "") return { name: native, source: "native" };

  const text = textName(el);
  if (text !== "") return { name: text, source: "text" };

  const weak = collapse(
    el.getAttribute("placeholder") ?? el.getAttribute("title") ?? "",
  );
  if (weak !== "") return { name: weak.slice(0, 200), source: "weak" };

  return { name: "", source: "none" };
}

// --- Field classification (PRD 4 §29; PRD 6 §5) -------------------------------

const OTP_RE = /otp|one[-_ ]?time|verification[-_ ]?code/i;

function isOtpField(el: Element): boolean {
  if (el.getAttribute("autocomplete") === "one-time-code") return true;
  const haystack = `${el.getAttribute("name") ?? ""} ${el.getAttribute("id") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
  return OTP_RE.test(haystack);
}

/** Classifies form controls. Returns null for non-field elements. */
export function classifyField(el: Element): FieldInfo | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return { kind: "textarea", sensitive: false };
  if (tag === "select") return { kind: "select", sensitive: false };
  if (tag !== "input") {
    if (el.hasAttribute("contenteditable")) return { kind: "text", sensitive: false };
    return null;
  }
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  let kind: FieldKind;
  switch (type) {
    case "email":
      kind = "email";
      break;
    case "password":
      kind = "password";
      break;
    case "number":
      kind = "number";
      break;
    case "checkbox":
      kind = "checkbox";
      break;
    case "radio":
      kind = "radio";
      break;
    case "date":
    case "datetime-local":
    case "month":
    case "time":
    case "week":
      kind = "date";
      break;
    case "file":
      kind = "file";
      break;
    case "hidden":
    case "submit":
    case "button":
    case "reset":
    case "image":
      return null;
    default:
      kind = "text";
      break;
  }
  const sensitive =
    kind === "password" || kind === "file" || isOtpField(el);
  return { kind, sensitive };
}

/**
 * Whether the field currently holds a value — boolean ONLY.
 * Callers must never extract the underlying value of a sensitive field.
 */
export function fieldHasValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return el.value.length > 0;
  }
  if (el instanceof HTMLTextAreaElement) return el.value.length > 0;
  if (el instanceof HTMLSelectElement) return el.selectedIndex >= 0;
  return false;
}
