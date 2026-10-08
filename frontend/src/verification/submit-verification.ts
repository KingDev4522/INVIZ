/**
 * Generic completion signals for side-effecting (submit-style) actions.
 *
 * WHY THIS EXISTS: a Submit/Send/Pay click has no single observable "it worked"
 * element. The form may navigate, swap to a thank-you panel, raise a toast, or
 * simply disable the button. The old default expectation (`element_present` on
 * some id) therefore timed out on most real forms, and the agent responded by
 * CLICKING SUBMIT AGAIN — repeating a non-idempotent side effect.
 *
 * These signals are deliberately GENERIC. They are not one site's wording: they
 * are completion-tense vocabulary and standard ARIA roles that any conforming
 * app emits after a successful side effect.
 *
 * CRITICAL DETAIL: the vocabulary is COMPLETION/P PAST tense only
 * ("submitted", "sent", "applied"). It must never match the action verb itself
 * ("Submit Application"), or every pre-submit state would look successful and
 * verification would pass without the click doing anything.
 */

/**
 * Past/complete-tense success vocabulary. Never include bare imperative verbs
 * that also appear on the button label (submit, send, apply, save, continue).
 */
export const SUCCESS_TEXT_PATTERNS: readonly RegExp[] = [
  /\bsubmitted\b/i,
  /\bsent\b/i,
  /\bapplication (?:was )?received\b/i,
  /\breceived\b/i,
  /\bsuccessfully\b/i,
  /\bsuccess(?:ful)?\b/i,
  /\bthank you\b/i,
  /\bthanks for\b/i,
  /\bconfirmation (?:email )?(?:sent|received)\b/i,
  /\bconfirmed\b/i,
  /\bwe(?:'ve| have) (?:received|got|registered)\b/i,
  /\bhas been (?:submitted|sent|received|applied|registered|created|saved)\b/i,
  /\bwas (?:submitted|sent|received|applied|registered|created|saved)\b/i,
  /\bcomplete\b/i,
  /\bcompleted\b/i,
  /\bqueued\b/i,
  /\baccepted\b/i,
  /\bapproved\b/i,
  /\bverified\b/i,
  /\bcongratulations\b/i,
];

/** Roles/elements that carry a transient status message rather than page copy. */
const STATUS_SELECTOR =
  '[role="alert"],[role="status"],[role="alertdialog"],dialog[open],' +
  '[aria-live="assertive"],[aria-live="polite"],[class*="toast" i],[class*="snackbar" i],' +
  '[class*="notification" i],[class*="success" i],[data-testid*="success" i],' +
  '[data-testid*="toast" i],[data-testid*="alert" i]';

/** Caps scanned text so a huge page body cannot blow the budget. */
const MAX_SCAN_CHARS = 4000;

/**
 * True when text reads as a completion confirmation. Used for transient status
 * regions (dialogs/toasts) and for the visible page text as a last resort.
 */
export function looksLikeCompletionText(text: string): boolean {
  const clean = text.replace(/\s+/gu, " ").trim().slice(0, MAX_SCAN_CHARS);
  if (clean === "") return false;
  return SUCCESS_TEXT_PATTERNS.some((re) => re.test(clean));
}

/**
 * Reads completion signals from a live document.
 *
 * Returns only what is observable, with `null` for "cannot tell", so the pure
 * evaluator can distinguish "no signal yet" from "no signal exists".
 */
export interface CompletionSignals {
  /** A dialog/alert appeared whose text confirms completion. */
  successDialogOpen: boolean | null;
  /** Completion vocabulary found in a status region (toast/alert/live region). */
  successTextFound: boolean | null;
  /** The submit control itself is gone (form replaced/removed). */
  submittedTargetGone: boolean | null;
  /** The submit control is disabled — the classic "already sent" signal. */
  targetDisabled: boolean | null;
  /** Document/URL moved away from the pre-action URL. */
  navigated: boolean | null;
}

export interface CompletionScanOptions {
  urlBefore: string;
  /** Resolves the original submit element by id, if it is still in the DOM. */
  resolveTarget?: (id: string) => Element | null;
  /** True when the target id is no longer present in the fresh registry. */
  targetMissingFromRegistry?: boolean;
  /** Identity-based fallback: the submit control is no longer on the page. */
  identityMissing?: boolean;
}

/**
 * Collects the signals above from the live DOM.
 *
 * `root.querySelector` calls are guarded: the verifier runs in the content
 * script on hostile pages, so nothing here may throw.
 */
export function collectCompletionSignals(
  doc: Document,
  targetId: string | undefined,
  options: CompletionScanOptions,
): CompletionSignals {
  const navigated = doc.location?.href !== undefined ? doc.location.href !== options.urlBefore : null;

  // 1) Dialog that confirms completion.
  let successDialogOpen: boolean | null = null;
  try {
    const dialogs = doc.querySelectorAll(
      'dialog[open],[role="dialog"],[role="alertdialog"]',
    );
    for (const el of Array.from(dialogs)) {
      const text = (el.textContent ?? "").replace(/\s+/gu, " ").trim();
      if (looksLikeCompletionText(text)) {
        successDialogOpen = true;
        break;
      }
    }
    if (successDialogOpen !== true) successDialogOpen = false;
  } catch {
    successDialogOpen = null;
  }

  // 2) Completion text in a transient status region (toast/alert/live region).
  let successTextFound: boolean | null = null;
  try {
    const regions = doc.querySelectorAll(STATUS_SELECTOR);
    for (const el of Array.from(regions)) {
      if (looksLikeCompletionText((el.textContent ?? "").replace(/\s+/gu, " "))) {
        successTextFound = true;
        break;
      }
    }
    if (successTextFound !== true) successTextFound = false;
  } catch {
    successTextFound = null;
  }

  // 3) The submit control disappeared (form replaced by a completed state).
  let submittedTargetGone: boolean | null = null;
  if (options.targetMissingFromRegistry === true || options.identityMissing === true) {
    submittedTargetGone = true;
  } else if (targetId !== undefined && options.resolveTarget !== undefined) {
    try {
      submittedTargetGone = options.resolveTarget(targetId) === null;
    } catch {
      submittedTargetGone = null;
    }
  }

  // 4) The submit control is disabled after the click.
  let targetDisabled: boolean | null = null;
  if (targetId !== undefined && options.resolveTarget !== undefined) {
    try {
      const el = options.resolveTarget(targetId);
      if (el !== null) {
        targetDisabled =
          (el instanceof HTMLButtonElement && el.disabled) ||
          el.getAttribute("aria-disabled") === "true" ||
          el.hasAttribute("disabled");
      } else {
        targetDisabled = null;
      }
    } catch {
      targetDisabled = null;
    }
  }

  return { successDialogOpen, successTextFound, submittedTargetGone, targetDisabled, navigated };
}
