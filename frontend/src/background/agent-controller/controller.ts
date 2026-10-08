/**
 * Agent Controller — REAL (PRD 6.5; PRD 3 §16–17; PRD 4 §52–55).
 * Owns the task lifecycle; Qwen reasons, the controller decides transitions.
 * All side-effecting dependencies are injected (chrome-free unit tests).
 * Secrets live in instance memory only — never in persisted TaskState.
 */
import {
  CONTEXT_MODE_DEFAULT,
  MAX_ACTIONS_PER_TASK,
  MAX_QWEN_CALLS_PER_TASK,
  MAX_RECOVERY_ATTEMPTS_PER_ACTION,
  MAX_SEARCHES_PER_TASK,
  MAX_TASK_DURATION_MS,
  OPEN_SITE_ALLOWLIST,
  WAITING_FOR_CONFIRMATION_TTL_MS,
  WAITING_FOR_USER_ANSWER_TTL_MS,
  parseContextMode,
  type ContextMode,
} from "../../../../shared/constants.js";
import { getErrorSpeech } from "../../../../shared/messages.js";
import { logger } from "../../../../shared/logger.js";
import { matchConfirmation } from "../../../../shared/confirmation.js";
import type {
  AudioPriority,
  ExecutionResult,
  Expectation,
  SkillSelection,
  StructuredAction,
} from "../../../../shared/types.js";
import {
  clearTask,
  isTerminal,
  loadTask,
  newTaskId,
  saveTask,
  type PendingConfirmation,
  type TaskSnapshot,
  type TaskStatus,
} from "../task-state/store.js";
import { evaluate, type TargetInfo } from "../webguard/policy.js";
import {
  chooseExecutionMode,
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
} from "../../../../shared/execution.js";
import type { ExternalExecutor } from "../../bridge/harness-bridge.js";
import { execute as realExecute } from "../browser-executor/executor.js";
import { verify as realVerify, type VerifyRequest } from "../../verification/verification-engine.js";
import { reasonOnce, QwenError } from "../../ai/qwen-client.js";
import { webSearch, SearchError } from "../../ai/search-client.js";
import {
  buildUserPayload,
  ENDPOINTS,
  type BackendRef,
  type HybridScreenshot,
  type LayerB,
  type SearchResultItem,
} from "../../../../shared/api.js";
import { needsRefresh } from "../../../../shared/refresh-policy.js";
import { estimateImageTokens, serializePage } from "../../ai/context-budget.js";
import { chunkText } from "../../tts/text-shaping.js";
import type { Transcript } from "../../ai/transcript.js";
import {
  describeAvailableSkills,
  isTerminalSkillAction,
  planSkill,
  type SkillCatalog,
  type SkillInputs,
} from "../../skills/plan.js";
import { SkillRegistry, type SkillRegistryView } from "../../skills/registry.js";
import { createBuiltinCatalog, registerBuiltinSkills } from "../../skills/builtin/index.js";
import { EpisodeRecorder } from "../learning/episode-recorder.js";
import type { EpisodeStore } from "../../learning/episode-store.js";
import type { EpisodeRegistryVersion } from "../../../../shared/episode.js";
import {
  classifyResultType,
  domainOf,
  routeGoalResult,
  selectSearchStrategies,
  type SearchStrategy,
} from "./search-strategy.js";

export interface SnapshotItem {
  id: string;
  role: string;
  name: string;
  states: Record<string, string | boolean | number>;
  fieldKind: string | null;
  sensitive: boolean;
}

export interface PageSnapshotLike {
  url: string;
  title: string;
  generation: number;
  items: SnapshotItem[];
  /** Real structure + readable prose, when the content script supplied them.
   *  Absent on older snapshots; the serializer degrades to widgets only. */
  structure?: {
    headings: Array<{ level: number; text: string }>;
    landmarks: Array<{ role: string; name: string }>;
    forms: Array<{ name: string; fieldCount: number }>;
    openDialogs?: number;
  };
  prose?: Array<{ id: string; label: string; text: string; chars: number }>;
  /** Storage write time (Date.now). Absent on older snapshots; used only to
   *  detect a stale CURRENT-page read — never sent to the model. */
  savedAt?: number;
}

export interface ControllerDeps {
  /** Backend reference. Optional ONLY for keyless flows (cancel/pause never reason). */
  backend?: BackendRef;
  fetchImpl?: typeof fetch;
  guardEvaluate?: typeof evaluate;
  reason?: typeof reasonOnce;
  /** Web search (Tavily via backend). Defaults to the backend contract. */
  search?: (input: {
    query: string;
    maxResults?: number;
    turnId?: string;
  }) => Promise<{ results: SearchResultItem[] }>;
  enrich?: (input: {
    pageText: string;
    generation: number;
    lang: "en" | "hi" | "mixed";
  }) => Promise<LayerB>;
  executeFn?: (
    action: StructuredAction,
    ctx: { tabId: number; pageGeneration: number },
  ) => Promise<ExecutionResult>;
  verifyFn?: (req: VerifyRequest) => Promise<VerificationResult>;
  /**
   * Saved user details ("My details" from the Options page). Pre-seeded
   * into every new task's providedValues so form-fill works without asking.
   * Ordinary contact fields only (the shared profile allowlist makes secrets
   * unrepresentable). Optional; absent = previous behavior (empty).
   * Never throws (empty on failure).
   */
  loadProfile?: () => Promise<Record<string, string>>;
  speak?: (text: string, lang: "en" | "hi" | "mixed", priority: AudioPriority) => Promise<void>;
  stopAudio?: (all: boolean) => Promise<void>;
  setAgentActive?: (tabId: number, active: boolean) => Promise<void>;
  loadSnapshot?: (tabId: number) => Promise<PageSnapshotLike | null>;
  /**
   * Post-navigation settle: resolves true once an observed snapshot for the
   * navigated URL exists. stepOnce reads snapshots posted by the content
   * script, which arrive 1–5 s after a navigation — without this wait the
   * next reasoning step acts on the PRE-navigation page. Optional; absent =
   * previous behavior (proceed immediately). Never throws (false on timeout).
   */
  waitForSettledSnapshot?: (tabId: number, url: string, timeoutMs: number) => Promise<boolean>;
  /**
   * CURRENT-PAGE acquisition (no navigation required).
   * Live tab URL for staleness comparison (wiring: chrome.tabs.get).
   * Optional; absent = no URL-match check (previous behavior).
   * Never throws (null on unknown/closed tab).
   */
  getTabUrl?: (tabId: number) => Promise<string | null>;
  /**
   * On-demand fresh extraction (wiring: REQUEST_SNAPSHOT → content script).
   * Forces ContextLens to re-extract the CURRENT page instead of trusting
   * storage. Optional; absent = storage-only (previous behavior).
   * Never throws (null when the content script is unreachable).
   */
  requestFreshSnapshot?: (tabId: number) => Promise<PageSnapshotLike | null>;
  /**
   * Skill registry + catalog. Optional; defaults to the built-in skills so the
   * skill path works without wiring. Tests can inject a registry to exercise
   * disabled/unknown/candidate skills.
   */
  skillRegistry?: SkillRegistry;
  skillCatalog?: SkillCatalog;
  loadLayerB?: (tabId: number) => Promise<LayerB | null>;
  saveLayerB?: (tabId: number, layer: LayerB) => Promise<void>;
  readRegionText?: (tabId: number, targetId: string | undefined, maxChars: number) => Promise<string>;
  /** Cursor query for "what is this?": last hovered/focused element, if any. */
  readFocusedElement?: (tabId: number) => Promise<{ text: string; name: string; role: string } | null>;
  repeatAudio?: () => Promise<void>;
  /** Live lifecycle narration for the on-screen overlay. Optional, never blocking. */
  onProgress?: (event: AgentProgressEvent) => void;
  /**
   * Trusted-operator mode (explicit user opt-in via the popup "Power mode"
   * toggle). Forwards to WebGuard: safety gates (sensitive-field block,
   * REQUIRE_CONFIRMATION) are bypassed; correctness BLOCKs still apply and
   * verdicts stay in the audit trail. Absent/false = previous behavior.
   */
  powerMode?: boolean;
  /**
   * EXPERIMENTAL ContextLens mode (hybrid vision prototype).
   * Absent or "dom" = the existing DOM/ARIA text-only context path, unchanged.
   * "hybrid" = additionally capture the viewport screenshot and ship it as
   * Ollama multimodal input alongside a COMPACT target registry.
   *
   * This changes ONLY what the model is shown. The eNN registry stays the sole
   * source of executable targets, and WebGuard / target existence / generation
   * freshness / budgets / verification are all untouched by this flag.
   */
  contextMode?: ContextMode;
  /**
   * EXPERIMENTAL: captures the current tab viewport for a hybrid turn.
   * Injected (never imported directly) so the controller stays chrome-free and
   * unit-testable, and so an absent/throwing capture degrades to DOM context.
   * Only consulted when contextMode === "hybrid".
   */
  captureScreenshot?: (tabId: number) => Promise<HybridScreenshot | null>;
  /** Automatically starts voice capture after the assistant asks a question or confirmation. */
  startVoiceCapture?: () => Promise<void>;
  store?: {
    load: () => Promise<TaskSnapshot | null>;
    save: (s: TaskSnapshot) => Promise<void>;
    clear: () => Promise<void>;
  };
  now?: () => number;
  ttlAnswerMs?: number;
  ttlConfirmMs?: number;
  /**
   * Phase 5 episode recording. OFF by default: with recording disabled nothing
   * is buffered and no episode is persisted. Enabling requires an explicit
   * opt-in flag AND a store to write to.
   */
  recording?: boolean;
  episodeStore?: EpisodeStore;
  /**
   * Phase 7 Execution Router. Omit BOTH and INVIZ runs only its local Browser
   * Executor — the default. External execution requires an explicit policy
   * opt-in AND an injected bridge; the model cannot select an executor.
   */
  executionPolicy?: ExecutionPolicy;
  externalExecutor?: ExternalExecutor;
}

interface VerificationResult {
  success: boolean;
  outcome: "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "STALE_STATE" | "UNKNOWN";
  expected: unknown;
  observed: unknown;
  timedOut: boolean;
  pageGeneration: number;
}

/**
 * Agent lifecycle event for live UI narration (overlay "thinking" states).
 * Advisory only — never affects task decisions. Prompt/speech text travels so
 * the screen can show what the agent is waiting on; lengths stay small.
 */
export interface AgentProgressEvent {
  taskId: string;
  /** Voice turn driving this task, when the task came from a voice turn. */
  turnId?: string;
  kind:
    | "started"
    | "step"
    | "searching"
    | "speaking"
    | "waiting-answer"
    | "waiting-confirm"
    | "done"
    | "cancelled";
  /** Reasoning calls so far (step events). */
  qwenCalls?: number;
  /** Terminal task status (done events). */
  status?: TaskStatus;
  /** User-facing prompt or spoken outcome (waiting/done events). */
  prompt?: string;
  /** SpeechLang-tagged outcome code key for done events ("RATE_LIMITED"…). */
  speechCode?: string;
}

const SUBMIT_NAME_RE = /submit|send|pay|buy|purchase|place order|delete|remove|upload|confirm/i;

/** Characters of prose kept on a single reasoning call that does need it. */
const INTERACTIVE_PROSE_CHARS = 1200;

/**
 * Whether this task needs the page's body text at all.
 *
 * Measured live: the prompt costs ~1071 tokens without prose and ~3400 with a
 * full article, against an ~8000-token/minute budget shared by every key on
 * the account. Including the whole article on a "click the search button" turn
 * spent a third of the minute's budget to answer a question the element list
 * already answers. Content questions still get prose; navigation does not.
 */
const PROSE_NEEDED_RE =
  /\b(read|summar|tell me about|what (does|do|is|are)|who |why |how |explain|describe|article|content|text|translate|find out|look up|meaning|setting|toggle|switch|enable|disable|theme|dark mode|appearance)\b/i;

function needsPageProse(task: TaskSnapshot): boolean {
  if (/\b(read|summar)\w*/i.test(task.goal)) return true;
  if (PROSE_NEEDED_RE.test(task.goal)) return true;
  // Continuing a task that already established it is about page content.
  return task.lastVerifiedResult !== null && PROSE_NEEDED_RE.test(task.lastVerifiedResult);
}

/** Trims prose to a readable excerpt; the model can `read` a region for more. */
function trimProse(
  regions: NonNullable<PageSnapshotLike["prose"]>,
): NonNullable<PageSnapshotLike["prose"]> {
  if (regions.length === 0) return [];
  let budget = INTERACTIVE_PROSE_CHARS;
  const out: NonNullable<PageSnapshotLike["prose"]> = [];
  for (const region of regions) {
    if (budget <= 0) break;
    const text = region.text.length <= budget ? region.text : `${region.text.slice(0, budget).trimEnd()}…`;
    budget -= text.length;
    out.push({ id: region.id, label: region.label, text, chars: region.chars });
  }
  return out;
}

/**
 * Snapshot density assessment for hybrid-vision logging.
 *
 * A step is sparse when the AX registry alone is unlikely to ground an
 * action: almost no targets, or most targets unnamed (icon-only controls the
 * model cannot distinguish). Diagnostic only — hybrid mode attaches the
 * screenshot on every step regardless; the reason is logged so you can see
 * which steps needed vision most. No site-specific logic, just counts.
 */
export const SPARSE_MAX_ITEMS = 8;
export const SPARSE_UNNAMED_FRACTION = 0.5;

export interface SparsityAssessment {
  sparse: boolean;
  reason: "empty" | "few-items" | "unnamed-fraction" | "dense";
  itemCount: number;
  unnamedCount: number;
  unnamedFraction: number;
}

export function assessSnapshotSparsity(
  items: ReadonlyArray<{ name: string }>,
): SparsityAssessment {
  const itemCount = items.length;
  let unnamedCount = 0;
  for (const item of items) {
    if (item.name.trim() === "") unnamedCount += 1;
  }
  const unnamedFraction = itemCount === 0 ? 1 : unnamedCount / itemCount;
  if (itemCount === 0) {
    return { sparse: true, reason: "empty", itemCount, unnamedCount, unnamedFraction };
  }
  if (itemCount <= SPARSE_MAX_ITEMS) {
    return { sparse: true, reason: "few-items", itemCount, unnamedCount, unnamedFraction };
  }
  if (unnamedFraction >= SPARSE_UNNAMED_FRACTION) {
    return { sparse: true, reason: "unnamed-fraction", itemCount, unnamedCount, unnamedFraction };
  }
  return { sparse: false, reason: "dense", itemCount, unnamedCount, unnamedFraction };
}

function isSubmitControl(role: string, name: string): boolean {
  return role === "button" && SUBMIT_NAME_RE.test(name);
}

function toTargetInfo(item: SnapshotItem): TargetInfo {
  return {
    id: item.id,
    role: item.role,
    name: item.name,
    fieldKind: item.fieldKind,
    sensitive: item.sensitive,
    isSubmit: isSubmitControl(item.role, item.name),
  };
}

const CANCEL_WORDS = ["stop", "cancel", "रुको", "रद्द", "बस", "रोक"];
const READ_WORDS = ["read", "पढ़ो", "पढ़"];
const CONTINUE_WORDS = ["continue", "जारी", "आगे"];
const RESUME_WORDS = ["resume"];

// Whole-utterance cursor questions. Matched by removing every occurrence and
// requiring nothing else to remain — so "what is this what is this" (a
// repeated ask) matches, while "What is this page about?" still routes to
// Qwen as a page question.
const DESCRIBE_PHRASES = [
  "what is this thing",
  "what's this thing",
  "tell me about this",
  "describe this",
  "what is this",
  "what's this",
  "what is that",
  "what's that",
  "yeh kya hai",
  "ye kya hai",
];

