/**
 * DOM action performer — REAL (PRD 6.5 §1.3, L2 execution).
 * Runs inside the content script: resolves the registry ID against the LIVE
 * registry at execution instant (second TOCTOU guard), performs exactly one
 * controlled operation, and reports. No selectors from outside, no eval.
 */
import type { StructuredAction } from "../../../shared/types.js";
import type { ElementRegistry } from "./element-registry.js";
import { fieldHasValue } from "./aria-extractor.js";

export interface DomActionResult {
  ok: boolean;
  errorCode?: string;
  detail?: string;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Waits one animation frame + microtask so framework-driven state changes
 * (React setState, aria-checked flip) settle before verification polls.
 * Without this, the first 250ms verification tick can read stale state on
 * switches/checkboxes managed by frameworks that batch DOM updates.
 */
function waitForSettled(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      // One additional microtask lets any rAF-queued framework flush complete.
      void Promise.resolve().then(resolve);
    }),
  );
}

/** Roles whose click toggles state asynchronously (needs settle wait). */
const TOGGLE_ROLES = new Set(["switch", "checkbox", "combobox", "menuitemcheckbox", "menuitemradio", "radio"]);

function isToggleTarget(el: Element): boolean {
  const role = el.getAttribute("role");
  if (role !== null && TOGGLE_ROLES.has(role)) return true;
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return true;
  return false;
}

async function performClick(el: Element): Promise<void> {
  if (el instanceof HTMLElement) {
    el.click();
  } else {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  // Give toggle controls one paint cycle so verification reads the new state.
  if (isToggleTarget(el)) {
    await waitForSettled();
  }
}

function performType(el: Element, value: string, submit: boolean): DomActionResult {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    return { ok: false, errorCode: "ACTION_FAILED", detail: "target is not typable" };
  }
  if (el.disabled || el.readOnly) {
    return { ok: false, errorCode: "ACTION_FAILED", detail: "target not editable" };
  }
  el.focus();
  setNativeValue(el, value);
  if (submit === true) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
    );
  }
  return fieldHasValue(el)
    ? { ok: true }
    : { ok: false, errorCode: "ACTION_FAILED", detail: "value did not land" };
}

function performSelect(
  el: Element,
  option: { by: string; ref: string | number },
): DomActionResult {
  if (!(el instanceof HTMLSelectElement)) {
    return { ok: false, errorCode: "ACTION_FAILED", detail: "target is not a select" };
  }
  const options = [...el.options];
  const match =
    option.by === "index" && typeof option.ref === "number"
      ? options[option.ref] ?? null
      : options.find((o) =>
          option.by === "value" ? o.value === option.ref : o.label === option.ref || o.text === option.ref,
        ) ?? null;
  if (match === null) {
    return { ok: false, errorCode: "ELEMENT_NOT_FOUND", detail: "option not found" };
  }
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

const KEY_MAP: Record<string, { key: string; code: string }> = {
  Enter: { key: "Enter", code: "Enter" },
  Tab: { key: "Tab", code: "Tab" },
  Escape: { key: "Escape", code: "Escape" },
  Space: { key: " ", code: "Space" },
  Backspace: { key: "Backspace", code: "Backspace" },
  Delete: { key: "Delete", code: "Delete" },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp" },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown" },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft" },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight" },
  Home: { key: "Home", code: "Home" },
  End: { key: "End", code: "End" },
  PageUp: { key: "PageUp", code: "PageUp" },
  PageDown: { key: "PageDown", code: "PageDown" },
};

/**
 * Performs one approved DOM action. Registry resolution (with generation
 * check) happens HERE, at execution instant — even WebGuard-approved actions
 * are re-validated against the live document.
 */
export async function performDomAction(
  action: StructuredAction,
  registry: ElementRegistry,
  generation: number,
): Promise<DomActionResult> {
  if (action.target === undefined) {
    return { ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" };
  }
  const resolved = registry.resolve(action.target, generation);
  if (!resolved.ok) {
    return { ok: false, errorCode: resolved.code === "STALE_TARGET" ? "STALE_TARGET" : "ELEMENT_NOT_FOUND" };
  }
  const el = resolved.entry.element;

  switch (action.action) {
    case "click":
      await performClick(el);
      return { ok: true };
    case "focus":
      if (el instanceof HTMLElement) {
        el.focus();
        return { ok: true };
      }
      return { ok: false, errorCode: "ACTION_FAILED" };
    case "type": {
      const params = action.parameters as { submit?: unknown } | undefined;
      return performType(el, action.value ?? "", params?.submit === true);
    }
    case "select": {
      const params = action.parameters as { option?: unknown } | undefined;
      if (
        params?.option === undefined ||
        typeof params.option !== "object" ||
        params.option === null
      ) {
        return { ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" };
      }
      const opt = params.option as { by?: unknown; ref?: unknown };
      if (
        (opt.by !== "label" && opt.by !== "value" && opt.by !== "index") ||
        (typeof opt.ref !== "string" && typeof opt.ref !== "number")
      ) {
        return { ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" };
      }
      return performSelect(el, { by: opt.by, ref: opt.ref });
    }
    case "scroll": {
      const params = action.parameters as
        | { direction?: unknown; amount_px?: unknown }
        | undefined;
      const direction =
        params?.direction === "up" || params?.direction === "down" ||
        params?.direction === "left" || params?.direction === "right"
          ? (params.direction as "up" | "down" | "left" | "right")
          : "down";
      const amount =
        typeof params?.amount_px === "number"
          ? Math.min(Math.max(params.amount_px, 50), 5000)
          : 600;
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center" });
      }
      const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
      window.scrollBy(dx, dy);
      return { ok: true };
    }
    case "press_key": {
      const params = action.parameters as { key?: unknown } | undefined;
      const key = typeof params?.key === "string" ? KEY_MAP[params.key] : undefined;
      if (key === undefined) {
        return { ok: false, errorCode: "SCHEMA_VALIDATION_FAILED" };
      }
      const target = el instanceof HTMLElement ? el : document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: key.key,
          code: key.code,
          bubbles: true,
          cancelable: true,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: key.key,
          code: key.code,
          bubbles: true,
          cancelable: true,
        }),
      );
      return { ok: true };
    }
    default:
      return { ok: false, errorCode: "UNSUPPORTED_ACTION" };
  }
}
