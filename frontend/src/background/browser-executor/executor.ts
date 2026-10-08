/**
 * Browser Executor — REAL (PRD 6.5 §1.3; PRD 4 §44–45, §77–78).
 * L1: browser-level ops via chrome.tabs (SW context). L2: DOM ops via the
 * content script, which re-resolves the target at execution instant (second
 * TOCTOU guard after WebGuard). ExecutionResult is never success —
 * Verification decides what happened.
 */
import { logger } from "../../../../shared/logger.js";
import { isExtensionMessage } from "../../../../shared/types.js";
import type {
  ExecutionResult,
  StructuredAction,
} from "../../../../shared/types.js";

export interface ExecuteContext {
  tabId: number;
  pageGeneration: number;
}

function result(
  status: ExecutionResult["status"],
  action: StructuredAction,
  ctx: ExecuteContext,
  errorCode?: string,
): ExecutionResult {
  return {
    status,
    action: action.action,
    target: action.target,
    pageGeneration: ctx.pageGeneration,
    timestamp: Date.now(),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

/**
 * Builds the fallback search-navigation URL for browser_search.
 * Used ONLY when the chrome.search API (default-engine search) is
 * unavailable: the executor — never the model — owns URL construction,
 * so the NEVER-invent-URLs rule stays intact. Generic: no site-specific
 * selectors, no page scraping (PRD 6.10 §6/G6).
 * Exported for unit tests.
 */
export function buildBrowserSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

async function executeL1(
  action: StructuredAction,
  ctx: ExecuteContext,
): Promise<ExecutionResult> {
  switch (action.action) {
    case "navigate": {
      const params = action.parameters as { url?: unknown } | undefined;
      if (typeof params?.url !== "string") {
        return result("failed", action, ctx, "SCHEMA_VALIDATION_FAILED");
      }
      await chrome.tabs.update(ctx.tabId, { url: params.url });
      return result("executed", action, ctx);
    }
    case "browser_search": {
      // PRD 6.10 §8: safest supported MV3 mechanism for browser-level search.
      // Preferred: chrome.search.query uses the user's configured DEFAULT
      // search engine in the CURRENT tab (no engine assumed, no omnibox hack
      // from a content script, no fake API). Fallback: tabs.update to a
      // search-results URL — same observable outcome (browser shows results).
      const params = action.parameters as { query?: unknown } | undefined;
      if (typeof params?.query !== "string" || params.query.trim() === "") {
        return result("failed", action, ctx, "SCHEMA_VALIDATION_FAILED");
      }
      const query = params.query.trim();
      try {
        const searchApi = (
          chrome as unknown as {
            search?: { query?: (opts: { text: string; disposition?: string }) => Promise<void> | void };
          }
        ).search;
        if (typeof searchApi?.query === "function") {
          await searchApi.query({ text: query, disposition: "CURRENT_TAB" });
          return result("executed", action, ctx);
        }
      } catch {
        // Fall through to tabs.update fallback below.
      }
      await chrome.tabs.update(ctx.tabId, { url: buildBrowserSearchUrl(query) });
      return result("executed", action, ctx);
    }
    case "go_back":
      await chrome.tabs.goBack(ctx.tabId);
      return result("executed", action, ctx);
    case "go_forward":
      await chrome.tabs.goForward(ctx.tabId);
      return result("executed", action, ctx);
    case "open_tab": {
      const params = action.parameters as { url?: unknown } | undefined;
      if (typeof params?.url !== "string") {
        return result("failed", action, ctx, "SCHEMA_VALIDATION_FAILED");
      }
      await chrome.tabs.create({ url: params.url, active: true });
      return result("executed", action, ctx);
    }
    case "close_tab": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      if (tabs.length <= 1) {
        // Never close the user's last tab out from under them.
        logger.warn("executor: refusing to close the last tab");
        return result("failed", action, ctx, "ACTION_BLOCKED");
      }
      await chrome.tabs.remove(ctx.tabId);
      return result("executed", action, ctx);
    }
    default:
      return result("failed", action, ctx, "UNSUPPORTED_ACTION");
  }
}

async function executeL2(
  action: StructuredAction,
  ctx: ExecuteContext,
): Promise<ExecutionResult> {
  let response: unknown;
  try {
    response = await chrome.tabs.sendMessage(ctx.tabId, {
      type: "ACTION_EXECUTE",
      requestId: `exec_${Date.now()}`,
      tabId: ctx.tabId,
      payload: { action },
    });
  } catch {
    return result("failed", action, ctx, "CANNOT_ACCESS_PAGE");
  }
  if (
    !isExtensionMessage(response as never) ||
    (response as { payload?: { ok?: unknown } }).payload?.ok !== true
  ) {
    const code = (response as { payload?: { errorCode?: unknown } })?.payload
      ?.errorCode;
    return result(
      "failed",
      action,
      ctx,
      typeof code === "string" ? code : "ACTION_FAILED",
    );
  }
  return result("executed", action, ctx);
}

const L1_ACTIONS = ["navigate", "go_back", "go_forward", "open_tab", "close_tab", "browser_search"];

/** Executes an approved action. Approval is WebGuard's job, not this one's. */
export async function execute(
  action: StructuredAction,
  ctx: ExecuteContext,
): Promise<ExecutionResult> {
  try {
    if (L1_ACTIONS.includes(action.action)) {
      return await executeL1(action, ctx);
    }
    return await executeL2(action, ctx);
  } catch (err) {
    logger.error("executor: unexpected failure", {
      actionType: action.action,
      errorCode: "ACTION_FAILED",
    });
    void err;
    return result("failed", action, ctx, "ACTION_FAILED");
  }
}
