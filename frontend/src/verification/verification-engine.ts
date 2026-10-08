/**
 * Verification engine — REAL (PRD 6.5 §1.4; PRD 3 §23–24; PRD 4 §47–49).
 * `evaluateExpectation` is pure and unit-tested: given an expectation and
 * freshly observed facts, it returns a verdict or PENDING (keep polling).
 * The SW `verify()` ships the expectation to the tab; the content script
 * polls with this function until decisive or timed out.
 * Execution success is never assumed — only observed state decides.
 */
import { logger } from "../../../shared/logger.js";
import type {
  Expectation,
  VerificationOutcome,
  VerificationResult,
} from "../../../shared/types.js";

export type PollVerdict = VerificationOutcome | "PENDING";

export interface VerifyFacts {
  urlBefore: string;
  urlNow: string;
  /** Target (by semantic identity) present in the fresh extraction. */
  targetPresent: boolean | null;
  /** Focused element is the expected target. */
  activeMatches: boolean | null;
  dialogOpen: boolean;
  textFound: boolean | null;
  fieldFilled: boolean | null;
  stateMatches: boolean | null;
  generationChanged: boolean;
  /**
   * Generic completion signals for side-effecting (submit-style) actions.
   * Optional so every existing caller/fake stays valid; the submit_completed
   * expectation is the only consumer, and treats absent signals as "unknown".
   */
  submit?: SubmitFacts;
}

/** Observables a submit-style click can leave behind (see submit-verification.ts). */
export interface SubmitFacts {
  /** Dialog appeared whose text confirms completion. */
  successDialogOpen: boolean | null;
  /** Completion vocabulary in a status/toast/live region. */
  successTextFound: boolean | null;
  /** The submit control is gone (form replaced/removed). */
  submittedTargetGone: boolean | null;
  /** The submit control is disabled — the classic "already sent" signal. */
  targetDisabled: boolean | null;
  /** Document/URL moved away from the pre-action URL. */
  navigated: boolean | null;
}

function decided(outcome: VerificationOutcome): PollVerdict {
  return outcome;
}

/**
 * Pure expectation evaluation. PENDING means "not yet observable — poll
 * again"; every other outcome is terminal for this observation round.
 */
export function evaluateExpectation(
  expect: Expectation,
  facts: VerifyFacts,
): PollVerdict {
  // A URL change alone proves the page navigated. Previously this also required
  // `generationChanged`, which races the content script's snapshot push: right
  // after a navigation the new generation had not landed yet, so the poller
  // burned its entire 3s timeout before concluding anything. Requiring both
  // signals made every navigation cost ~3s of dead time.
  const navigatedAway = facts.urlNow !== facts.urlBefore;
  switch (expect.type) {
    case "element_present":
      if (facts.targetPresent === true) return decided("VERIFIED_SUCCESS");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "element_absent":
      if (facts.targetPresent === false) return decided("VERIFIED_SUCCESS");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "focused_element":
      if (facts.activeMatches === true) return decided("VERIFIED_SUCCESS");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "url_changed":
    case "navigation_completed":
      if (facts.urlNow !== facts.urlBefore) return decided("VERIFIED_SUCCESS");
      return "PENDING";
    case "dialog_present":
      if (facts.dialogOpen) return decided("VERIFIED_SUCCESS");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "text_present":
      if (facts.textFound === true) return decided("VERIFIED_SUCCESS");
      if (facts.textFound === null) return decided("UNKNOWN");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "field_value_present":
      if (facts.fieldFilled === true) return decided("VERIFIED_SUCCESS");
      if (facts.fieldFilled === null) return decided("UNKNOWN");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "element_state":
      if (facts.stateMatches === true) return decided("VERIFIED_SUCCESS");
      if (facts.stateMatches === null) return decided("UNKNOWN");
      if (navigatedAway) return decided("STALE_STATE");
      return "PENDING";
    case "submit_completed":
      return evaluateSubmit(facts);
    default:
      return decided("UNKNOWN");
  }
}