function isDescribeThis(text: string): boolean {
  let rest = ` ${text.toLowerCase()} `;
  let matched = false;
  const longestFirst = [...DESCRIBE_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of longestFirst) {
    if (rest.includes(phrase)) {
      matched = true;
      rest = rest.split(phrase).join(" ");
    }
  }
  const remainder = rest.replace(/[?.!।,'’"]/gu, " ").replace(/\s+/gu, " ").trim();
  return matched && remainder === "";
}

function includesWord(text: string, words: string[]): boolean {
  const lowered = ` ${text.toLowerCase()} `;
  return words.some((w) => lowered.includes(w));
}

// Whole-utterance open-site commands ("open YouTube", "go to GitHub").
// The model is forbidden from inventing URLs and the local 3B model emits
// malformed navigate actions for these, which used to degrade into a web
// search followed by "which URL do you want to open?". These destinations are
// frozen, public, and credential-free, so the controller resolves them
// directly — no reasoning call, no search, no skill selection. Anything not
// listed in OPEN_SITE_ALLOWLIST still goes through the model.
const OPEN_SITE_RE =
  /^(?:please\s+)?(?:open|go to|goto|launch|visit)\s+(?:www\.)?(youtube|github|twitter|x|google|reddit|wikipedia|[a-z0-9-]+\.[a-z]{2,})(?:\.com)?\s*(?:please)?[?.!\s]*$/i;

/**
 * Returns the allowlisted destination URL for an unambiguous open-site
 * command, or null when the goal must go through model reasoning. Exported
 * for unit tests; the only caller is stepOnce (first step of a fresh task).
 */
export function resolveOpenSiteDestination(goal: string): string | null {
  const match = OPEN_SITE_RE.exec(goal.trim());
  if (match === null) return null;
  const key = (match[1] ?? "").toLowerCase();
  const allowlisted = OPEN_SITE_ALLOWLIST[key];
  if (allowlisted !== undefined) return allowlisted;
  if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(key)) {
    return `https://${key}/`;
  }
  return null;
}

// Compound-goal prefix ("open YouTube and play lofi", "go to GitHub and show
// trending", "open Twitter and write a post"). The leading open-site command
// is deterministic (same allowlist, same trusted pipeline), but the task STAYS
// ALIVE: after the navigate, the model reasons over the fresh page toward the
// FULL goal.
const OPEN_SITE_PREFIX_RE =
  /^(?:please\s+)?(?:open|go to|goto|launch|visit)\s+(?:www\.)?(youtube|github|twitter|x|google|reddit|wikipedia|[a-z0-9-]+\.[a-z]{2,})(?:\.com)?\b[\s?.!,]+(.+)$/i;

/**
 * Returns the allowlisted URL plus the remaining goal text when the goal
 * STARTS with an open-site command followed by more work, or null when the
 * goal is a bare open-site command (full-match path) or starts elsewhere.
 * Exported for unit tests; the only caller is stepOnce (first step).
 */
export function resolveOpenSitePrefix(goal: string): { url: string; rest: string } | null {
  const match = OPEN_SITE_PREFIX_RE.exec(goal.trim());
  if (match === null) return null;
  const key = (match[1] ?? "").toLowerCase();
  let url = OPEN_SITE_ALLOWLIST[key];
  if (url === undefined && /^[a-z0-9-]+\.[a-z]{2,}$/i.test(key)) {
    url = `https://${key}/`;
  }
  if (url === undefined) return null;
  const rest = (match[2] ?? "").trim();
  if (rest === "") return null;
  return { url, rest };
}

/** Allowlist keys usable as in-goal site anchors (single letters excluded). */
const SITE_ANCHOR_NAMES: ReadonlyArray<{ names: readonly string[]; key: string }> = [
  { names: ["youtube", "youtu"], key: "youtube" },
  { names: ["github"], key: "github" },
  { names: ["twitter"], key: "twitter" },
  { names: ["google"], key: "google" },
  { names: ["reddit"], key: "reddit" },
  { names: ["wikipedia"], key: "wikipedia" },
];

/**
 * Site-anchored goals ("play Baby on YouTube", "open a video on YouTube").
 *
 * The destination/prefix resolvers only match goals that START with an
 * open-site command, so a goal naming the site anywhere else fell to the
 * model — which is forbidden from inventing URLs and asked the USER to open
 * the site instead. For a blind user that is the product failing. When the
 * goal names an allowlisted site and the live tab is not already there,
 * return the frozen homepage URL so the controller navigates
 * deterministically and the task stays alive for the FULL goal. Returns null
 * when no site is named, the tab is already there, or the URL is unknown
 * (previous behavior). Exported for unit tests.
 */
export function resolveSiteAnchor(goal: string, liveUrl: string | null): string | null {
  if (liveUrl === null || liveUrl === "") return null;
  const text = goal.toLowerCase();
  for (const { names, key } of SITE_ANCHOR_NAMES) {
    const named = names.some((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
    if (!named) continue;
    const destination = OPEN_SITE_ALLOWLIST[key];
    if (destination === undefined) continue;
    try {
      const liveHost = new URL(liveUrl).hostname.toLowerCase();
      const destHost = new URL(destination).hostname.toLowerCase();
      if (liveHost === destHost || liveHost.endsWith(`.${destHost}`)) return null;
    } catch {
      return null;
    }
    return destination;
  }
  return null;
}

// --- PRD 6.10: search taxonomy -----------------------------------------------
/**
 * Search intent taxonomy (PRD 6.10 §4–§5):
 * - "browser": "Search for Tesla" / "Google Tesla" — Chrome default-engine
 *   search, works from any already-open page (no Google pre-open needed).
 * - "page": "Search this page/website for Tesla", "Search YouTube for Baby"
 *   — use the CURRENT page's own search UI via ContextLens (never Tavily).
 * - "web_research": "Who is Tesla's CEO?" — fresh external facts genuinely
 *   needed; the existing gated web_search (Tavily) may apply.
 * - "navigation": "Open Tesla.com" — deterministic navigation, never search.
 * - "none": anything else; the model decides (existing behavior preserved).
 *
 * The word "search" alone never auto-triggers Tavily (§4): browser/page
 * intents route to browser/page capabilities, never to web_search.
 * Exported for unit tests.
 */
export type SearchIntent = "browser" | "page" | "web_research" | "navigation" | "none";

/** "search this/this page/current page/here" or "search <site> for/on/in". */
const PAGE_SEARCH_RE =
  /\bsearch\b.{0,24}\b(this|current)\s+(page|website|web\s*site|site|tab)\b/i;
const SITE_SEARCH_RE =
  /\bsearch\b\s*(?:on|in|within)?\s*(youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\b/i;
const SITE_SEARCH_FOR_RE =
  /\bsearch\b\s+(youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\s+for\b/i;
/**
 * Generic site vocabulary for search routing. These are allowlisted site
 * tokens only — never song, video, or query content (no hardcoding).
 */
const SITE_NAME_RE =
  /\b(youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\b/i;
/** "on YouTube" / "in Spotify" — site anchor phrase anywhere in the goal. */
const SITE_ANCHOR_PHRASE_RE =
  /\b(?:on|in|inside|within)\s+(youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\b/i;
/** Leading browser-search verb ("search for", "search", "google", "look up"). */
const LEADING_SEARCH_VERB_RE = /^(?:please\s+)?(?:search\s+for|search|google|look\s*up)\b\s*/i;

/**
 * True when the goal is a site-anchored search with natural wording the
 * strict adjacent-token patterns miss: "search any song on YouTube",
 * "search for the baby song on YouTube and play it",
 * "search baby song on YouTube". Generic: requires the SEARCH verb plus a
 * site anchor — either an "on/in <site>" phrase anywhere, or a site token
 * beyond the leading verb ("search baby youtube" but NOT the verb itself in
 * "Google Tesla"). No query content is examined, so no song is hardcoded.
 * Exported for unit tests.
 */
export function isSiteAnchoredSearch(goal: string): boolean {
  const text = goal.trim();
  if (text === "") return false;
  if (!/\bsearch\b/i.test(text)) return false;
  if (SITE_ANCHOR_PHRASE_RE.test(text)) return true;
  const withoutVerb = text.replace(LEADING_SEARCH_VERB_RE, "");
  // The verb itself ("Google Tesla") must not count as the site mention.
  if (withoutVerb === text) {
    return SITE_NAME_RE.test(text);
  }
  return SITE_NAME_RE.test(withoutVerb);
}

/** Bare browser-search commands: "search [for] X", "google X", "look up X". */
const BROWSER_SEARCH_RE =
  /^(?:please\s+)?(?:search(?:\s+for)?|google|look\s*up)\b/i;

/** Genuine information questions (PRD 6.10 §5: "Who is Tesla's CEO?"). */
const RESEARCH_QUESTION_RE =
  /^(?:who|what|when|where|why|how|which|whose|whom)\b[^?.!]*[?.!]*$/i;

/**
 * Classifies a voice goal into the PRD 6.10 search taxonomy. Pure and
 * deterministic — the model never decides this mapping. Order matters:
 * page/site first (it also starts with "search"), then browser, then
 * navigation, then research. Exported for unit tests.
 */
export function classifySearchIntent(goal: string): SearchIntent {
  const text = goal.trim();
  if (text === "") return "none";
  // Page/site search wins over browser: "Search YouTube for Baby",
  // "search any song on YouTube and play it", and
  // "Search this website for Tesla" all mean the named/current site's own
  // search UI, not the browser engine (§4–§5, §13). The generic
  // site-anchored check covers natural "search <query> on <site>" wording
  // without hardcoding any query content.
  if (
    PAGE_SEARCH_RE.test(text) ||
    SITE_SEARCH_FOR_RE.test(text) ||
    SITE_SEARCH_RE.test(text) ||
    isSiteAnchoredSearch(text)
  ) {
    return "page";
  }
  if (BROWSER_SEARCH_RE.test(text)) return "browser";
  if (NAVIGATIONAL_GOAL_RE.test(text) || OPEN_SITE_RE.test(text)) {
    return "navigation";
  }
  if (RESEARCH_QUESTION_RE.test(text)) return "web_research";
  return "none";
}

/** Hostname parts identifying media pages with their own search UI. */
const MEDIA_PAGE_HOSTS = [
  "youtube",
  "youtu",
  "vimeo",
  "dailymotion",
  "twitch",
  "tiktok",
  "netflix",
  "hotstar",
  "spotify",
  "soundcloud",
  "music",
] as const;

/** Media verbs: the goal wants playback, so a media page's own search box wins. */
const MEDIA_GOAL_VERBS_RE =
  /\b(play|playing|watch|watching|listen|listening|song|songs|music|video|videos|movie|movies|trailer|episode|pause|resume|podcast)\b/i;

/**
 * Page-aware guard for the deterministic step-0 browser search.
 *
 * `classifySearchIntent` reads the goal text only, so standing on youtube.com
 * saying "search Baby song" classifies `browser` — and firing browser_search
 * there navigates the media tab AWAY to Google, stranding every ref and making
 * the follow-up "play the 3rd video" click a random result. When the live tab
 * is already a media page AND the goal wants media, the page's own search UI
 * is the correct capability: skip the deterministic search and let the normal
 * snapshot→reason loop drive the page. Unknown/absent URL (tests, closed tabs)
 * keeps the previous behavior. Exported for unit tests.
 */
export function shouldPreferPageSearch(tabUrl: string | null, goal: string): boolean {
  if (tabUrl === null) return false;
  let host = "";
  try {
    host = new URL(tabUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const parts = host.split(".");
  const isMediaPage = parts.some(
    (part) => (MEDIA_PAGE_HOSTS as readonly string[]).includes(part),
  );
  if (!isMediaPage) return false;
  return MEDIA_GOAL_VERBS_RE.test(goal);
}

/**
 * Extracts the browser-search query from a voice goal (PRD 6.10 §9).
 * "search for tesla" → "tesla"; "google best laptops under $1000" →
 * "best laptops under $1000"; "search for baby by justin bieber" →
 * "baby justin bieber". Strips the command verb, trailing multi-step
 * continuations ("and open …", "and play …"), and filler "by" phrasing.
 * Preserves the user's wording — never routes through Tavily for cleanup.
 * Returns "" when no query remains. Exported for unit tests.
 */
export function extractBrowserSearchQuery(goal: string): string {
  let text = goal.trim().replace(/[?.!\s]+$/u, "");
  text = text.replace(/^(?:please\s+)/i, "");
  text = text.replace(/^(?:search\s+for|search|google|look\s*up)\b\s*/i, "");
  // Multi-step continuation ("Search Tesla and open the official website",
  // "Search for Baby … and play it"): the search query is the FIRST clause.
  const continuation = text.search(/\s+and\s+(?:open|play|click|go\s+to|show|select|visit)\b/i);
  if (continuation !== -1) text = text.slice(0, continuation);
  // "baby by justin bieber" → "baby justin bieber" (§9 example).
  text = text.replace(/\s+by\s+/gi, " ");
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length > 400) text = text.slice(0, 400).trimEnd();
  return text;
}

/**
 * Extracts the site-search query from a site-anchored goal without hardcoding
 * any song, video, or title ("search <query> on <site> and play it" →
 * "<query>"). Generic stripping only: leading action verbs (search/play/
 * watch/listen), trailing multi-step continuations ("and play/open/..."),
 * site-anchor phrases ("on YouTube", "YouTube for"), and bare site tokens.
 * Preserves the user's wording for the visible search box; returns "" when
 * nothing remains. Exported for unit tests.
 */
export function extractSiteSearchQuery(goal: string): string {
  let text = goal.trim().replace(/[?.!\s]+$/u, "");
  text = text.replace(/^(?:please\s+)/i, "");
  // Leading action verbs (search family + playback family + open family).
  text = text.replace(
    /^(?:search\s+for|search|google|look\s*up|play|watch|listen\s+to|listen|open|go\s+to|goto|launch|visit)\b\s*/i,
    "",
  );
  // Multi-step continuation ("... and play it", "... and open ..."): the
  // search query is the FIRST clause.
  const continuation = text.search(
    /\s+and\s+(?:open|play|click|go\s+to|show|select|visit|watch|listen)\b/i,
  );
  if (continuation !== -1) text = text.slice(0, continuation);
  // Trailing playback tail without "and" ("play baby song", "baby song play").
  text = text.replace(/\s+(?:play|watch|listen)(?:\s+it)?\s*$/i, "");
  // Site-anchor phrases: "on YouTube", "in Spotify", "YouTube for ...".
  text = text.replace(
    /\b(?:on|in|inside|within)\s+(youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\b/gi,
    " ",
  );
  text = text.replace(
    /^(?:youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\s+for\s+/i,
    "",
  );
  // Bare leading/trailing site tokens ("YouTube Baby" → "Baby",
  // "baby song youtube" → "baby song").
  text = text.replace(
    /^(?:youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\b\s*/i,
    "",
  );
  text = text.replace(
    /\s*\b(?:youtube|youtu|google|github|twitter|reddit|wikipedia|netflix|amazon|flipkart)\b\s*$/i,
    "",
  );
  // Filler "by" phrasing ("baby by justin bieber" → "baby justin bieber").
  text = text.replace(/\s+by\s+/gi, " ");
  // Filler articles/quantifiers at the start are kept — they are the user's
  // words for the visible box — but collapse whitespace.
  text = text.replace(/\s+/gu, " ").trim();
  // "any song" alone is not a searchable title; keep it so the page still
  // shows visible results rather than asking with no observation.
  if (text.length > 400) text = text.slice(0, 400).trimEnd();
  return text;
}

/**
 * True when a URL looks like a search-results page (generic: any site's
 * search/query param — including compound names like search_query — or a
 * /search or /results path with a query string). Used to verify that a
 * browser search actually landed on results (PRD 6.10 §18) without any
 * engine-specific selectors (§G6). Exported for unit tests.
 */
export function isSearchResultsUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  if (/[?&](q|query|text|search|keyword|keywords)=/.test(lowered)) return true;
  // Generic compound params ("search_query", "search-query", "searchText", …)
  // used by site-internal search boxes — matched by substring, never by site.
  if (/[?&][^&#?]*(search|query)[^&#?]*=/.test(lowered)) return true;
  if (/\/search(\/|$|\?|#)/.test(lowered)) return true;
  // Generic results path WITH a query string (e.g. "/results?search_query=x"
  // on media sites). Bare "/results" without "?" stays false.
  if (/\/results(\/|$|\?|#)/.test(lowered) && lowered.includes("?")) return true;
  return false;
}

/**
 * Normalizes a web-search query for duplicate comparison: case-folded,
 * punctuation-stripped, whitespace-collapsed. Exported for unit tests.
 */
export function normalizeSearchQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const NAVIGATIONAL_GOAL_RE =
  /^(?:please\s+)?(?:open|go to|goto|launch|visit|take me to|show me)\b/i;

/**
 * True when the goal wants an article opened via search ("open a science
 * article", "find a space article and open it"). Generic: requires the word
 * "article" plus an open-like verb, excluding current-page reads ("read this
 * article", "summarize this article"). No topic is examined, so no subject
 * is hardcoded. Exported for unit tests.
 */
export function isArticleOpenGoal(goal: string): boolean {
  const text = goal.trim();
  if (text === "") return false;
  if (!/\barticle\b/i.test(text)) return false;
  // Current-page reads refer to the already-open page, never search+open.
  if (/\b(this|that|current)\s+article\b/i.test(text)) return false;
  return /\b(open|show|find|get|give|read|search|need|want|load)\b/i.test(text);
}

/**
 * Extracts the web-search query for an article-open goal without hardcoding
 * any topic ("open a science article" → "a science article", "find a space
 * article about black holes and open it" → "a space article about black
 * holes"). Generic stripping only: leading action verbs, leading "me/for me",
 * trailing multi-step continuations. Keeps the "article" word so the search
 * favors articles. Returns "" when nothing remains. Exported for unit tests.
 */
export function extractArticleQuery(goal: string): string {
  let text = goal.trim().replace(/[?.!\s]+$/u, "");
  text = text.replace(/^(?:please\s+)/i, "");
  text = text.replace(
    /^(?:open|show(?:\s+me)?|find|get|give(?:\s+me)?|read|search(?:\s+for)?|google|look\s*up|need|want|i\s+want)\b\s*/i,
    "",
  );
  text = text.replace(/^(?:me|for\s+me)\b\s*/i, "");
  const continuation = text.search(
    /\s+and\s+(?:open|read|show|click|go\s+to|select|visit)\b/i,
  );
  if (continuation !== -1) text = text.slice(0, continuation);
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length > 400) text = text.slice(0, 400).trimEnd();
  return text;
}

/**
 * True when a web_search is a navigational request in disguise: the goal
 * itself is "open/go to X" and the query is just the site name (or names an
 * allowlisted site). The model must navigate directly instead of spending a
 * Tavily credit to find a homepage it already knows. Article opens ("open a
 * science article") always need search — there is no known URL — so they are
 * never navigational refusals. Exported for unit tests.
 */
export function isNavigationalSearchRefusal(goal: string, query: string): boolean {
  if (!NAVIGATIONAL_GOAL_RE.test(goal.trim())) return false;
  if (isArticleOpenGoal(goal)) return false;
  const normalized = normalizeSearchQuery(query);
  if (normalized === "") return false;
  if (normalized.split(" ").length <= 2) return true;
  const allowlistKeys = Object.keys(OPEN_SITE_ALLOWLIST);
  return allowlistKeys.some((key) => normalized.includes(key));
}

/** Field-name matching across the model/registry spelling gap ("full_name",
 * "fullName" vs "Full name"). Single owner for both slot-fill paths. */
function fieldNameMatches(itemName: string, field: string): boolean {
  const norm = (s: string): string =>
    s
      .replace(/([a-z])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .replace(/_/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  if (itemName === "") return false;
  const name = norm(itemName);
  const needle = norm(field);
  if (needle === "") return false;
  return name === needle || name.includes(needle) || needle.includes(name);
}

/** Shortens a result title for speech (speakable, never the URL). */
function shortTitle(title: string, max = 60): string {
  const clean = title.replace(/\s+/gu, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}

/**
 * Identity of a user-approved action, used to remember consent within a task.
 *
 * Deliberately EXCLUDES pageGeneration and timeout_ms: the page re-renders
 * between attempts, and those volatile fields would make a re-proposal of the
 * very same action look "different" and re-trigger the prompt. INCLUDES the
 * target and any value/URL, so approving "submit THIS form" can never silently
 * authorize submitting a different form or typing a different value.
 */
export function approvalSignature(action: StructuredAction): string {
  const params = (action.parameters ?? {}) as Record<string, unknown>;
  const url = typeof params["url"] === "string" ? params["url"] : "";
  const option = params["option"] !== undefined ? JSON.stringify(params["option"]) : "";
  return [action.action, action.target ?? "", action.value ?? "", url, option].join("|");
}

/**
 * Goal-echo confirmation (Phase 2): natural replies that restate the PENDING
 * action count as approval — but ONLY when a confirmation is actually pending
 * (the caller guarantees that scope; this function never approves anything
 * on its own).
 *
 * Why this exists: users answer a submit prompt with "submit" / "do it" /
 * "yes, submit" — none of which are in the yes/no grammar, so the turn fell
 * into unclear → re-ask → dropped-confirmation → re-reason loops. "Submit"
 * said to an empty room still means nothing; said to a pending submit click,
 * it is unambiguous.
 *
 * Conservative by construction: exact short phrases, or a short reply naming
 * the pending target / using the pending action's verb. Anything longer or
 * unrelated returns false and the normal grammar decides.
 */
const ECHO_APPROVAL_PHRASES: ReadonlySet<string> = new Set([
  "do it",
  "do that",
  "do this",
  "submit",
  "submit it",
  "go ahead",
  "confirm it",
  "approve it",
  "yes submit",
  "ok submit",
  "kar do",
  "kardo",
]);

const ECHO_VERBS: Readonly<Record<string, ReadonlyArray<string>>> = {
  click: ["click", "press", "tap", "submit", "select", "choose", "open", "hit", "push"],
  type: ["type", "enter", "fill", "write"],
  focus: ["focus"],
  select: ["select", "choose"],
  scroll: ["scroll"],
  press_key: ["press"],
};

function echoTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.!…]+$/u, "")
    .split(/[^a-z0-9\u0900-\u097F']+/u)
    .filter((t) => t !== "");
}

export function isEchoApproval(
  text: string,
  action: StructuredAction,
  targetName: string,
): boolean {
  const clean = text.trim().toLowerCase().replace(/[.!…]+$/u, "");
  if (ECHO_APPROVAL_PHRASES.has(clean)) return true;
  const toks = echoTokens(text);
  if (toks.length === 0 || toks.length > 6) return false;
  const nameWords = targetName
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length > 2);
  if (nameWords.some((w) => toks.includes(w))) return true;
  // Bare action verbs only in SHORT replies ("submit it") — a longer sentence
  // containing a verb ("submit the quarterly report for review") is not an
  // unambiguous echo and stays with the normal grammar.
  if (toks.length > 4) return false;
  const verbs = ECHO_VERBS[action.action] ?? [];
  if (verbs.some((v) => toks.includes(v))) return true;
  return false;
}

/** Short action-echo utterances with no target context (for the answer-path guard). */
export function isActionEchoUtterance(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/[.!…]+$/u, "");
  if (ECHO_APPROVAL_PHRASES.has(clean)) return true;
  const toks = echoTokens(text);
  if (toks.length === 0 || toks.length > 3) return false;
  const allVerbs = new Set(Object.values(ECHO_VERBS).flat());
  return toks.some((t) => allVerbs.has(t));
}

/**
 * True when this action performs a side effect that must NOT be repeated
 * automatically: clicking a submit/send/pay/delete-style control.
 *
 * Shares the controller's existing SUBMIT_NAME_RE vocabulary so "what counts as
 * a consequential control" is defined once. A `navigate`/`open_tab` is NOT
 * side-effecting here (repeating it is harmless), and a plain click on a
 * non-consequential control keeps its original retry behaviour.
 */
export function isSideEffectingAction(
  action: StructuredAction,
  target: SnapshotItem | null,
): boolean {
  if (action.action !== "click") return false;
  if (target === null) return false;
  if (target.role !== "button" && target.role !== "link") return false;
  return SUBMIT_NAME_RE.test(target.name);
}

export class AgentController {
  private runCounter = 0;
  private secrets = new Map<string, string>(); // taskId:field → value (memory only)
  private readSessions = new Map<number, { chunks: string[]; index: number; lang: "en" | "hi" }>();
  private reasks = new Map<string, number>();
  /**
   * Per-task user-cancellation signal (Phase 2 hardening). Created when a task
   * starts, aborted by cancelTask. Threaded into the reasoning fetch so an
   * in-flight /v1/chat request rejects promptly on X/stop instead of running
   * to timeout — and every post-await site checks it (see isStepStale) so a
   * late AI result can never dispatch, speak, or mutate state after cancel.
   * Memory-only, per task, cleared on finish/cancel.
   */
  private taskAbort = new Map<string, AbortController>();
  /**
   * Consecutive ordinary ask_user outcomes with no intervening action. A model
   * that keeps asking instead of acting gets an explicit continue-directive in
   * the next intent (loop breaker). High-sensitivity asks are exempt — a
   * secret genuinely missing must stay a question, never become a guess.
   */
  private consecutiveAsk = new Map<string, number>();
  /**
   * taskId -> signatures the user already approved with an explicit "yes".
   *
   * Without this, an approval was applied to ONE action and then forgotten: the
   * agent's next step re-proposes the same submit/save click, WebGuard demands
   * confirmation again, and the user is trapped answering "yes" to the same
   * question until the recovery budget runs out. The system prompt already
   * forbids this ("never ask for confirmation the user already gave"); this is
   * where that rule is actually enforced. Memory-only, per task, cleared on
   * finish/cancel — a new task always asks again.
   */
  private approvals = new Map<string, Set<string>>();
  /**
   * taskId -> URLs the model has actually observed this task (memory only,
   * never persisted). Sources: web_search results and fresh page snapshots.
   * Used for generic anti-hallucination grounding: a navigate/open_tab to a
   * URL never observed is refused with guidance to search first, then navigate
   * to an observed URL. No allowlists, no topics — purely what was seen.
   */
  private observedUrls = new Map<string, Set<string>>();
  // taskId -> page generation whose enrichment already failed. Stops a failed
  // advisory call from being retried on every step of the same task, which
  // doubled Qwen usage and triggered provider rate limits mid-turn.
  private enrichSuppressed = new Map<string, number>();
  /**
   * taskId -> voice turn id driving it (memory only, never persisted).
   * Threads the turn id into every reasoning/enrichment call's logs and
   * backend body so one Ctrl+Shift+V's full provider fan-out is attributable
   * in the logs. Updated whenever a new voice turn touches a live task.
   */
  private taskTurns = new Map<string, string>();
  /**
   * taskId → the skill currently driving the task. While present, the run loop
   * executes the skill's NEXT action (observed step by step against fresh page
   * state) instead of asking the model again. Memory-only: a lost entry simply
   * means the model re-selects — nothing unsafe is cached.
   */
  private activeSkills = new Map<
    string,
    { skillId: string; inputs: SkillInputs; view: SkillRegistryView }
  >();
  private skillRuntime: { registry: SkillRegistry; catalog: SkillCatalog } | null = null;
  /** Phase 5 learning layer. Constructed with recording OFF unless opted in. */
  private readonly recorder: EpisodeRecorder;
  /** Phase 7: which executor actually ran a task's last action (episode provenance). */
  private executionModes = new Map<string, "local" | "external">();

  constructor(private readonly deps: ControllerDeps) {
    this.recorder = new EpisodeRecorder({
      enabled: deps.recording === true,
      ...(deps.episodeStore !== undefined ? { store: deps.episodeStore } : {}),
      now: () => this.now(),
      registryVersions: () => this.registryVersions(),
    });
  }

  /** Registry versions in force — episode provenance, never an authority claim. */
  private registryVersions(): EpisodeRegistryVersion[] {
    if (this.deps.recording !== true) return [];
    const { registry } = this.skills();
    return registry
      .discover()
      .map((s) => ({ skillId: s.id, version: s.version, status: s.status }));
  }

  /** Captures one action attempt into the episode buffer (no-op when off). */
  private recordEpisodeAction(
    task: TaskSnapshot,
    snapshot: PageSnapshotLike,
    action: StructuredAction,
    status: "executed" | "failed" | "blocked" | "awaiting_confirmation" | "read" | "not_run",
    verification?: { success: boolean; outcome: VerificationResult["outcome"]; timedOut: boolean; pageGeneration: number },
  ): void {
    this.recorder.recordAction(task.taskId, {
      action,
      pageGeneration: snapshot.generation,
      status,
      executionMode: this.executionModes.get(task.taskId) ?? "local",
      pageUrl: snapshot.url,
      pageTitle: snapshot.title,
      ...(verification !== undefined ? { verification } : {}),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Saved-details pre-seed ("My details"). Returns sanitized ordinary
   * contact values for the new task, or {} when none saved / dep absent /
   * read fails. Never throws; never returns secrets (shared allowlist).
   */
  private async loadSavedProfile(): Promise<Record<string, string>> {
    if (this.deps.loadProfile === undefined) return {};
    try {
      const profile = await this.deps.loadProfile();
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(profile)) {
        if (typeof value === "string" && value.trim() !== "") {
          out[key] = value.slice(0, 200);
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * CURRENT-PAGE acquisition: returns a fresh usable snapshot of the ALREADY
   * OPEN tab — no navigation required, no "open X first" prerequisite.
   *
   * Why this exists: a new voice command starts a new task whose ONLY context
   * is the current tab. A single storage read can return a pre-render SPA
   * read (right URL, zero targets) or a pre-route URL — and the model,
   * forbidden from inventing ids, must then ask instead of acting.
   *
   * Generic strategy (all optional deps, all fail-soft to previous behavior):
   *  1. Storage read. Null → pull fresh once, then brief poll (covers worker
   *     restart / eviction / content script that never pushed).
   *  2. Empty-items snapshot → pull fresh + short settle poll for a late
   *     render push. An empty registry can never satisfy a contextual action;
   *     waiting briefly is cheaper than burning a reasoning call that must ask.
   *  3. Stale snapshot (savedAt older than the current-page budget) → pull.
   *  4. URL-mismatch snapshot vs live tab URL → pull fresh once, re-read
   *     (user switched tabs during capture, SPA route not yet pushed).
   * Never throws; returns null only when no snapshot exists at all.
   */
  private async ensureCurrentSnapshot(tabId: number, taskId?: string): Promise<PageSnapshotLike | null> {
    const loadSnapshot = this.deps.loadSnapshot ?? (async () => null);
    const requestFresh = this.deps.requestFreshSnapshot;
    const getTabUrl = this.deps.getTabUrl;
    const turnId = taskId !== undefined ? this.taskTurns.get(taskId) : undefined;

    let snapshot = await loadSnapshot(tabId);

    // 1. No stored snapshot at all: pull once, then poll briefly for the push.
    if (snapshot === null && requestFresh !== undefined) {
      try {
        const fresh = await requestFresh(tabId);
        if (fresh !== null) return fresh;
      } catch {
        // Fall through to the poll below.
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((r) => setTimeout(r, 200));
        snapshot = await loadSnapshot(tabId);
        if (snapshot !== null) break;
      }
      if (snapshot === null) {
        logger.warn("agent: no current-page snapshot even after pull", {
          ...(taskId !== undefined ? { taskId } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          tabId,
        });
        return null;
      }
    } else if (snapshot === null) {
      // Storage-only path (tests / old wiring): keep the historic short poll
      // for post-action steps so behavior is unchanged.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((r) => setTimeout(r, 200));
        snapshot = await loadSnapshot(tabId);
        if (snapshot !== null) break;
      }
      if (snapshot === null) return null;
    }

    // At this point snapshot is non-null (TypeScript narrowing via local).
    let current = snapshot as PageSnapshotLike;

    // 2. Empty registry: possibly a pre-render SPA read. Pull once, then
    // settle-poll briefly for a late render push (route follow-ups land
    // ~1-3s after the route). Bounded: at most ~2s extra on empty pages.
    if (current.items.length === 0) {
      if (requestFresh !== undefined) {
        try {
          const fresh = await requestFresh(tabId);
          if (fresh !== null && fresh.items.length > 0) {
            logger.info("agent: empty snapshot refreshed via pull", {
              ...(taskId !== undefined ? { taskId } : {}),
              ...(turnId !== undefined ? { turnId } : {}),
              url: fresh.url,
              items: fresh.items.length,
            });
            return fresh;
          }
          if (fresh !== null) current = fresh;
        } catch {
          // Keep the stored snapshot; reasoning over an empty page is still
          // more honest than failing when the tab is genuinely empty.
        }
      }
      // Settle poll only when a live update path exists (pull dep present):
      // storage-only callers (unit tests) never change between polls, so
      // polling would only burn the turn budget.
      if (current.items.length === 0 && requestFresh !== undefined) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((r) => setTimeout(r, 200));
          const polled = await loadSnapshot(tabId);
          if (polled !== null && polled.items.length > 0) {
            logger.info("agent: empty snapshot settled via storage poll", {
              ...(taskId !== undefined ? { taskId } : {}),
              ...(turnId !== undefined ? { turnId } : {}),
              url: polled.url,
              items: polled.items.length,
            });
            current = polled;
            break;
          }
        }
      }
    }

    // 3. Stale snapshot by age: storage survived but the page kept living
    // (media state flips, SPA re-renders) without a push. Generic budget:
    // older than 60s is re-pulled once when a pull path exists.
    if (requestFresh !== undefined && typeof current.savedAt === "number") {
      const ageMs = this.now() - current.savedAt;
      if (ageMs > 60_000) {
        try {
          const fresh = await requestFresh(tabId);
          if (fresh !== null) {
            logger.info("agent: stale snapshot refreshed via pull", {
              ...(taskId !== undefined ? { taskId } : {}),
              ...(turnId !== undefined ? { turnId } : {}),
              ageMs,
              url: fresh.url,
              items: fresh.items.length,
            });
            return fresh;
          }
        } catch {
          // Keep the stored snapshot on pull failure.
        }
      }
    }

    // 4. URL mismatch: stored snapshot belongs to another page / pre-route.
    if (getTabUrl !== undefined) {
      let liveUrl: string | null = null;
      try {
        liveUrl = await getTabUrl(tabId);
      } catch {
        liveUrl = null;
      }
      if (liveUrl !== null && liveUrl !== "" && liveUrl !== current.url && requestFresh !== undefined) {
        logger.info("agent: snapshot URL mismatch; pulling fresh", {
          ...(taskId !== undefined ? { taskId } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          storedUrl: current.url,
          liveUrl,
        });
        try {
          const fresh = await requestFresh(tabId);
          if (fresh !== null) return fresh;
        } catch {
          // Fall through with the stored snapshot.
        }
        const reloaded = await loadSnapshot(tabId);
        if (reloaded !== null) current = reloaded;
      }
    }

    return current;
  }

  /**
   * Resolves the skill runtime once: injected deps win, otherwise the built-in
   * skills are registered into a fresh registry. Built-ins are first-party and
   * arrive as `approved` (executable, never auto-trusted).
   */
  private skills(): { registry: SkillRegistry; catalog: SkillCatalog } {
    if (this.skillRuntime !== null) return this.skillRuntime;
    const registry = this.deps.skillRegistry ?? new SkillRegistry();
    if (this.deps.skillRegistry === undefined) registerBuiltinSkills(registry);
    const catalog = this.deps.skillCatalog ?? createBuiltinCatalog();
    this.skillRuntime = { registry, catalog };
    return this.skillRuntime;
  }

  /** Best-effort progress narration (overlay). Never throws into the task flow. */
  private emitProgress(event: Omit<AgentProgressEvent, "turnId"> & { taskId: string }): void {
    try {
      const turnId = this.taskTurns.get(event.taskId);
      this.deps.onProgress?.({
        ...event,
        ...(turnId !== undefined ? { turnId } : {}),
      });
    } catch {
      // Narration must never break the agent.
    }
  }

  // -- Task entry ------------------------------------------------------------

  /** Routes one voice transcript: cancel wins, then waiting states, then commands, else new task. */
  async routeVoice(transcript: Transcript, tabId: number): Promise<void> {
    const text = transcript.text;
    const store = this.deps.store ?? { load: loadTask, save: saveTask, clear: clearTask };
    const existing = await store.load();
    // Attribute follow-up turns to the live task they continue, so the logs
    // show which voice turn caused which reasoning call.
    if (transcript.turnId !== undefined && existing !== null && !isTerminal(existing.status)) {
      this.taskTurns.set(existing.taskId, transcript.turnId);
    }

    if (includesWord(text, CANCEL_WORDS)) {
      if (existing !== null && !isTerminal(existing.status)) {
        await this.cancelTask(existing.taskId, tabId, store);
      } else {
        await this.endReadSession(tabId);
      }
      return;
    }

    if (existing !== null && existing.status === "WAITING_FOR_USER_ANSWER") {
      await this.handleAnswer(existing, transcript, tabId, store);
      return;
    }
    if (existing !== null && existing.status === "WAITING_FOR_CONFIRMATION") {
      await this.handleConfirmation(existing, transcript, tabId, store);
      return;
    }
    if (existing !== null && existing.status === "PAUSED_USER_OVERRIDE") {
      if (includesWord(text, RESUME_WORDS)) {
        await this.resumeTask(existing, tabId, store);
        return;
      }
      // Any other utterance starts over (override the paused task).
      await this.cancelTask(existing.taskId, tabId, store, true);
    } else if (existing !== null && !isTerminal(existing.status)) {
      // A live task is superseded by the new command (human-wins).
      await this.cancelTask(existing.taskId, tabId, store, true);
    }

    if (await this.handleReadCommand(text, transcript, tabId)) {
      // Local-only command (read/stop/repeat/describe): no reasoning ran, but
      // the overlay was waiting — settle it as done.
      if (existing !== null) {
        this.emitProgress({ taskId: existing.taskId, kind: "done", status: "COMPLETE" });
      } else {
        this.emitProgress({ taskId: `read:${tabId}`, kind: "done", status: "COMPLETE" });
      }
      return;
    }

    const snapshot: TaskSnapshot = {
      taskId: newTaskId(),
      goal: text,
      goalLang: transcript.lang,
      tabId,
      status: "ACTIVE",
      currentStep: 0,
      completedActions: 0,
      recoveryAttempts: 0,
      qwenCalls: 0,
      startedAt: this.now(),
      updatedAt: this.now(),
      pendingQuestion: null,
      pendingConfirmation: null,
      lastVerifiedResult: null,
      // "My details" pre-seed: saved ordinary contact info flows into the
      // existing slot-fill path (prompt grounding + deterministic type), so
      // "fill in my details" works without asking. Secrets stay memory-only.
      providedValues: await this.loadSavedProfile(),
      searchCount: 0,
      searchedQueries: [],
    };
    await store.save(snapshot);
    if (transcript.turnId !== undefined) {
      this.taskTurns.set(snapshot.taskId, transcript.turnId);
    }
    // Fresh cancellation signal per task (Phase 2 hardening): X/stop aborts
    // this controller, which rejects the in-flight reasoning fetch and marks
    // every post-await site stale (see isStepStale).
    this.taskAbort.set(snapshot.taskId, new AbortController());
    this.recorder.begin(snapshot); // no-op unless recording was opted into
    this.emitProgress({ taskId: snapshot.taskId, kind: "started" });
    await this.run(snapshot.taskId, tabId, store);
  }

  // -- Main loop ---------------------------------------------------------------

  private async run(
    taskId: string,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const runId = ++this.runCounter;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 40) break; // belt-and-suspenders beyond the task budgets
      const task = await store.load();
      if (task === null || task.taskId !== taskId) return;
      if (runId !== this.runCounter) return; // cancelled/superseded
      if (isTerminal(task.status)) return;
      if (task.status === "WAITING_FOR_USER_ANSWER") return;
      if (task.status === "WAITING_FOR_CONFIRMATION") return;
      if (task.status === "PAUSED_USER_OVERRIDE") return;
      // A skill in flight drives the next step itself (one action per step,
      // re-observed each time) instead of spending a reasoning call re-deriving
      // the procedure. When it finishes or fails, control returns to the model.
      const activeSkill = this.activeSkills.get(taskId);
      if (activeSkill !== undefined) {
        await this.stepSkill(task, activeSkill, tabId, store);
      } else {
        await this.stepOnce(task, tabId, store);
      }
    }
  }

  private async stepOnce(
    task: TaskSnapshot,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    // Backend is required for any reasoning step. Keyless flows (cancel/pause)
    // never reach here; anything else without a backend fails honestly.
    const backend = this.deps.backend;
    if (backend === undefined) {
      await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
      return;
    }
    // Budgets (PRD 6 §4.4).
    if (
      task.completedActions >= MAX_ACTIONS_PER_TASK ||
      task.qwenCalls >= MAX_QWEN_CALLS_PER_TASK ||
      this.now() - task.startedAt >= MAX_TASK_DURATION_MS
    ) {
      await this.finish(task, "LIMIT_REACHED", "TASK_LIMIT_REACHED", tabId, store);
      return;
    }

    // Free-will reasoning: the model decides itself whether to interact with
    // the page, browser_search, web_search, navigate, or answer — with ONE
    // narrow exception below. Former hardcoded shortcuts (open-site allowlist
    // navigation, site-anchor navigation, deterministic browser_search,
    // page-search hints) are intentionally NOT executed here — they remain as
    // exported pure helpers for advisory/telemetry use only, never as gates.
    // Safety (WebGuard, schema validation, budgets, verification) still runs
    // on whatever the model emits; anti-hallucination grounding (observed URLs
    // and registry ids) is enforced downstream, not by task hardcoding.
    //
    // Exception — article open fast-path: "open the latest news article of
    // India" style goals are search→open by nature (no page interaction can
    // satisfy them), and the small local model fumbles them. Detection and the
    // query are fully generic (verbs + the word "article"; the topic always
    // comes from the user's own words, never a fixed title or URL), the
    // destination is the best observed search result (never invented), and it
    // still runs the trusted WebGuard → executor → verification path.
    if (task.currentStep === 0 && task.lastVerifiedResult === null) {
      if (isArticleOpenGoal(task.goal)) {
        const articleQuery = extractArticleQuery(task.goal);
        if (articleQuery !== "") {
          await this.doArticleFastPath(task, tabId, store, articleQuery);
          return;
        }
      }
    }

    // CURRENT-PAGE acquisition: the already-open tab IS the context. Never
    // require a prior navigate / "open X" — pull fresh when storage is
    // missing, empty (SPA pre-render), or URL-mismatched (tab switched).
    // Free-will fix: a missing snapshot must NOT fast-fail with
    // CANNOT_ACCESS_PAGE before the model ever gets to think. Search/open
    // goals (news articles, YouTube videos) need web_search + navigate first,
    // which require no page registry. So proceed with an empty page context
    // and let the model decide; target-bearing actions will still fail
    // honestly via WebGuard when there is truly nothing to act on.
    const loaded = await this.ensureCurrentSnapshot(tabId, task.taskId);
    const snapshotMissing = loaded === null;
    const snapshot: PageSnapshotLike =
      loaded ?? ({ url: "", title: "", generation: 0, items: [] } as PageSnapshotLike);
    if (!snapshotMissing) {
      // Unsupported scheme (chrome://, chrome-extension://, about:, edge://, view-source:, file:)
      if (/^(chrome|chrome-extension|about|edge|view-source|file):/i.test(snapshot.url)) {
        await this.finish(task, "FAILED", "UNSUPPORTED_PAGE", tabId, store);
        return;
      }
      // The current page itself is observed evidence for grounding.
      if (snapshot.url.trim() !== "") this.rememberObservedUrls(task.taskId, [snapshot.url]);
    } else {
      logger.warn("agent: no current-page snapshot; reasoning with empty page context", {
        taskId: task.taskId,
        tabId,
      });
    }

    // Enrichment when Layer B is missing/stale (async page prep, PRD 6.4 §1.4).
    // Runs through the backend /v1/enrich contract (default) or an injected
    // implementation in tests. Advisory only — failure proceeds on Layer A.
    // Skipped when there is no page at all (empty context): enriching ""
    // only burns a backend call and delays web_search/navigate.
    const loadLayerB = this.deps.loadLayerB ?? (async () => null);
    const saveLayerB = this.deps.saveLayerB ?? (async () => undefined);
    let layerB = await loadLayerB(tabId);
    if (
      !snapshotMissing &&
      (layerB === null ||
        layerB.pageGeneration !== snapshot.generation ||
        needsRefresh("route", layerB, snapshot.generation, this.now()))
    ) {
      // Already tried and failed for this page generation in this task.
      const suppressed = this.enrichSuppressed.get(task.taskId);
      if (suppressed !== snapshot.generation) {
      const turnId = this.taskTurns.get(task.taskId);
      const enrich = this.deps.enrich ?? ((input) => this.enrichViaBackend(input, backend, turnId));
      try {
        const packed = serializePage({
          url: snapshot.url,
          title: snapshot.title,
          generation: snapshot.generation,
          items: snapshot.items,
          headings: snapshot.structure?.headings ?? [],
          landmarks: snapshot.structure?.landmarks ?? [],
          forms: snapshot.structure?.forms ?? [],
          // Enrichment summarizes content, so it always wants the prose.
          prose: trimProse(snapshot.prose ?? []),
        });
        const fresh = await enrich({
          pageText: packed.text,
          generation: snapshot.generation,
          lang: task.goalLang,
        });
        layerB = fresh;
        await saveLayerB(tabId, fresh);
      } catch (err) {
        // Enrichment is advisory: proceed on Layer A alone. But a FAILED
        // enrich used to leave layerB null, so every subsequent step re-asked
        // and doubled the Qwen calls of a turn — the direct cause of the rate
        // limits that failed whole voice turns. Remember the refusal for this
        // generation and do not retry it within this task.
        layerB = null;
        const kind = err instanceof QwenError ? err.kind : "unknown";
        logger.warn("agent: enrichment unavailable; continuing on Layer A", {
          taskId: task.taskId,
          ...(turnId !== undefined ? { turnId } : {}),
          kind,
          ...(err instanceof Error ? { reason: err.message } : {}),
        });
        this.enrichSuppressed.set(task.taskId, snapshot.generation);
      }
      }
    }

    // --- Hybrid vision (CONTEXT_MODE=hybrid; default OFF) ----
    // AX-first, always: the full AX text below is the reasoning context on
    // every step, and eNN ids stay the sole executable targets
    // (WebGuard/registry untouched) — pixels can never authorize or address an
    // action, they only help the model READ canvas-heavy pages. In hybrid
    // mode the viewport screenshot is ATTACHED on every step alongside the
    // full AX text — never a registry swap.
    //
    // Local-only: the backend forwards images to the local provider and drops
    // them on cloud fallback, so attaching here can never leak pixels to a
    // hosted provider. Every capture failure degrades to DOM text-only.
    const sparsity = assessSnapshotSparsity(snapshot.items);
    const sparseTurnId = this.taskTurns.get(task.taskId);
    logger.info("agent: vision fallback check", {
      taskId: task.taskId,
      ...(sparseTurnId !== undefined ? { turnId: sparseTurnId } : {}),
      itemCount: sparsity.itemCount,
      unnamedCount: sparsity.unnamedCount,
      unnamedFraction: Number(sparsity.unnamedFraction.toFixed(3)),
      sparse: sparsity.sparse,
      reason: sparsity.reason,
    });
    // Full AX text on every step (byte-identical to the pre-fallback path).
    const packed = serializePage({
      url: snapshot.url,
      title: snapshot.title,
      generation: snapshot.generation,
      items: snapshot.items,
      headings: snapshot.structure?.headings ?? [],
      landmarks: snapshot.structure?.landmarks ?? [],
      forms: snapshot.structure?.forms ?? [],
      // Prose dominates the token bill (measured: 1071 input tokens without it,
      // ~3400 with a full article), and navigation never needs it. Sending the
      // whole article on every click is what exhausted the 8000-token/minute
      // budget and produced a constant stream of "too many requests".
      prose: needsPageProse(task) ? trimProse(snapshot.prose ?? []) : [],
    });
    const pageText = packed.text;
    const textTokens = packed.estimatedTokens;
    let hybridImage: HybridScreenshot | undefined;
    if (
      this.deps.contextMode === "hybrid" &&
      this.deps.captureScreenshot !== undefined
    ) {
      try {
        const captured = await this.deps.captureScreenshot(tabId);
        if (captured !== null) {
          hybridImage = captured;
          // Coarse comparator only (see estimateImageTokens): image cost next
          // to text cost in one record. Never a provider measurement.
          const estimatedImageTokens = estimateImageTokens(captured.width, captured.height);
          logger.info("agent: vision fallback attached", {
            taskId: task.taskId,
            ...(sparseTurnId !== undefined ? { turnId: sparseTurnId } : {}),
            reason: sparsity.reason,
            itemCount: sparsity.itemCount,
            textTokens,
            estimatedImageTokens,
            imageBytes: captured.bytes,
            imageWidth: captured.width,
            imageHeight: captured.height,
          });
        } else {
          logger.info("agent: vision fallback text-only (capture null)", {
            taskId: task.taskId,
            ...(sparseTurnId !== undefined ? { turnId: sparseTurnId } : {}),
            reason: sparsity.reason,
            textTokens,
          });
        }
      } catch (err) {
        logger.warn("agent: vision fallback text-only (capture failed)", {
          taskId: task.taskId,
          reason: err instanceof Error ? err.message : "unknown",
          textTokens,
        });
      }
    }
    const provided = Object.entries(task.providedValues)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    // Capability advertisement: the model can name a trusted skill instead of
    // re-deriving its low-level steps. Empty when no skill is executable, in
    // which case the section is omitted entirely.
    const skillText = describeAvailableSkills(this.skills().registry);
    // Captured BEFORE the reasoning await: any X/stop/supersede during the
    // await bumps runCounter or aborts this task's signal, and the late
    // result is then discarded instead of dispatched (see isStepStale).
    const runIdAtStep = this.runCounter;
    const abortSignal = this.taskAbort.get(task.taskId)?.signal;
    // Phase 2 continuation: after a verified action the model must keep
    // working the SAME goal, not re-ask what to do. Generic wording (never a
    // hardcoded example): remaining work is implied by goal minus completed.
    const continuationSuffix =
      task.currentStep === 0
        ? ""
        : " The previous action completed and was verified." +
          " Continue with the next step toward the goal." +
          " Do not ask the user what to do next unless a required secret" +
          " (password, OTP, card number) is genuinely missing.";
    // Loop breaker: consecutive ordinary ask_user outcomes with no intervening
    // action mean the model is stalling. Say so explicitly on every following
    // intent until an action breaks the chain (the counter resets on action,
    // terminal outcomes, finish and cancel).
    // (consecutiveAsk can only be non-zero after an ask already happened, so
    // no step counter is needed; currentStep stays 0 until an action verifies.)
    const askStallSuffix =
      (this.consecutiveAsk.get(task.taskId) ?? 0) > 0
        ? " You already asked the user and received no new information." +
          " Act on the page now: emit the single best click/type/focus action" +
          " for the goal, or task_complete/cannot_complete. Do not emit ask_user again."
        : "";
    task.qwenCalls += 1;
    let outcome;
    const reason = this.deps.reason ?? reasonOnce;
    const turnId = this.taskTurns.get(task.taskId);
    try {
      outcome = await reason({
        backend,
        fetchImpl: this.deps.fetchImpl,
        ...(turnId !== undefined ? { turnId } : {}),
        userPayload: buildUserPayload({
          // Verified observations ride on EVERY reasoning call, including the
          // first: a web_search (or a recovered failure) at step 0 must be
          // visible or the next call reasons blind.
          intent:
            task.currentStep === 0
              ? `User goal: ${task.goal}${provided !== "" ? `\nUser already provided: ${provided}` : ""}` +
                (task.lastVerifiedResult !== null ? ` Last verified: ${task.lastVerifiedResult}.` : "") +
                // Ask-stall loop breaker (Phase 2): an ask-loop never verifies
                // an action, so currentStep stays 0 — the directive must live
                // in BOTH branches, not just the continuing one.
                askStallSuffix
              : `Continuing goal "${task.goal}". Completed ${task.completedActions} action(s).` +
                (task.lastVerifiedResult !== null ? ` Last verified: ${task.lastVerifiedResult}.` : "") +
                (provided !== "" ? ` User provided: ${provided}.` : "") +
                continuationSuffix +
                askStallSuffix +
                ` Determine ONLY the next action.`,
          lang: task.goalLang,
          pageText,
          ...(skillText !== "" ? { skills: skillText } : {}),
        }),
        ...(hybridImage !== undefined ? { image: hybridImage } : {}),
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
      });
    } catch (err) {
      // Cancelled mid-reasoning: the abort rejects the fetch. Discard silently
      // — failReasoning would speak a failure message for a turn the user
      // explicitly stopped.
      if (this.isStepStale(task, runIdAtStep)) return;
      await this.failReasoning(task, tabId, store, err);
      return;
    }
    // Late AI result: cancelled/superseded while reasoning. Discard completely
    // — no dispatch (no execution), no narration, no state change.
    if (this.isStepStale(task, runIdAtStep)) return;

    this.emitProgress({ taskId: task.taskId, kind: "step", qwenCalls: task.qwenCalls });
    await this.dispatchOutcome(outcome, task, snapshot, tabId, store);
  }

  private async enrichViaBackend(
    input: {
      pageText: string;
      generation: number;
      lang: "en" | "hi" | "mixed";
    },
    backend: BackendRef,
    turnId?: string,
  ): Promise<LayerB> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (backend.token !== undefined && backend.token !== "") {
      headers["Authorization"] = `Bearer ${backend.token}`;
    }
    logger.info("api: enrich attempt", {
      ...(turnId !== undefined ? { turnId } : {}),
      requestType: "enrich",
      timestampMs: Date.now(),
      attempt: 1,
      maxAttempts: 1,
      pageChars: input.pageText.length,
    });
    const res = await (this.deps.fetchImpl ?? fetch)(
      `${backend.url}${ENDPOINTS.enrich}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          pageText: input.pageText,
          generation: input.generation,
          lang: input.lang,
          ...(turnId !== undefined ? { turnId } : {}),
        }),
      },
    );
    if (!res.ok) {
      await res.text().catch(() => "");
      logger.warn("api: enrich failed", {
        ...(turnId !== undefined ? { turnId } : {}),
        requestType: "enrich",
        timestampMs: Date.now(),
        attempt: 1,
        outcome: res.status === 429 ? "rate-limited" : "error",
        httpStatus: res.status,
      });
      throw new Error(`enrich failed (HTTP ${res.status})`);
    }
    logger.info("api: enrich ok", {
      ...(turnId !== undefined ? { turnId } : {}),
      requestType: "enrich",
      timestampMs: Date.now(),
      attempt: 1,
      outcome: "ok",
      httpStatus: res.status,
    });
    const data = (await res.json()) as LayerB;
    if (
      typeof data.interpretation !== "string" ||
      typeof data.pageGeneration !== "number"
    ) {
      throw new Error("enrich returned malformed layer");
    }
    return {
      interpretation: data.interpretation,
      pageGeneration: data.pageGeneration,
      producedAt: typeof data.producedAt === "number" ? data.producedAt : Date.now(),
      provenance: "MODEL_INFERENCE",
    };
  }

  /** Default web-search path: backend /v1/search contract. Single attempt. */
  private async searchViaBackend(
    input: { query: string; maxResults?: number; turnId?: string },
    backend: BackendRef,
  ): Promise<{ results: SearchResultItem[] }> {
    return webSearch(input.query, {
      backend,
      fetchImpl: this.deps.fetchImpl,
      ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    });
  }

  /**
   * Executes a model-proposed web_search: results become the task's verified
   * observation so the NEXT reasoning step answers from them or navigates to
   * one of their URLs (existing actions). Never finishes the task — the loop
   * continues. Failures count as recoveries (bounded by policy), never loops.
   */
  private async doWebSearch(
    action: StructuredAction,
    task: TaskSnapshot,
    snapshot: PageSnapshotLike,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    void snapshot;
    const backend = this.deps.backend;
    if (backend === undefined) {
      await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
      return;
    }
    const params = (action.parameters ?? {}) as Record<string, unknown>;
    const query = typeof params["query"] === "string" ? params["query"] : "";
    if (query.trim() === "") {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = "web search refused: empty query";
      await store.save(task);
      const speak = this.deps.speak ?? (async () => undefined);
      await this.afterFailure(task, snapshot, tabId, store, speak);
      return;
    }
    // Free-will search gate: only generic budget/duplicate guards remain.
    // The model decides itself whether web_search, browser_search, page
    // interaction, or direct navigation fits the goal — no intent-based or
    // navigational refusals. Former hardcoded refusals (browser/page intent,
    // navigational) are intentionally removed so e.g. "play X on YouTube" can
    // web_search, extract the observed YouTube link, and play it.
    const normalizedQuery = normalizeSearchQuery(query);
    const searchedQueries = task.searchedQueries ?? [];
    const searchesSpent = task.searchCount ?? 0;
    const turnForRefusal = this.taskTurns.get(task.taskId);
    void turnForRefusal;
    if (searchedQueries.includes(normalizedQuery)) {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = `web search refused: "${query}" was already searched — answer from the earlier observations or navigate to one of their URLs`;
      await store.save(task);
      logger.warn("agent: web search refused (duplicate)", {
        taskId: task.taskId,
        ...(turnForRefusal !== undefined ? { turnId: turnForRefusal } : {}),
        query: query.slice(0, 120),
      });
      return;
    }
    if (searchesSpent >= MAX_SEARCHES_PER_TASK) {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult =
        "web search refused: search budget spent — answer from the earlier observations or navigate to one of their URLs";
      await store.save(task);
      logger.warn("agent: web search refused (budget spent)", {
        taskId: task.taskId,
        ...(turnForRefusal !== undefined ? { turnId: turnForRefusal } : {}),
        query: query.slice(0, 120),
      });
      return;
    }
    // Spend one budget unit: recorded in memory now, persisted by the saves
    // below on every path that reached Tavily (results, empty, or error).
    task.searchCount = searchesSpent + 1;
    task.searchedQueries = [...searchedQueries, normalizedQuery];
    const speak = this.deps.speak ?? (async () => undefined);
    const turnId = this.taskTurns.get(task.taskId);
    this.emitProgress({ taskId: task.taskId, kind: "searching" });
    const search = this.deps.search ?? ((input) => this.searchViaBackend(input, backend));
    try {
      const { results } = await search({
        query,
        maxResults: 5,
        ...(turnId !== undefined ? { turnId } : {}),
      });
      if (results.length === 0) {
        task.lastVerifiedResult = `web search for "${query}" returned no results`;
        await store.save(task);
        await speak(
          task.goalLang === "hi" ? "वेब पर कुछ नहीं मिला।" : "Nothing on the web for that.",
          task.goalLang,
          3,
        );
        return; // loop continues; Qwen answers from the empty observation
      }
      const lines = results.map((r, i) => {
        const snippet =
          r.snippet.length > 120 ? `${r.snippet.slice(0, 120).trimEnd()}…` : r.snippet;
        return `${i + 1}) ${r.title} — ${r.url}${snippet !== "" ? `: ${snippet}` : ""}`;
      });
      // Result-Type Routing (additive): classify each Tavily hit from its
      // observed title/url/snippet (multi-signal, never URL-only) and steer
      // the next step with a goal-specific directive. A found URL is
      // intermediate evidence, not completion — unless the goal was only
      // research to be answered from these observations.
      const resultTypes = results.map((r) =>
        classifyResultType({
          title: r.title,
          url: r.url,
          domain: domainOf(r.url),
          surroundingText: r.snippet,
        }),
      );
      const webStrategies = selectSearchStrategies(task.goal, "web_research");
      task.searchStrategies = webStrategies;
      const webRouting = routeGoalResult(task.goal);
      task.pendingResultRouting =
        webRouting.continuation === "search_complete" ||
        // Research answered-from-observations is a legitimate completion:
        // answering from these results consumes the routing.
        webRouting.continuation === "read_and_answer"
          ? null
          : {
              continuation: webRouting.continuation,
              query,
              strategies: webStrategies,
            };
      // Free-will grounding: every returned URL becomes observed evidence
      // for this task. A later navigate must use an observed URL — e.g. a
      // YouTube video link extracted from these results — never an invented one.
      this.rememberObservedUrls(
        task.taskId,
        results.map((r) => r.url),
      );
      task.lastVerifiedResult =
        `web search for "${query}": ${lines.join(" | ")} ` +
        `[result types: ${resultTypes.join(", ")}]. ${webRouting.directive} ` +
        `Only navigate to a URL from these observed results — never invent one.`;
      await store.save(task);
      const spoken = results
        .slice(0, 3)
        .map((r) => shortTitle(r.title))
        .join(", ");
      await speak(
        task.goalLang === "hi"
          ? `${results.length} परिणाम मिले: ${spoken}।`
          : `Found ${results.length} results: ${spoken}.`,
        task.goalLang,
        4,
      );
    } catch (err) {
      const rateLimited = err instanceof SearchError && err.status === 429;
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = rateLimited
        ? "web search rate limited — wait before retrying"
        : "web search failed";
      await store.save(task);
      logger.warn("agent: web search failed", {
        taskId: task.taskId,
        ...(turnId !== undefined ? { turnId } : {}),
        kind: rateLimited ? "rate_limit" : "error",
        ...(err instanceof Error ? { reason: err.message } : {}),
      });
      await this.afterFailure(task, snapshot, tabId, store, speak);
    }
  }

  /**
   * Executes a browser_search: browser-level search via the Chrome default
   * engine in the CURRENT tab (PRD 6.10 §6/§8). Runs through the SAME trusted
   * path as every other action — WebGuard → executor → verification →
   * fresh-observation settle — so stale-target protection (§17) and
   * search-results verification (§18) apply unchanged. The next reasoning step
   * then grounds result selection (title/domain/snippet/ordinal, §12) from
   * the FRESH results snapshot, never from pre-search targets.
   *
   * Privacy-safe telemetry only (intent, mode, truncated query); never page
   * contents or secrets (§24). Telemetry never steers the action path.
   */
  private async doBrowserSearch(
    action: StructuredAction,
    task: TaskSnapshot,
    snapshot: PageSnapshotLike,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const params = (action.parameters ?? {}) as Record<string, unknown>;
    const rawQuery = typeof params["query"] === "string" ? params["query"] : "";
    const query = rawQuery.trim();
    const turnId = this.taskTurns.get(task.taskId);
    if (query === "") {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult =
        "browser search refused: empty query — re-observe the page before retrying";
      await store.save(task);
      logger.warn("agent: browser search refused (empty query)", {
        taskId: task.taskId,
        ...(turnId !== undefined ? { turnId } : {}),
      });
      const speak = this.deps.speak ?? (async () => undefined);
      await this.afterFailure(task, snapshot, tabId, store, speak);
      return;
    }
    task.searchMode = "browser";
    // Search Strategy (additive): WHAT to look for, selected from intent +
    // goal context. Execution still uses the browser-search path unchanged.
    const strategies: SearchStrategy[] = selectSearchStrategies(
      task.goal,
      classifySearchIntent(task.goal),
    );
    task.searchStrategies = strategies;
    logger.info("agent: browser search", {
      taskId: task.taskId,
      ...(turnId !== undefined ? { turnId } : {}),
      intent: "browser",
      searchMode: "browser",
      strategies,
      query: query.slice(0, 120),
      preSearchUrl: snapshot.url.slice(0, 200),
      tabId,
    });
    this.emitProgress({ taskId: task.taskId, kind: "searching" });
    await this.doAction(
      {
        action: "browser_search",
        parameters: { query },
        expect: { type: "navigation_completed" },
      },
      task,
      snapshot,
      tabId,
      store,
      { sensitiveAuthorized: false, confirmed: false },
    );
  }

  /**
   * Article search-to-open fast-path ("open the latest news article of India"
   * → web_search + immediate navigate, no reasoning turns). The query is
   * generic-extracted from the goal (never a fixed topic), the destination is
   * the best observed search result preferring ARTICLE/NEWS types (never an
   * invented URL — it is remembered as observed before navigating, so the
   * grounding check passes), and execution runs the trusted WebGuard →
   * executor → verification path. Finishes COMPLETE right after verified
   * navigation.
   */
  private async doArticleFastPath(
    task: TaskSnapshot,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
    query: string,
  ): Promise<void> {
    const backend = this.deps.backend;
    const speak = this.deps.speak ?? (async () => undefined);
    if (backend === undefined) {
      await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
      return;
    }
    const normalized = normalizeSearchQuery(query);
    const searchedQueries = task.searchedQueries ?? [];
    const searchesSpent = task.searchCount ?? 0;
    if (normalized === "") {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = "article search refused: empty query";
      await store.save(task);
      return;
    }
    if (searchedQueries.includes(normalized) || searchesSpent >= MAX_SEARCHES_PER_TASK) {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult =
        "article search refused: search budget spent — answer from earlier observations";
      await store.save(task);
      return;
    }
    task.searchCount = searchesSpent + 1;
    task.searchedQueries = [...searchedQueries, normalized];
    task.searchMode = "web_research";
    task.searchStrategies = selectSearchStrategies(task.goal, "web_research");
    const turnId = this.taskTurns.get(task.taskId);
    this.emitProgress({ taskId: task.taskId, kind: "searching" });
    const search = this.deps.search ?? ((input) => this.searchViaBackend(input, backend));
    let results: SearchResultItem[];
    try {
      const out = await search({
        query,
        maxResults: 5,
        ...(turnId !== undefined ? { turnId } : {}),
      });
      results = out.results;
    } catch (err) {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = "article search failed";
      await store.save(task);
      logger.warn("agent: article fast-path search failed", {
        taskId: task.taskId,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(err instanceof Error ? { reason: err.message } : {}),
      });
      return;
    }
    if (results.length === 0) {
      task.lastVerifiedResult = `article search for "${query}" returned no results`;
      await store.save(task);
      await speak(
        task.goalLang === "hi" ? "वेब पर कुछ नहीं मिला।" : "Nothing on the web for that.",
        task.goalLang,
        3,
      );
      await this.finish(task, "FAILED", null, tabId, store);
      return;
    }
    // Best observed result, preferring ARTICLE/NEWS types. Generic scoring
    // only — no domains, no topics.
    let best = results[0] as SearchResultItem;
    let bestScore = -1;
    for (const r of results) {
      const t = classifyResultType({
        title: r.title,
        url: r.url,
        domain: domainOf(r.url),
        surroundingText: r.snippet,
      });
      const score = t === "ARTICLE" ? 3 : t === "NEWS" ? 2 : 1;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    this.rememberObservedUrls(task.taskId, [best.url]);
    const dummySnapshot: PageSnapshotLike = {
      url: "about:blank",
      title: "",
      generation: 0,
      items: [],
    };
    await this.doAction(
      {
        action: "navigate",
        parameters: { url: best.url },
        expect: { type: "navigation_completed" },
      },
      task,
      dummySnapshot,
      tabId,
      store,
      { sensitiveAuthorized: false, confirmed: false },
    );
    const latest = await store.load();
    if (latest === null || latest.taskId !== task.taskId) return;
    if (isTerminal(latest.status)) return;
    task.lastVerifiedResult = `article opened: ${best.title} — ${best.url}`;
    await store.save(task);
    this.emitProgress({ taskId: task.taskId, kind: "speaking", prompt: best.title });
    await speak(shortTitle(best.title), task.goalLang, 4);
    await this.finish(task, "COMPLETE", null, tabId, store);
  }

  // -- Outcome dispatch ----------------------------------------------------------

  private async dispatchOutcome(
    outcome: Awaited<ReturnType<typeof reasonOnce>>,
    task: TaskSnapshot,
    snapshot: PageSnapshotLike,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    this.recorder.recordOutcome(task.taskId, outcome);
    switch (outcome.type) {
      case "answer":
        // Mirror the spoken text to the on-screen overlay in the same moment
        // it starts speaking, so the user reads what the model just produced.
        this.emitProgress({ taskId: task.taskId, kind: "speaking", prompt: outcome.text ?? "" });
        await speak(outcome.text ?? "", task.goalLang, 4);
        await this.finish(task, "COMPLETE", null, tabId, store);
        return;
      case "task_complete":
        this.consecutiveAsk.delete(task.taskId);
        if (outcome.text !== undefined && outcome.text !== "") {
          this.emitProgress({ taskId: task.taskId, kind: "speaking", prompt: outcome.text });
          await speak(outcome.text, task.goalLang, 4);
        }
        await this.finish(task, "COMPLETE", null, tabId, store);
        return;
      case "cannot_complete": {
        this.consecutiveAsk.delete(task.taskId);
        const reason = outcome.reason ?? getErrorSpeech("ACTION_FAILED", langOf(task));
        this.emitProgress({ taskId: task.taskId, kind: "speaking", prompt: reason });
        await speak(reason, task.goalLang, 3);
        await this.finish(task, "FAILED", null, tabId, store);
        return;
      }
      case "ask_user": {
        if (outcome.question === undefined) {
          await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
          return;
        }
        // Loop accounting (Phase 2): an ordinary ask with no intervening
        // action arms the continue-directive on the NEXT intent. A secret
        // genuinely missing stays a question — high-sensitivity asks never
        // count, so this can never pressure the model into guessing a secret.
        if ((outcome.sensitivity ?? "ordinary") === "high") {
          this.consecutiveAsk.delete(task.taskId);
        } else {
          this.consecutiveAsk.set(task.taskId, (this.consecutiveAsk.get(task.taskId) ?? 0) + 1);
        }
        task.status = "WAITING_FOR_USER_ANSWER";
        task.pendingQuestion = {
          field: outcome.field ?? "value",
          question: outcome.question,
          sensitivity: outcome.sensitivity ?? "ordinary",
          askedAt: this.now(),
        };
        await store.save(task);
        this.emitProgress({
          taskId: task.taskId,
          kind: "waiting-answer",
          prompt: outcome.question,
        });
        await speak(outcome.question, task.goalLang, 2);
        if (this.deps.startVoiceCapture !== undefined) {
          void this.deps.startVoiceCapture().catch(() => undefined);
        }
        return;
      }
      case "confirmation_required": {
        if (outcome.reason === undefined || outcome.action === undefined) {
          await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
          return;
        }
        // The model can also request confirmation itself. If the user already
        // approved THIS action, honour it instead of asking the same question
        // again — otherwise a model that re-proposes the wrapper every step
        // produces an unbreakable yes/no loop.
        if (this.isApproved(task.taskId, outcome.action)) {
          logger.info("agent: model re-requested confirmation for an approved action", {
            taskId: task.taskId,
            actionType: outcome.action.action,
            targetId: outcome.action.target,
          });
          this.rememberApproval(task.taskId, outcome.action);
          await this.doAction(outcome.action, task, snapshot, tabId, store, {
            sensitiveAuthorized: false,
            confirmed: true,
          });
          return;
        }
        // The stored summary is the sanitized speech, never the raw model
        // reason (which may echo secret values into persisted TaskState).
        const confirmTarget =
          outcome.action.target !== undefined
            ? this.targetsOf(snapshot).get(outcome.action.target) ?? null
            : null;
        const confirmSpeechText = buildConfirmationSpeech(
          outcome.action,
          confirmTarget,
          outcome.reason,
          task.goalLang,
        );
        task.status = "WAITING_FOR_CONFIRMATION";
        task.pendingConfirmation = {
          summary: confirmSpeechText,
          actionIndex: task.completedActions,
          askedAt: this.now(),
          action: outcome.action,
        };
        this.reasks.set(task.taskId, 0);
        await store.save(task);
        this.emitProgress({
          taskId: task.taskId,
          kind: "waiting-confirm",
          prompt: confirmSpeechText,
        });
        await speak(confirmSpeechText, task.goalLang, 1);
        if (this.deps.startVoiceCapture !== undefined) {
          void this.deps.startVoiceCapture().catch(() => undefined);
        }
        return;
      }
      case "action": {
        if (outcome.action === undefined) {
          await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
          return;
        }
        // Progress: an action breaks any ask-stall chain.
        this.consecutiveAsk.delete(task.taskId);
        if (outcome.action.action === "read") {
          await this.doRead(outcome.action, task, snapshot, tabId, store);
          return;
        }
        if (outcome.action.action === "web_search") {
          await this.doWebSearch(outcome.action, task, snapshot, tabId, store);
          return;
        }
        if (outcome.action.action === "browser_search") {
          await this.doBrowserSearch(outcome.action, task, snapshot, tabId, store);
          return;
        }
        await this.doAction(outcome.action, task, snapshot, tabId, store, {
          sensitiveAuthorized: false,
          confirmed: false,
        });
        return;
      }
      case "skill": {
        if (outcome.skill === undefined) {
          await this.finish(task, "FAILED", "AI_SERVICE_UNAVAILABLE", tabId, store);
          return;
        }
        // Skill selection names a REGISTERED procedure. The registry — not the
        // model — decides whether it may run: an unknown, disabled, candidate,
        // or unresolvable skill fails closed inside stepSkill and hands control
        // back for re-evaluation. Never a silent substitute, never a direct
        // action instead (STEP 9).
        await this.selectSkill(outcome.skill, task, tabId, store);
        return;
      }
    }
  }

  // -- Skill execution ---------------------------------------------------------------

  /**
   * Activates a model-selected skill and executes its first action for the
   * current page state. Activation itself authorizes nothing: stepSkill
   * re-derives the plan from the live page state and every action still passes
   * WebGuard → executor → verification.
   */
  private async selectSkill(
    selection: SkillSelection,
    task: TaskSnapshot,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const inputs: SkillInputs = { ...selection.input };
    logger.info("agent: skill selected", {
      taskId: task.taskId,
      skillId: selection.skillId,
      ...(this.taskTurns.get(task.taskId) !== undefined
        ? { turnId: this.taskTurns.get(task.taskId) as string }
        : {}),
    });
    // Snapshot the registry at activation: the plan is tied to the version
    // selection in force RIGHT NOW, so a later mutation (new version, rollout,
    // rollback) cannot silently change the meaning of this in-flight plan.
    const active = {
      skillId: selection.skillId,
      inputs,
      view: this.skills().registry.snapshot(),
    };
    this.activeSkills.set(task.taskId, active);
    const registered = active.view.get(selection.skillId);
    if (registered !== null) {
      const input: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(inputs)) {
        if (value !== undefined) input[key] = value;
      }
      this.recorder.recordSkill(task.taskId, {
        skillId: registered.id,
        skillVersion: registered.version,
        skillStatus: registered.status,
        input,
        plannedVersion: registered.version,
      });
    }
    await this.stepSkill(task, active, tabId, store);
  }

  private clearActiveSkill(taskId: string): void {
    this.activeSkills.delete(taskId);
  }

  /**
   * Executes the NEXT action of the active skill against the CURRENT page
   * state, then observes the result.
   *
   * The resolver is page-state driven, so re-running it after each action
   * naturally yields the next step (click → observe → read). Nothing is batched:
   * every action goes through the SAME doAction/doRead path a model-proposed
   * action uses — WebGuard, the executor, verification, recovery and the action
   * budget are all unchanged. A terminal action ends the skill and returns
   * control to the model; a transition keeps the skill active for the next
   * observed step. A controlled failure also returns control (STEP 8/9).
   */
  private async stepSkill(
    task: TaskSnapshot,
    active: { skillId: string; inputs: SkillInputs; view: SkillRegistryView },
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    if (
      task.completedActions >= MAX_ACTIONS_PER_TASK ||
      task.qwenCalls >= MAX_QWEN_CALLS_PER_TASK ||
      this.now() - task.startedAt >= MAX_TASK_DURATION_MS
    ) {
      this.clearActiveSkill(task.taskId);
      await this.finish(task, "LIMIT_REACHED", "TASK_LIMIT_REACHED", tabId, store);
      return;
    }

    const snapshot = await this.ensureCurrentSnapshot(tabId, task.taskId);
    if (snapshot === null) {
      this.clearActiveSkill(task.taskId);
      await this.finish(task, "FAILED", "CANNOT_ACCESS_PAGE", tabId, store);
      return;
    }
    if (/^(chrome|chrome-extension|about|edge|view-source|file):/i.test(snapshot.url)) {
      this.clearActiveSkill(task.taskId);
      await this.finish(task, "FAILED", "UNSUPPORTED_PAGE", tabId, store);
      return;
    }

    // Use the snapshot taken when the skill was activated, not the live
    // registry: plan semantics stay stable across registry mutations.
    const registry = active.view;
    const { catalog } = this.skills();
    let plan: ReturnType<typeof planSkill>;
    try {
      plan = planSkill({
        registry,
        catalog,
        skillId: active.skillId,
        snapshot,
        inputs: active.inputs,
      });
    } catch (err) {
      // planSkill is built not to throw; this is belt-and-suspenders so a faulty
      // skill can never crash the extension runtime.
      void err;
      this.clearActiveSkill(task.taskId);
      logger.error("agent: skill planning threw", {
        taskId: task.taskId,
        skillId: active.skillId,
        errorCode: "ACTION_FAILED",
      });
      await this.finish(task, "FAILED", "ACTION_FAILED", tabId, store);
      return;
    }

    if (plan.status !== "ready" || plan.actions.length === 0) {
      // Controlled failure (unknown_skill / not_executable / invalid_plan /
      // missing_input / not_found / ambiguous / unsupported_page). Report it to
      // the reasoning loop via the EXISTING recovery semantics; no substitute.
      this.clearActiveSkill(task.taskId);
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = `skill "${active.skillId}" not run (${plan.status})${
        plan.reason !== undefined ? `: ${plan.reason}` : ""
      }`;
      await store.save(task);
      logger.warn("agent: skill could not run", {
        taskId: task.taskId,
        skillId: active.skillId,
        skillStatus: plan.status,
        ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
      });
      await this.afterFailure(task, snapshot, tabId, store, speak);
      return;
    }

    const action = plan.actions[0] as StructuredAction;
    logger.info("agent: executing skill action", {
      taskId: task.taskId,
      skillId: active.skillId,
      skillVersion: plan.skillVersion,
      actionType: action.action,
      ...(action.target !== undefined ? { targetId: action.target } : {}),
    });

    if (action.action === "read") {
      // Terminal: the read IS the observation the user asked for.
      this.clearActiveSkill(task.taskId);
      const text = await this.readAloud(action, task, tabId, store);
      this.recordEpisodeAction(task, snapshot, action, "read");
      if (text === null) {
        await this.finish(task, "FAILED", "ACTION_FAILED", tabId, store);
        return;
      }
      if (text.trim() === "") {
        task.recoveryAttempts += 1;
        task.lastVerifiedResult = `skill "${active.skillId}": region had no readable text`;
        await store.save(task);
        await speak(getErrorSpeech("ELEMENT_NOT_FOUND", langOf(task)), task.goalLang, 3);
        await this.afterFailure(task, snapshot, tabId, store, speak);
        return;
      }
      task.lastVerifiedResult = `skill "${active.skillId}" read ${text.length} characters`;
      await store.save(task);
      return; // loop continues → the model answers / completes
    }

    if (action.action === "web_search") {
      this.clearActiveSkill(task.taskId);
      await this.doWebSearch(action, task, snapshot, tabId, store);
      return;
    }

    await this.doAction(action, task, snapshot, tabId, store, {
      sensitiveAuthorized: false,
      confirmed: false,
    });
    const latest = await store.load();
    if (latest === null || latest.taskId !== task.taskId) return;
    // A consequential (submit-style) action is never silently re-derived and
    // re-run by the skill: the model re-evaluates instead. This is the skill
    // path's twin of the executor's "never retry a side effect" rule and is
    // what stops a confirmed submit from executing twice.
    const targetItem =
      action.target !== undefined
        ? (snapshot.items.find((i) => i.id === action.target) ?? null)
        : null;
    if (isTerminalSkillAction(action.action) || isSideEffectingAction(action, targetItem)) {
      this.clearActiveSkill(task.taskId);
    }
  }

  // -- Action execution ------------------------------------------------------------

  /** Records the user's explicit consent for one action signature. */
  private rememberApproval(taskId: string, action: StructuredAction): void {
    const set = this.approvals.get(taskId) ?? new Set<string>();
    set.add(approvalSignature(action));
    this.approvals.set(taskId, set);
  }

  /** True when the user already said yes to this exact action in this task. */
  private isApproved(taskId: string, action: StructuredAction): boolean {
    return this.approvals.get(taskId)?.has(approvalSignature(action)) === true;
  }

  /**
   * Late-result guard (Phase 2 hardening). A reasoning await that resolves
   * after X/stop/supersede must be discarded COMPLETELY — no dispatch, no
   * execution, no narration, no state change. Either signal fires: the global
   * run counter moved (cancel/supersede bumps it), or this task's own abort
   * was triggered.
   */
  private isStepStale(task: TaskSnapshot, runIdAtStep: number): boolean {
    if (runIdAtStep !== this.runCounter) return true;
    return this.taskAbort.get(task.taskId)?.signal.aborted === true;
  }

  private targetsOf(snapshot: PageSnapshotLike): Map<string, TargetInfo> {
    const map = new Map<string, TargetInfo>();
    for (const item of snapshot.items) {
      map.set(item.id, {
        id: item.id,
        role: item.role,
        name: item.name,
        fieldKind: item.fieldKind,
        sensitive: item.sensitive,
        isSubmit: isSubmitControl(item.role, item.name),
      });
    }
    return map;
  }

  /**
   * The controller, not the model, owns the page generation.
   *
   * The model is asked to echo `pageGeneration` so WebGuard can refuse actions
   * reasoned from a stale page observation. Measured with the local
   * llama3.2:3b model: it routinely INVENTS that number (42, 13, …) while
   * proposing a perfectly valid target, so the genuine action was rejected as
   * "stale" and the user heard "That action was blocked for safety" — for
   * simply opening a repository.
   *
   * That claim is unreliable model input, not a safety signal: this step has
   * ALREADY loaded a fresh snapshot, so the state the model saw is current by
   * construction. When the action's target is present in the CURRENT registry,
   * the generation is therefore reconciled to the snapshot's.
   *
   * Nothing is weakened for genuinely stale or unknown targets:
   *  - target missing from the registry  -> not touched, WebGuard still BLOCKs
   *  - sensitivity / provenance / submit   -> unchanged
   *  - the executor still re-resolves the element at the click instant, and
   *    post-action verification is untouched.
   */
  private reconcileGeneration(
    action: StructuredAction,
    snapshot: PageSnapshotLike,
    targets: Map<string, TargetInfo>,
  ): StructuredAction {
    if (action.pageGeneration === snapshot.generation) return action;
    if (action.target === undefined) return action;
    if (!targets.has(action.target)) return action; // unknown target: let the guard block it
    logger.info("agent: reconciling model-reported page generation", {
      actionType: action.action,
      targetId: action.target,
      pageGeneration: snapshot.generation,
      modelClaimedGeneration: action.pageGeneration ?? -1,
    });
    return { ...action, pageGeneration: snapshot.generation };
  }

  /**
   * Execution Router (Phase 7): selects LOCAL or OPTIONAL EXTERNAL by policy.
   *
   * This runs AFTER WebGuard, consent and the budgets, so it decides WHERE an
   * already-authorized action executes — never WHETHER it may. The model has no
   * say, and there is no automatic local→external escalation: `chooseExecutionMode`
   * returns LOCAL unless policy explicitly permits external execution.
   *
   * A bridge failure falls back to LOCAL only when nothing was dispatched
   * (unsupported capability / unauthorized task). Timeout, malformed and
   * transport failures are returned as failures so the EXISTING recovery
   * semantics apply — never a blind second attempt that could double-execute.
   */
  private async runRoutedExecution(
    action: StructuredAction,
    task: TaskSnapshot,
    tabId: number,
    pageGeneration: number,
    grounding?: { node?: { role: string; name: string }; url?: string },
  ): Promise<ExecutionResult> {
    const policy = this.deps.executionPolicy ?? DEFAULT_EXECUTION_POLICY;
    const decision = chooseExecutionMode(policy, { taskId: task.taskId });
    const external = this.deps.externalExecutor;
    this.executionModes.set(task.taskId, "local");
    if (decision.mode === "external" && external !== undefined) {
      const result = await external.execute(action, {
        tabId,
        pageGeneration,
        taskId: task.taskId,
        ...(grounding?.node !== undefined ? { node: grounding.node } : {}),
        ...(grounding?.url !== undefined ? { url: grounding.url } : {}),
      });
      if (result.status === "executed") {
        this.executionModes.set(task.taskId, "external");
        logger.info("execution: routed externally", {
          taskId: task.taskId,
          actionType: action.action,
          executor: external.kind,
        });
        return result;
      }
      const safeToLocal =
        result.errorCode === "BRIDGE_UNSUPPORTED_CAPABILITY" ||
        result.errorCode === "BRIDGE_TASK_NOT_AUTHORIZED" ||
        // Nothing could be handed to the bridge at all (transport refused the
        // send), so running locally is safe and matches "fall back safely".
        result.errorCode === "BRIDGE_UNAVAILABLE";
      if (!safeToLocal) {
        logger.warn("execution: external path failed; using recovery semantics", {
          taskId: task.taskId,
          actionType: action.action,
          errorCode: result.errorCode ?? "unknown",
        });
        return result; // dispatched-but-unknown: never retry blindly
      }
      logger.info("execution: not expressible externally; running locally", {
        taskId: task.taskId,
        actionType: action.action,
        reason: result.errorCode,
      });
    }
    const executeFn = this.deps.executeFn ?? realExecute;
    return executeFn(action, { tabId, pageGeneration });
  }

  /**
   * The ONLY entry point the optional MCP interface may use to perform an
   * action. It dispatches through the SAME path as a model-proposed action, so
   * WebGuard, consent, action/recovery budgets and verification are all
   * unchanged — MCP gets no policy bypass of any kind.
   */
  async submitAction(
    action: StructuredAction,
  ): Promise<{ ok: boolean; reason?: string }> {
    const store = this.deps.store ?? { load: loadTask, save: saveTask, clear: clearTask };
    const task = await store.load();
    if (task === null) return { ok: false, reason: "no_active_task" };
    if (isTerminal(task.status)) return { ok: false, reason: "task_not_active" };
    if (
      task.status === "WAITING_FOR_CONFIRMATION" ||
      task.status === "WAITING_FOR_USER_ANSWER" ||
      task.status === "PAUSED_USER_OVERRIDE"
    ) {
      return { ok: false, reason: "task_waiting" };
    }
    if (task.completedActions >= MAX_ACTIONS_PER_TASK) {
      return { ok: false, reason: "action_budget_exhausted" };
    }
    const snapshot =
      await (this.deps.loadSnapshot ?? (async () => null))(task.tabId);
    if (snapshot === null) return { ok: false, reason: "no_page_state" };
    // Snapshot BEFORE dispatch: the task object may be mutated in place by the
    // action path, so the post-state must be compared against a captured value.
    const beforeActions = task.completedActions;
    const beforeTaskId = task.taskId;
    await this.dispatchOutcome(
      { type: "action", action },
      task,
      snapshot,
      task.tabId,
      store,
    );
    // Report the OUTCOME of the trusted path, not merely "it was dispatched",
    // so an MCP caller can never mistake a block or a consent gate for success.
    const after = await store.load();
    if (after === null || after.taskId !== beforeTaskId) {
      return { ok: false, reason: "task_ended" };
    }
    if (after.status === "BLOCKED") return { ok: false, reason: "blocked_by_policy" };
    if (after.status === "FAILED") return { ok: false, reason: "action_failed" };
    if (after.status === "LIMIT_REACHED") return { ok: false, reason: "action_budget_exhausted" };
    if (after.status === "WAITING_FOR_CONFIRMATION") {
      return { ok: false, reason: "consent_required" };
    }
    if (after.completedActions <= beforeActions) {
      return { ok: false, reason: "no_progress" };
    }
    return { ok: true };
  }

  /**
   * Post-navigation settle (compound-task fix). After a verified navigate
   * (or a STALE_STATE that implies one), the content script needs 1–5 s to
   * post the new page's snapshot — reasoning immediately would act on stale
   * refs from the pre-navigation page. Waits (bounded, 10 s) for an observed
   * snapshot of the target URL; on timeout appends a caution to the verified
   * result so the next reasoning step re-observes instead of clicking stale
   * refs. Fail-open: never wedges the loop, never spends recovery budget.
   *
   * PRD 6.10 §10/§17: browser_search settles the same way. The destination
   * URL is engine-dependent (chrome.search uses the default engine), so the
   * settle waits for ANY URL change from the pre-search page plus a fresh
   * snapshot pull — never for pre-search targets. The next action after a
   * browser search must use a fresh page observation.
   */
  private async settleAfterNavigation(
    task: TaskSnapshot,
    tabId: number,
    action: StructuredAction,
  ): Promise<void> {
    if (action.action === "browser_search") {
      await this.settleAfterBrowserSearch(task, tabId, action);
      return;
    }
    if (action.action !== "navigate") return;
    const params = action.parameters as { url?: unknown } | undefined;
    const targetUrl = typeof params?.url === "string" ? params.url : "";
    if (targetUrl === "" || this.deps.waitForSettledSnapshot === undefined) return;
    let settled = false;
    try {
      settled = await this.deps.waitForSettledSnapshot(tabId, targetUrl, 10_000);
    } catch {
      settled = false;
    }
    if (!settled) {
      task.lastVerifiedResult += " (new page snapshot not yet observed — re-observe before acting)";
      logger.warn("agent: post-navigation snapshot not observed; proceeding cautiously", {
        taskId: task.taskId,
        actionType: action.action,
      });
    }
  }

  /**
   * Fresh-observation settle for browser_search (PRD 6.10 §10):
   * 1. detect navigation/page-state change (live URL vs pre-search URL),
   * 2. wait for the page to become observable (bounded poll),
   * 3. pull a fresh ContextLens snapshot when a pull path exists,
   * 4. the next reasoning step reasons only from the fresh observation —
   *    enforced by the caution appended on timeout plus WebGuard's
   *    generation check (stale pre-search targets BLOCK).
   * Fail-open: never wedges the loop, never spends recovery budget.
   */
  private async settleAfterBrowserSearch(
    task: TaskSnapshot,
    tabId: number,
    action: StructuredAction,
  ): Promise<void> {
    const params = action.parameters as { query?: unknown } | undefined;
    const query = typeof params?.query === "string" ? params.query : "";
    // No live-URL path (unit tests / storage-only callers): pull fresh once
    // when possible, then proceed cautiously — never a 10 s blind wait.
    if (this.deps.getTabUrl === undefined) {
      if (this.deps.requestFreshSnapshot !== undefined) {
        try {
          await this.deps.requestFreshSnapshot(tabId);
        } catch {
          // Fail-soft: the next step's ensureCurrentSnapshot still re-pulls.
        }
      }
      task.lastVerifiedResult += " (fresh search-results observation required before selecting a result)";
      logger.info("agent: browser search settled", {
        taskId: task.taskId,
        query: query.slice(0, 120),
        landed: true,
      });
      return;
    }
    const preSearchUrl = await this.safeTabUrl(tabId);
    // Bounded wait for the search navigation to land: the live URL should
    // differ from the pre-search URL (or already look like results).
    const deadline = Date.now() + 10_000;
    let landed = false;
    for (;;) {
      const live = await this.safeTabUrl(tabId);
      if (
        live !== null &&
        live !== "" &&
        (preSearchUrl === null || live !== preSearchUrl || isSearchResultsUrl(live))
      ) {
        landed = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // Pull a fresh snapshot so storage does not serve the pre-search page.
    if (this.deps.requestFreshSnapshot !== undefined) {
      try {
        await this.deps.requestFreshSnapshot(tabId);
      } catch {
        // Fail-soft: the next step's ensureCurrentSnapshot still re-pulls.
      }
    }
    if (!landed) {
      task.lastVerifiedResult += " (search results snapshot not yet observed — re-observe before acting)";
    } else {
      task.lastVerifiedResult += " (fresh search-results observation required before selecting a result)";
    }
    logger.info("agent: browser search settled", {
      taskId: task.taskId,
      query: query.slice(0, 120),
      landed,
    });
  }

  /** Best-effort live tab URL; null when the lookup path is absent/fails. */
  private async safeTabUrl(tabId: number): Promise<string | null> {
    if (this.deps.getTabUrl === undefined) return null;
    try {
      return await this.deps.getTabUrl(tabId);
    } catch {
      return null;
    }
  }

  /**
   * Generic anti-hallucination grounding (no task hardcoding).
   * Normalizes URLs for observed-vs-proposed comparison: case-folded,
   * trailing-slash-insensitive, fragment-free. Query strings are preserved
   * (video/article ids live there).
   */
  private normalizeObservedUrl(url: string): string {
    const trimmed = url.trim();
    if (trimmed === "") return "";
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      let out = parsed.toString();
      if (out.endsWith("/") && parsed.pathname === "/") out = out.slice(0, -1);
      return out.toLowerCase();
    } catch {
      return trimmed.toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
    }
  }

  private rememberObservedUrls(taskId: string, urls: string[]): void {
    if (urls.length === 0) return;
    let set = this.observedUrls.get(taskId);
    if (set === undefined) {
      set = new Set<string>();
      this.observedUrls.set(taskId, set);
    }
    for (const url of urls) {
      const norm = this.normalizeObservedUrl(url);
      if (norm !== "") set.add(norm);
    }
  }

  private isUrlObserved(taskId: string, url: string): boolean {
    const norm = this.normalizeObservedUrl(url);
    if (norm === "") return false;
    return this.observedUrls.get(taskId)?.has(norm) === true;
  }

  private async doAction(
    action: StructuredAction,
    task: TaskSnapshot,
    snapshot: PageSnapshotLike,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
    opts: { sensitiveAuthorized: boolean; confirmed: boolean },
  ): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    // Generic anti-hallucination grounding for navigation (no task hardcoding):
    // a navigate/open_tab to a deep URL never observed via web_search results
    // or the current page is refused — the model must first think (search),
    // then use an observed link (e.g. extract the YouTube video link from
    // web_search results and navigate to it). Observed URLs and same-page
    // reloads always pass. Explicit homepage navigations (path "/" with the
    // host named in the goal, e.g. "open YouTube" → youtube.com/) also pass:
    // the destination comes from the user's own words, not invention. Deep
    // links (paths, video ids, article slugs) always need prior observation.
    // Trusted skill procedures (URL built from validated skill inputs) bypass
    // this check: the registry validated the inputs, not the model inventing.
    if ((action.action === "navigate" || action.action === "open_tab") && !this.activeSkills.has(task.taskId)) {
      const params = action.parameters as { url?: unknown } | undefined;
      const dest = typeof params?.url === "string" ? params.url : "";
      if (dest.trim() !== "" && !this.isUrlObserved(task.taskId, dest)) {
        const currentNorm = this.normalizeObservedUrl(snapshot.url);
        const destNorm = this.normalizeObservedUrl(dest);
        let allowedHomepage = false;
        try {
          const parsed = new URL(dest.trim());
          const path = parsed.pathname.replace(/\/+$/, "") || "/";
          const hostParts = parsed.hostname.toLowerCase().split(".").filter((p) => p !== "www" && p !== "");
          const goalLower = task.goal.toLowerCase();
          const hostNamed = hostParts.some((part) => part.length >= 3 && goalLower.includes(part));
          if ((path === "/" || path === "") && hostNamed) allowedHomepage = true;
        } catch {
          allowedHomepage = false;
        }
        // Same-page reloads are observed by definition; explicit homepages pass.
        if (destNorm !== currentNorm && !allowedHomepage) {
          task.recoveryAttempts += 1;
          task.lastVerifiedResult =
            `navigate refused: "${dest.slice(0, 120)}" was never observed — web_search first for the goal, then navigate only to a URL from those observed results. Never invent a URL.`;
          await store.save(task);
          logger.warn("agent: navigate refused (unobserved URL)", {
            taskId: task.taskId,
            actionType: action.action,
            url: dest.slice(0, 200),
          });
          await this.afterFailure(task, snapshot, tabId, store, speak);
          return;
        }
      }
    }
    const targets = this.targetsOf(snapshot);
    const guardTarget =
      action.target !== undefined ? (targets.get(action.target) ?? null) : null;
    const actionForGuard = this.reconcileGeneration(action, snapshot, targets);
    let verdict = (this.deps.guardEvaluate ?? evaluate)(actionForGuard, {
      currentGeneration: snapshot.generation,
      targets,
      provenance: "USER",
      sensitiveAuthorized: opts.sensitiveAuthorized,
      ...(this.deps.powerMode === true ? { powerMode: true as const } : {}),
    });
    if (verdict.decision === "REQUIRE_CONFIRMATION" && opts.confirmed) {
      // The user already approved this exact action: proceed on the remaining
      // checks (schema/target/sensitivity all passed to reach this point).
      this.rememberApproval(task.taskId, action);
      verdict = { decision: "ALLOW", reason: "confirmed by user" };
    }
    if (
      verdict.decision === "REQUIRE_CONFIRMATION" &&
      this.isApproved(task.taskId, action)
    ) {
      // Consent already given for THIS action in THIS task: never ask twice.
      logger.info("agent: reusing prior confirmation", {
        taskId: task.taskId,
        actionType: action.action,
        targetId: action.target,
      });
      verdict = { decision: "ALLOW", reason: "already confirmed by user for this task" };
    }
    if (verdict.decision === "BLOCK") {
      // Map guard reason to an honest speech code instead of generic ACTION_BLOCKED.
      const reasonLower = verdict.reason.toLowerCase();
      let blockCode: "ACTION_BLOCKED" | "ELEMENT_NOT_FOUND" | "STALE_TARGET" | "CANNOT_UNDERSTAND_PAGE" = "ACTION_BLOCKED";
      if (reasonLower.includes("not in current registry") || reasonLower.includes("element_not_found")) blockCode = "ELEMENT_NOT_FOUND";
      else if (reasonLower.includes("stale")) blockCode = "STALE_TARGET";
      else if (reasonLower.includes("schema:")) blockCode = "CANNOT_UNDERSTAND_PAGE";
      await speak(getErrorSpeech(blockCode, langOf(task)), task.goalLang, 3);
      this.recordEpisodeAction(task, snapshot, action, "blocked");
      // Persist the specific code so progress overlay / logs distinguish it.
      await this.finish(task, "BLOCKED", blockCode === "ACTION_BLOCKED" ? null : blockCode, tabId, store);
      return;
    }
    if (verdict.decision === "REQUIRE_CONFIRMATION") {
      const generatedReason = `The agent wants to perform: ${action.action}${
        action.target !== undefined ? ` on ${action.target}` : ""
      }.`;
      const speech = buildConfirmationSpeech(action, guardTarget, generatedReason, task.goalLang);
      task.status = "WAITING_FOR_CONFIRMATION";
      task.pendingConfirmation = {
        summary: speech,
        actionIndex: task.completedActions,
        askedAt: this.now(),
        action,
      };
      this.reasks.set(task.taskId, 0);
      await store.save(task);
      this.recordEpisodeAction(task, snapshot, action, "awaiting_confirmation");
      this.emitProgress({
        taskId: task.taskId,
        kind: "waiting-confirm",
        prompt: speech,
      });
      await speak(speech, task.goalLang, 1);
      return;
    }

    const verifyFn = this.deps.verifyFn ?? realVerify;
    await this.deps.setAgentActive?.(tabId, true);
    let execResult;
    try {
      // Grounding for external executors: the eNN target is tab-local, so
      // the live snapshot's role+name travels alongside for AX-tree lookup,
      // plus the page URL so the host attaches to the SAME tab (it drives
      // the shared Chrome instance with its own tab handles).
      execResult = await this.runRoutedExecution(action, task, tabId, snapshot.generation, {
        ...(guardTarget !== null && guardTarget.name !== ""
          ? { node: { role: guardTarget.role, name: guardTarget.name } }
          : {}),
        url: snapshot.url,
      });
    } finally {
      await this.deps.setAgentActive?.(tabId, false);
    }
    if (execResult.status !== "executed") {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = `action ${action.action} failed at execution`;
      this.recordEpisodeAction(task, snapshot, action, "failed");
      await store.save(task);
      await this.afterFailure(task, snapshot, tabId, store, speak);
      return;
    }

    const target = action.target !== undefined
      ? snapshot.items.find((i) => i.id === action.target) ?? null
      : null;
    // A side-effecting (submit-style) control gets the multi-signal
    // expectation by DEFAULT: waiting for one specific element to appear is
    // what used to time out on real forms and trigger a second Submit click.
    // An explicit expectation from the model is still honoured as-is.
    const sideEffecting = isSideEffectingAction(action, target);
    const defaultExpect: Expectation = sideEffecting
      ? { type: "submit_completed", ...(target !== null ? { target: target.id } : {}) }
      : { type: "element_present" };
    const stateChanging = action.action === "type" || action.action === "select" || action.action === "press_key" || (action.action === "click" && target !== null && (target.role === "switch" || target.role === "checkbox" || target.role === "combobox"));
    // Phase 2: the model sometimes invents an expect.target (e.g. e5/e37 on a
    // two-element page) — format-valid, so the schema cannot catch it, but it
    // is not a registry-known id. Letting it through would verify the action
    // against a phantom. The submit_completed/element_present DEFAULT already
    // carries the completion signal, so drop the phantom and verify against
    // the default instead. WebGuard already ruled on the ACTION target above;
    // this changes verification input only, never authorization.
    let expectForVerify = action.expect ?? defaultExpect;
    if (typeof expectForVerify.target === "string" && !targets.has(expectForVerify.target)) {
      logger.info("agent: dropping unknown expect target; using default verification", {
        taskId: task.taskId,
        actionType: action.action,
        droppedExpectTarget: expectForVerify.target,
        defaultExpectType: defaultExpect.type,
      });
      expectForVerify = defaultExpect;
    }
    const verification = await verifyFn({
      tabId,
      expect: expectForVerify,
      identity: target !== null ? { role: target.role, name: target.name } : null,
      urlBefore: snapshot.url,
      actionGeneration: snapshot.generation,
      timeoutMs: action.timeout_ms ?? (sideEffecting || stateChanging ? 6000 : 3000),
    });

    if (verification.success) {
      task.completedActions += 1;
      task.currentStep += 1;
      task.recoveryAttempts = 0;
      // A successfully navigated destination becomes observed evidence.
      if (action.action === "navigate" || action.action === "open_tab") {
        const params = action.parameters as { url?: unknown } | undefined;
        if (typeof params?.url === "string" && params.url.trim() !== "") {
          this.rememberObservedUrls(task.taskId, [params.url]);
        }
      }
      if (action.action === "browser_search") {
        // PRD 6.10 §16/§18: search-mode tracking + verified search context.
        // The query is task data (never a secret); the next step must ground
        // result selection from the FRESH results observation (§12), and
        // search success requires the results state — an attempted navigation
        // alone is not proof (§18, settled + verified above).
        // Strategy + Result-Type Routing (additive): the goal-derived routing
        // directive travels in the verified observation so the next step
        // continues goal-appropriately (open/play/read/link) instead of
        // treating the found results as automatic completion.
        const params = action.parameters as { query?: unknown } | undefined;
        const query = typeof params?.query === "string" ? params.query : "";
        task.searchMode = "browser";
        const strategies = task.searchStrategies ?? selectSearchStrategies(task.goal, "browser");
        task.searchStrategies = strategies;
        const routing = routeGoalResult(task.goal);
        task.pendingResultRouting =
          routing.continuation === "search_complete"
            ? null
            : { continuation: routing.continuation, query, strategies };
        task.lastVerifiedResult =
          `browser search for "${query}" verified [strategy: ${strategies.join("+")}]. ${routing.directive}`;
      } else {
        task.lastVerifiedResult = `action ${action.action} verified`;
        // A verified follow-up consumes any owed search-result routing: the
        // agent acted on the fresh observation instead of stopping at a URL.
        task.pendingResultRouting = null;
      }
      await this.settleAfterNavigation(task, tabId, action);
      this.recordEpisodeAction(task, snapshot, action, "executed", {
        success: verification.success,
        outcome: verification.outcome,
        timedOut: verification.timedOut,
        pageGeneration: verification.pageGeneration,
      });
      await store.save(task);
      return; // loop continues
    }
    if (verification.outcome === "STALE_STATE") {
      // The page changed under the action — in practice this means the action
      // SUCCEEDED and navigated, and the model's expectation (written for the
      // pre-navigation page) simply no longer applies. Counting that against
      // the task's shared recovery budget was the real "works for two steps,
      // then everything is wrong" bug: every navigation spent one of only four
      // attempts, so any multi-step task died at the fourth navigation even
      // though every action had worked. Progress, not failure.
      if (action.action === "browser_search") {
        const params = action.parameters as { query?: unknown } | undefined;
        const query = typeof params?.query === "string" ? params.query : "";
        task.searchMode = "browser";
        const strategies = task.searchStrategies ?? selectSearchStrategies(task.goal, "browser");
        task.searchStrategies = strategies;
        const routing = routeGoalResult(task.goal);
        task.pendingResultRouting =
          routing.continuation === "search_complete"
            ? null
            : { continuation: routing.continuation, query, strategies };
        task.lastVerifiedResult =
          `browser search for "${query}" changed the page (navigation counted as progress) [strategy: ${strategies.join("+")}]. ${routing.directive}`;
      } else {
        task.lastVerifiedResult = "page changed during action (navigation counted as progress)";
        task.pendingResultRouting = null;
      }
      task.completedActions += 1;
      task.currentStep += 1;
      this.recordEpisodeAction(task, snapshot, action, "executed", {
        success: true,
        outcome: verification.outcome,
        timedOut: verification.timedOut,
        pageGeneration: verification.pageGeneration,
      });
      await this.settleAfterNavigation(task, tabId, action);
      await store.save(task);
      return; // loop continues; the next step re-observes the new page
    }
    // SAFETY: verification could not prove this non-idempotent side effect
    // happened. Retrying would risk submitting twice, so the task stops and
    // reports honestly instead of clicking Submit again. A human decides.
    if (sideEffecting) {
      task.recoveryAttempts += 1;
      task.lastVerifiedResult = `submitted ${action.action} but completion could not be confirmed`;
      this.recordEpisodeAction(task, snapshot, action, "failed", {
        success: false,
        outcome: verification.outcome,
        timedOut: verification.timedOut,
        pageGeneration: verification.pageGeneration,
      });
      await store.save(task);
      logger.warn("agent: submit could not be verified; not retrying a side effect", {
        taskId: task.taskId,
        actionType: action.action,
        targetId: action.target,
        verificationOutcome: verification.outcome,
        timedOut: verification.timedOut,
      });
      const hi = task.goalLang === "hi";
      await speak(
        hi
          ? "मैंने यह भेज दिया है, लेकिन पुष्टि नहीं हो सकी। कृपया जाँच लें।"
          : "I submitted it, but I could not confirm it went through. Please check.",
        task.goalLang,
        3,
      );
      await this.finish(task, "COMPLETE", null, tabId, store);
      return;
    }
    task.recoveryAttempts += 1;
    task.lastVerifiedResult = `action ${action.action} did not produce the expected result`;
    this.recordEpisodeAction(task, snapshot, action, "failed", {
      success: false,
      outcome: verification.outcome,
      timedOut: verification.timedOut,
      pageGeneration: verification.pageGeneration,
    });
    await store.save(task);
    await this.afterFailure(task, snapshot, tabId, store, speak);
  }

  /**
   * Ends the task after too many failures.
   *
   * NOTE: despite its name, MAX_RECOVERY_ATTEMPTS_PER_ACTION is a per-TASK
   * budget, not a per-action one — `recoveryAttempts` is cumulative and resets
   * only on a verified success. Post-navigation STALE_STATE no longer spends
   * it (that was the "fails after two steps" bug), but genuine failures still
   * accumulate across the whole task, which is the intended bound.
   */

  private async afterFailure(
    task: TaskSnapshot,
    _snapshot: PageSnapshotLike,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
    speak: (text: string, lang: "en" | "hi" | "mixed", priority: AudioPriority) => Promise<void>,
  ): Promise<void> {
    void _snapshot;
    if (task.recoveryAttempts > MAX_RECOVERY_ATTEMPTS_PER_ACTION) {
      await speak(getErrorSpeech("ACTION_FAILED", langOf(task)), task.goalLang, 3);
      await this.finish(task, "FAILED", null, tabId, store);
      return;
    }
    // Loop continues: next step re-observes the NEW state and re-reasons.
  }

  // -- Ask-user answers ---------------------------------------------------------------

  private async handleAnswer(
    task: TaskSnapshot,
    transcript: Transcript,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    const pending = task.pendingQuestion;
    const ttl = this.deps.ttlAnswerMs ?? 90_000;
    if (pending === null || this.now() - pending.askedAt > ttl) {
      task.pendingQuestion = null;
      task.status = "ACTIVE";
      await store.save(task);
      await this.run(task.taskId, tabId, store);
      return;
    }
    if (pending.sensitivity === "high") {
      // Memory-only slot-fill: Qwen never sees the value (PRD 6 §6).
      const secret = transcript.text.trim();
      this.secrets.set(`${task.taskId}:${pending.field}`, secret);
      task.pendingQuestion = null;
      task.status = "ACTIVE";
      await store.save(task);
      await this.typeSensitiveValue(task, pending.field, tabId, store);
      return;
    }
    // Phase 2: a generic "context" slot is not a real field — and an
    // action-echo reply ("submit", "do it") is a continuation attempt, not an
    // answer. Storing it as providedValues.context would pollute every future
    // intent ("User already provided: context: Submit") and loop re-reasoning.
    // Skip the store and simply continue the task instead.
    if (pending.field === "context" && isActionEchoUtterance(transcript.text)) {
      logger.info("agent: action-echo answer is not slot content; continuing task", {
        taskId: task.taskId,
      });
      task.pendingQuestion = null;
      task.status = "ACTIVE";
      await store.save(task);
      await this.run(task.taskId, tabId, store);
      return;
    }
    task.providedValues[pending.field] = transcript.text.trim();
    task.pendingQuestion = null;
    task.status = "ACTIVE";
    await store.save(task);
    // Deterministic slot-fill for ordinary values (twin of the sensitive
    // path): when the answered field maps to exactly one fillable element,
    // type immediately instead of spending a model round-trip that can
    // re-ask for what was just provided. Ambiguous or missing targets fall
    // through to reasoning unchanged.
    await this.typeProvidedValue(task, pending.field, tabId, store);
    if ((await store.load())?.taskId === task.taskId) {
      await this.run(task.taskId, tabId, store);
    }
  }

  /**
   * Types an ordinary provided value straight into its field when the field
   * maps to exactly one non-sensitive fillable element. Returns true when it
   * acted (the caller continues the loop); false leaves it to Qwen.
   * The value stays in providedValues as non-secret context.
   */
  private async typeProvidedValue(
    task: TaskSnapshot,
    field: string,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<boolean> {
    const value = task.providedValues[field];
    if (typeof value !== "string" || value === "") return false;
    const loadSnapshot = this.deps.loadSnapshot ?? (async () => null);
    const snapshot = await loadSnapshot(tabId);
    if (snapshot === null) {
      await this.finish(task, "FAILED", "CANNOT_ACCESS_PAGE", tabId, store);
      return true;
    }
    const needle = field.toLowerCase();
    const candidates = snapshot.items.filter((i) => {
      if (i.fieldKind === null || i.sensitive) return false;
      return fieldNameMatches(i.name, needle);
    });
    if (candidates.length !== 1) return false; // ambiguous or absent: Qwen decides
    const target = candidates[0] as (typeof candidates)[number];
    const action: StructuredAction = {
      action: "type",
      target: target.id,
      pageGeneration: snapshot.generation,
      value,
      expect: { type: "field_value_present", target: target.id },
      timeout_ms: 2000,
    };
    await this.doAction(action, task, snapshot, tabId, store, {
      sensitiveAuthorized: false,
      confirmed: false,
    });
    return true;
  }

  /** Types a secret straight to its field: deterministic action, no Qwen. */
  private async typeSensitiveValue(
    task: TaskSnapshot,
    field: string,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    const secretKey = `${task.taskId}:${field}`;
    const secret = this.secrets.get(secretKey);
    const loadSnapshot = this.deps.loadSnapshot ?? (async () => null);
    const snapshot = await loadSnapshot(tabId);
    const clear = (): void => {
      this.secrets.delete(secretKey);
    };
    if (secret === undefined || snapshot === null) {
      clear();
      await this.finish(task, "FAILED", "ACTION_FAILED", tabId, store);
      return;
    }
    // Resolve the field: prefer exact field-name match, else first sensitive field.
    const target =
      snapshot.items.find(
        (i) => i.fieldKind !== null && fieldNameMatches(i.name, field),
      ) ??
      snapshot.items.find((i) => i.sensitive && i.fieldKind !== null) ??
      null;
    if (target === null) {
      clear();
      await speak(getErrorSpeech("ELEMENT_NOT_FOUND", langOf(task)), task.goalLang, 3);
      await this.finish(task, "FAILED", null, tabId, store);
      return;
    }
    const action: StructuredAction = {
      action: "type",
      target: target.id,
      pageGeneration: snapshot.generation,
      value: secret,
      expect: { type: "field_value_present", target: target.id },
      timeout_ms: 2000,
    };
    clear(); // value leaves memory the moment the action object is built
    await this.doAction(action, task, snapshot, tabId, store, {
      sensitiveAuthorized: true,
      confirmed: false,
    });
    if ((await store.load())?.taskId === task.taskId) {
      await this.run(task.taskId, tabId, store);
    }
  }

  // -- Confirmations ---------------------------------------------------------------------

  private async handleConfirmation(
    task: TaskSnapshot,
    transcript: Transcript,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    const pending = task.pendingConfirmation;
    const ttl = this.deps.ttlConfirmMs ?? 90_000;
    if (pending === null || pending.action === null || this.now() - pending.askedAt > ttl) {
      task.pendingConfirmation = null;
      task.status = "ACTIVE";
      await store.save(task);
      await speak(getErrorSpeech("ACTION_FAILED", langOf(task)), task.goalLang, 3);
      await this.run(task.taskId, tabId, store);
      return;
    }
    const vote = matchConfirmation(transcript.text);
    // Phase 2 goal-echo: "submit" / "do it" / "yes, submit" restate the PENDING
    // action and count as approval — scoped strictly to this pending action
    // (isEchoApproval matches its verb or its target's name). The yes/no
    // grammar still decides everything else; this only rescues replies the
    // grammar votes "unclear" that unambiguously mean "do the pending thing".
    let echoApproved = false;
    if (vote !== "yes" && vote !== "no" && pending.action !== null) {
      const echoLoad = this.deps.loadSnapshot ?? (async () => null);
      const echoSnapshot = await echoLoad(tabId);
      const echoTarget =
        pending.action.target !== undefined
          ? (echoSnapshot?.items.find((i) => i.id === pending.action?.target) ?? null)
          : null;
      echoApproved = isEchoApproval(
        transcript.text,
        pending.action,
        echoTarget?.name ?? "",
      );
      if (echoApproved) {
        logger.info("agent: goal-echo reply approves pending action", {
          taskId: task.taskId,
          actionType: pending.action.action,
          targetId: pending.action.target,
        });
      }
    }
    if (vote === "yes" || echoApproved) {
      const action = pending.action;
      // Record consent BEFORE executing: if the click's verification is
      // inconclusive and the agent retries the same step, the retry must not
      // ask again. This is the fix for "I said yes and it asked again".
      this.rememberApproval(task.taskId, action);
      this.reasks.set(task.taskId, 0);
      task.pendingConfirmation = null;
      task.status = "ACTIVE";
      await store.save(task);
      const loadSnapshot = this.deps.loadSnapshot ?? (async () => null);
      const snapshot = await loadSnapshot(tabId);
      if (snapshot === null) {
        await this.finish(task, "FAILED", "CANNOT_ACCESS_PAGE", tabId, store);
        return;
      }
      await this.doAction(action, task, snapshot, tabId, store, {
        sensitiveAuthorized: false,
        confirmed: true,
      });
      await this.run(task.taskId, tabId, store);
      return;
    }
    if (vote === "no") {
      // Refusal is also remembered, so a re-proposal does not re-prompt.
      if (pending.action !== null) {
        this.approvals.get(task.taskId)?.delete(approvalSignature(pending.action));
      }
      task.pendingConfirmation = null;
      task.status = "ACTIVE";
      await store.save(task);
      await this.run(task.taskId, tabId, store);
      return;
    }
    const reasks = (this.reasks.get(task.taskId) ?? 0) + 1;
    this.reasks.set(task.taskId, reasks);
    if (reasks >= 2) {
      task.pendingConfirmation = null;
      task.status = "ACTIVE";
      await store.save(task);
      await this.run(task.taskId, tabId, store);
      return;
    }
    await speak(
      task.goalLang === "hi"
        ? "कृपया जारी रखने के लिए हाँ कहें, या रोकने के लिए ना कहें।"
        : "Please say yes to continue, or no to stop.",
      task.goalLang,
      1,
    );
  }

  // -- Cancellation / override / resume ----------------------------------------------------

  async cancelTask(
    taskId: string,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
    silent = false,
  ): Promise<void> {
    this.runCounter += 1; // halt any in-flight loop
    // Reject the in-flight reasoning fetch NOW (its catch site discards the
    // result silently via isStepStale). The runCounter bump above is what the
    // late-result guard observes, so the entry itself can go.
    this.taskAbort.get(taskId)?.abort();
    this.taskAbort.delete(taskId);
    for (const key of [...this.secrets.keys()]) {
      if (key.startsWith(`${taskId}:`)) this.secrets.delete(key);
    }
    this.readSessions.delete(tabId);
    this.taskTurns.delete(taskId);
    this.approvals.delete(taskId);
    this.activeSkills.delete(taskId);
    this.executionModes.delete(taskId);
    this.consecutiveAsk.delete(taskId);
    this.observedUrls.delete(taskId);
    this.recorder.discard(taskId); // superseded/cancelled: never recorded
    await this.deps.stopAudio?.(true);
    await this.deps.setAgentActive?.(tabId, false);
    const task = await store.load();
    if (task !== null && task.taskId === taskId && !isTerminal(task.status)) {
      task.status = "CANCELLED";
      task.pendingQuestion = null;
      task.pendingConfirmation = null;
      await store.save(task);
      this.emitProgress({ taskId, kind: "cancelled" });
    }
    if (!silent) {
      const speak = this.deps.speak ?? (async () => undefined);
      const lang: "en" | "hi" | "mixed" = task?.goalLang ?? "en";
      await speak(getErrorSpeech("TASK_CANCELLED", lang === "hi" ? "hi" : "en"), lang, 4);
    }
  }

  async pauseForOverride(tabId: number): Promise<void> {
    const store = { load: loadTask, save: saveTask, clear: clearTask };
    const task = await store.load();
    if (task === null || task.tabId !== tabId || isTerminal(task.status)) return;
    if (task.status === "WAITING_FOR_USER_ANSWER") return;
    if (task.status === "WAITING_FOR_CONFIRMATION") return;
    if (task.status === "PAUSED_USER_OVERRIDE") return;
    this.runCounter += 1;
    task.status = "PAUSED_USER_OVERRIDE";
    await store.save(task);
    const speak = this.deps.speak ?? (async () => undefined);
    await speak(
      task.goalLang === "hi"
        ? "रुक गया। आपने संभाल लिया है। जारी रखने के लिए resume कहें।"
        : "Paused. You took over. Say resume to continue.",
      task.goalLang,
      2,
    );
  }

  private async resumeTask(
    task: TaskSnapshot,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    task.status = "ACTIVE";
    await store.save(task);
    await this.run(task.taskId, tabId, store);
  }

  // -- Read-aloud flow ------------------------------------------------------------------------

  /** Returns true when the utterance was a read command (handled, no task). */
  private async handleReadCommand(
    text: string,
    transcript: Transcript,
    tabId: number,
  ): Promise<boolean> {
    const lowered = ` ${text.toLowerCase()} `;
    if (/stop reading|stop read|पढ़ना बंद|पढ़ना रोको/u.test(lowered)) {
      await this.endReadSession(tabId);
      return true;
    }
    if (includesWord(text, CONTINUE_WORDS)) {
      if (await this.continueReading(tabId)) return true;
      const speak = this.deps.speak ?? (async () => undefined);
      const lang = transcript.lang === "hi" ? "hi" : "en";
      await speak(
        lang === "hi" ? "जारी रखने के लिए कुछ नहीं है।" : "There is nothing to continue.",
        lang,
        4,
      );
      return true;
    }
    if (/\brepeat\b|दोहरा/u.test(lowered)) {
      await this.deps.repeatAudio?.();
      return true;
    }
    if (isDescribeThis(text)) {
      await this.describeCurrentElement(transcript, tabId);
      return true;
    }
    return false;
  }

  /** Answers "what is this?" from the cursor — no task, no model round-trip. */
  private async describeCurrentElement(transcript: Transcript, tabId: number): Promise<void> {
    const speak = this.deps.speak ?? (async () => undefined);
    const lang = transcript.lang === "hi" ? "hi" : "en";
    try {
      const focused = await this.deps.readFocusedElement?.(tabId);
      if (focused !== undefined && focused !== null && focused.text.trim() !== "") {
        await speak(focused.text, lang, 4);
        return;
      }
    } catch {
      // Fall through to the honest empty-focus message below.
    }
    await speak(
      lang === "hi"
        ? "अभी कुछ भी फ़ोकस में नहीं है। किसी एलिमेंट पर टैब करें या माउस ले जाएँ, फिर दोबारा पूछें।"
        : "Nothing is in focus right now. Tab to an element or point at it, then ask again.",
      lang,
      3,
    );
  }

  async continueReading(tabId: number): Promise<boolean> {
    const session = this.readSessions.get(tabId);
    if (session === undefined) return false;
    return this.speakReadChunk(tabId, session);
  }

  private async doRead(
    action: StructuredAction,
    task: TaskSnapshot,
    _snapshot: PageSnapshotLike,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    void _snapshot;
    const speak = this.deps.speak ?? (async () => undefined);
    const text = await this.readAloud(action, task, tabId, store);
    this.recordEpisodeAction(task, _snapshot, action, "read");
    if (text === null) {
      await this.finish(task, "FAILED", "ACTION_FAILED", tabId, store);
      return;
    }
    if (text.trim() === "") {
      await speak(getErrorSpeech("ELEMENT_NOT_FOUND", langOf(task)), task.goalLang, 3);
      await store.save(task);
      return; // loop continues; Qwen picks the next step
    }
  }

  /**
   * Reads a region aloud and returns its raw text.
   *
   * Returns `null` when the read could not be performed at all (no reader, or a
   * transport failure) and `""` when the region read back empty. Shared by the
   * model-driven read path (doRead) and the skill path so both speak, count, and
   * manage the read session identically.
   */
  private async readAloud(
    action: StructuredAction,
    task: TaskSnapshot,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<string | null> {
    const readRegion = this.deps.readRegionText;
    if (readRegion === undefined) return null;
    const params = (action.parameters ?? {}) as Record<string, unknown>;
    const requested = params["max_chars"];
    const maxChars =
      typeof requested === "number"
        ? Math.min(Math.max(Math.floor(requested), 100), 20000)
        : 4000;
    let text: string;
    try {
      text = await readRegion(tabId, action.target, maxChars);
    } catch {
      return null;
    }
    if (text.trim() === "") return "";
    const chunks = chunkText(text);
    const lang: "en" | "hi" = task.goalLang === "hi" ? "hi" : "en";
    const session = { chunks, index: 0, lang };
    this.readSessions.set(tabId, session);
    task.completedActions += 1;
    task.currentStep += 1;
    await store.save(task);
    await this.speakReadChunk(tabId, session);
    return text;
  }

  private async speakReadChunk(
    tabId: number,
    session: { chunks: string[]; index: number; lang: "en" | "hi" },
  ): Promise<boolean> {
    const speak = this.deps.speak ?? (async () => undefined);
    const chunk = session.chunks[session.index];
    if (chunk === undefined) {
      this.readSessions.delete(tabId);
      return false;
    }
    session.index += 1;
    await speak(chunk, session.lang, 4);
    return true;
  }

  private async endReadSession(tabId: number): Promise<void> {
    this.readSessions.delete(tabId);
    await this.deps.stopAudio?.(false);
  }

  /**
   * Ends a task after a failed reasoning call. The previous code caught the
   * error bare, so a rate limit, an auth rejection, a timeout and a genuine
   * outage all produced the same "AI service is unavailable" line and left
   * nothing in the log to debug with. The cause is now classified, spoken
   * honestly, and recorded.
   */
  private async failReasoning(
    task: TaskSnapshot,
    tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
    err: unknown,
  ): Promise<void> {
    const kind = err instanceof QwenError ? err.kind : "unknown";
    const status = err instanceof QwenError ? err.status : undefined;
    const msgLower = err instanceof Error ? err.message.toLowerCase() : "";
    let code: "RATE_LIMITED" | "AI_SERVICE_UNAVAILABLE" | "CANNOT_UNDERSTAND_PAGE" | "CANNOT_ACCESS_PAGE" = "AI_SERVICE_UNAVAILABLE";
    if (kind === "rate_limit") code = "RATE_LIMITED";
    else if (kind === "output" || msgLower.includes("output contract") || msgLower.includes("invalid outcome") || msgLower.includes("schema")) code = "CANNOT_UNDERSTAND_PAGE";
    else if (kind === "transport" && (msgLower.includes("timeout") || msgLower.includes("network"))) code = "CANNOT_ACCESS_PAGE";
    // Log the CLASSIFIED code (what the user hears), never a hardcoded one:
    // a rate limit mislabeled AI_SERVICE_UNAVAILABLE sends debugging down
    // the wrong path (this exact confusion happened in production logs).
    logger.error("agent: reasoning call failed", {
      taskId: task.taskId,
      ...(this.taskTurns.get(task.taskId) !== undefined
        ? { turnId: this.taskTurns.get(task.taskId) as string }
        : {}),
      errorCode: code,
      kind,
      ...(status !== undefined ? { httpStatus: status } : {}),
      reason: err instanceof Error ? err.message : "unknown",
    });
    await this.finish(task, "FAILED", code, tabId, store);
  }

  // -- Finish ------------------------------------------------------------------------------------

  private async finish(
    task: TaskSnapshot,
    status: TaskStatus,
    speechCode: "TASK_LIMIT_REACHED" | "ACTION_FAILED" | "CANNOT_ACCESS_PAGE" | "CANNOT_UNDERSTAND_PAGE" | "ELEMENT_NOT_FOUND" | "STALE_TARGET" | "VERIFICATION_FAILED" | "UNSUPPORTED_PAGE" | "AI_SERVICE_UNAVAILABLE" | "RATE_LIMITED" | null,
    _tabId: number,
    store: NonNullable<ControllerDeps["store"]>,
  ): Promise<void> {
    void _tabId;
    task.status = status;
    task.pendingQuestion = null;
    task.pendingConfirmation = null;
    for (const key of [...this.secrets.keys()]) {
      if (key.startsWith(`${task.taskId}:`)) this.secrets.delete(key);
    }
    this.enrichSuppressed.delete(task.taskId);
    this.approvals.delete(task.taskId);
    this.activeSkills.delete(task.taskId);
    this.executionModes.delete(task.taskId);
    this.consecutiveAsk.delete(task.taskId);
    this.observedUrls.delete(task.taskId);
    this.taskAbort.delete(task.taskId);
    this.emitProgress({
      taskId: task.taskId,
      kind: "done",
      status,
      ...(speechCode !== null
        ? { prompt: getErrorSpeech(speechCode, langOf(task)), speechCode }
        : {}),
    });
    this.taskTurns.delete(task.taskId);
    await store.save(task);
    await this.recorder.finalize(task); // no-op unless recording was opted into
    if (speechCode !== null) {
      const speak = this.deps.speak ?? (async () => undefined);
      await speak(getErrorSpeech(speechCode, langOf(task)), task.goalLang, 3);
    }
  }
}

function langOf(task: TaskSnapshot): "en" | "hi" {
  return task.goalLang === "hi" ? "hi" : "en";
}

/**
 * Builds the spoken (and stored) confirmation request. When a sensitive field
 * is involved, the model-supplied reason is NEVER used — it may echo secret
 * values into speech, logs, or persisted TaskState. A fixed template naming
 * only the operation is spoken instead. Ordinary cases keep the model reason
 * (naming data classes is required context, PRD 5 §15).
 */
export function buildConfirmationSpeech(
  action: StructuredAction,
  target: TargetInfo | null,
  modelReason: string,
  lang: "en" | "hi" | "mixed",
): string {
  const hi = lang === "hi";
  if (target !== null && target.sensitive) {
    return hi
      ? "इस कार्रवाई के लिए आपकी अनुमति चाहिए। संवेदनशील फ़ील्ड में मान भरा जाएगा। जारी रखने के लिए हाँ कहें, या रोकने के लिए ना कहें।"
      : "This action needs your approval. It will enter a value into a sensitive field. Say yes to continue, or no to stop.";
  }
  const what =
    target !== null ? `${action.action} on "${target.name}"` : `${action.action}`;
  return hi
    ? `इस कार्रवाई के लिए आपकी अनुमति चाहिए। ${what}। ${modelReason} जारी रखने के लिए हाँ कहें, या रोकने के लिए ना कहें।`
    : `This action needs your approval. ${what}. ${modelReason} Say yes to continue, or no to stop.`;
}