/**
 * Multi-signal success check for a side-effecting (submit-style) click.
 *
 * ANY positive completion signal is decisive — these are side effects, so
 * "several things changed at once" is the normal shape of success, and waiting
 * for one specific element is what caused repeated submits.
 *
 * Ordering matters: `navigated` is checked FIRST for the same reason a real
 * form submission navigates before its thank-you panel renders.
 *
 * With no positive signal this stays PENDING until the poll times out, which
 * the controller treats as INCONCLUSIVE — and for a non-idempotent action
 * inconclusive must never mean "click again".
 */
function evaluateSubmit(facts: VerifyFacts): PollVerdict {
  const s = facts.submit;
  if (s === undefined) return "PENDING";
  if (s.navigated === true) return decided("VERIFIED_SUCCESS");
  if (s.successDialogOpen === true) return decided("VERIFIED_SUCCESS");
  if (s.successTextFound === true) return decided("VERIFIED_SUCCESS");
  if (s.submittedTargetGone === true) return decided("VERIFIED_SUCCESS");
  if (s.targetDisabled === true) return decided("VERIFIED_SUCCESS");
  return "PENDING";
}

export interface VerifyRequest {
  tabId: number;
  expect: Expectation;
  /** Semantic identity of the target (role+name) for generation-proof matching. */
  identity: { role: string; name: string } | null;
  urlBefore: string;
  actionGeneration: number;
  timeoutMs: number;
}

/**
 * Sends one OBSERVE_VERIFY request to the tab and awaits its verdict.
 * The content script polls evaluateExpectation() and enforces the timeout.
 */
export async function verify(request: VerifyRequest): Promise<VerificationResult> {
  let response: unknown;
  try {
    response = await chrome.tabs.sendMessage(request.tabId, {
      type: "OBSERVE_VERIFY",
      requestId: `ver_${Date.now()}`,
      tabId: request.tabId,
      payload: {
        expect: request.expect,
        identity: request.identity,
        urlBefore: request.urlBefore,
        actionGeneration: request.actionGeneration,
        timeoutMs: request.timeoutMs,
      },
    });
  } catch {
    if (
      (request.expect.type === "navigation_completed" || request.expect.type === "url_changed") &&
      typeof chrome !== "undefined" &&
      typeof chrome.tabs?.get === "function"
    ) {
      try {
        const tab = await chrome.tabs.get(request.tabId);
        if (tab?.url !== undefined && tab.url !== request.urlBefore) {
          return {
            success: true,
            outcome: "VERIFIED_SUCCESS",
            expected: request.expect,
            observed: { url: tab.url },
            timedOut: false,
            pageGeneration: request.actionGeneration,
          };
        }
      } catch {
        // ignore and report unreachable
      }
    }
    logger.error("verify: tab unreachable", { errorCode: "CANNOT_ACCESS_PAGE" });
    return {
      success: false,
      outcome: "UNKNOWN",
      expected: request.expect,
      observed: "tab unreachable",
      timedOut: false,
      pageGeneration: request.actionGeneration,
    };
  }
  const payload = (response as { payload?: Record<string, unknown> } | null)?.payload;
  const outcome = payload?.["outcome"];
  const valid: VerificationOutcome[] = [
    "VERIFIED_SUCCESS",
    "VERIFIED_FAILURE",
    "STALE_STATE",
    "UNKNOWN",
  ];
  const finalOutcome: VerificationOutcome =
    typeof outcome === "string" && (valid as string[]).includes(outcome)
      ? (outcome as VerificationOutcome)
      : "UNKNOWN";
  return {
    success: finalOutcome === "VERIFIED_SUCCESS",
    outcome: finalOutcome,
    expected: request.expect,
    observed: payload?.["observed"] ?? null,
    timedOut: payload?.["timedOut"] === true,
    pageGeneration: request.actionGeneration,
  };
}
