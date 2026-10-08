/**
 * Search Strategy + Result-Type Routing — ADDITIVE layer (search architecture
 * improvement; PRD 6.10 behavior preserved).
 *
 * INVIZ treated every search hit as a generic URL. A hit may instead be a
 * video, website, article, image, news item, document, audio, or product, and
 * the SAME hit demands a DIFFERENT next action depending on the user's goal.
 * "Found a URL" is NOT "completed the task."
 *
 * Conceptual pipeline (each stage is pure and unit-tested here; the
 * controller wires them into the existing trusted path without changing
 * WebGuard, approval/consent, executor, verification, skills, or budgets):
 *
 *   USER REQUEST → SEARCH INTENT → SEARCH STRATEGY → SEARCH EXECUTION
 *     → FRESH RESULT OBSERVATION → RESULT-TYPE CLASSIFICATION
 *     → GOAL-SPECIFIC RESULT HANDLER → EXECUTION → VERIFICATION
 *     → TASK COMPLETE / CONTINUE
 *
 * All helpers are pure, deterministic, and chrome-free. The model never
 * decides these mappings; they steer the verified observation text the model
 * reasons from. No new action type: every continuation uses the existing
 * outcome/action contract (open/click grounded result → fresh observation →
 * play/read/answer → verification).
 */
import type { SearchIntent } from "./controller.js";

// ---------------------------------------------------------------------------
// 1. Search strategies (§2)
// ---------------------------------------------------------------------------

/**
 * Semantic search strategies. Generic by design: "video" covers arbitrary
 * video/media sites, never just one hardcoded provider. A named site (e.g.
 * YouTube) MAY map to `video` today, but only as evidence alongside
 * intent verbs — the architecture supports any media site.
 */
export type SearchStrategy =
  | "general_web"
  | "video"
  | "image"
  | "news"
  | "document"
  | "site_specific"
  | "research";

export const SEARCH_STRATEGIES: readonly SearchStrategy[] = [
  "general_web",
  "video",
  "image",
  "news",
  "document",
  "site_specific",
  "research",
] as const;

/** Media-intent verbs/nouns in the user's goal (any media site, not one). */
const MEDIA_GOAL_RE =
  /\b(video|videos|watch|watching|play|playing|song|songs|music|movie|movies|film|trailer|episode|clip|livestream|stream|podcast|listen|tune)\b/i;

/** Named media sites are EVIDENCE for the video strategy, never its basis. */
const MEDIA_SITE_RE =
  /\b(youtube|youtu|vimeo|dailymotion|twitch|tiktok|netflix|prime\s*video|hotstar|spotify|soundcloud)\b/i;

/** Image-intent nouns. */
const IMAGE_GOAL_RE =
  /\b(image|images|picture|pictures|photo|photos|photograph|wallpaper|pic|pics|thumbnail|gallery)\b/i;

/** News-intent nouns. */
const NEWS_GOAL_RE =
  /\b(news|headlines|breaking|latest\s+news|today'?s\s+news|current\s+events)\b/i;

/** Document-intent nouns. */
const DOCUMENT_GOAL_RE =
  /\b(pdf|document|documents|manual|contract|paper|papers|ebook|e-book|whitepaper|terms|report\s+pdf|download\s+the)\b/i;

/** Website/navigation-intent nouns (route to website-result handling). */
const WEBSITE_GOAL_RE =
  /\b(website|web\s*site|homepage|home\s*page|official\s+site|official\s+page|portal)\b/i;

/**
 * Selects search strategies from user intent + goal context (§2). Returns an
 * ordered list, primary first; `site_specific` pairs with a content strategy
 * (e.g. ["site_specific", "video"] for "Search YouTube for Baby"). Never
 * collapses the PRD 6.10 modes: browser/page/research intents keep their
 * distinct execution paths — strategies only describe WHAT to look for.
 * Exported for unit tests.
 */
export function selectSearchStrategies(
  goal: string,
  intent: SearchIntent,
): SearchStrategy[] {
  const text = goal.trim();
  if (text === "" || intent === "navigation") return [];
  const strategies: SearchStrategy[] = [];
  // Site-specific execution comes from the PAGE intent (current page's own
  // search UI), independent of WHAT is sought.
  if (intent === "page") strategies.push("site_specific");
  // Content strategies from goal wording (checked before intent defaults so
  // "Find images of the Eiffel Tower" is image even with intent "none").
  if (MEDIA_GOAL_RE.test(text) || MEDIA_SITE_RE.test(text)) strategies.push("video");
  else if (IMAGE_GOAL_RE.test(text)) strategies.push("image");
  else if (NEWS_GOAL_RE.test(text)) strategies.push("news");
  else if (DOCUMENT_GOAL_RE.test(text)) strategies.push("document");
  if (intent === "web_research" || intent === "none") {
    // Genuine research questions need external facts; anything else defaults
    // to general web handling (e.g. "Find the official Tesla website").
    if (intent === "web_research" && !WEBSITE_GOAL_RE.test(text)) {
      if (!strategies.includes("research")) strategies.push("research");
    } else if (strategies.length === 0 || (strategies.length === 1 && strategies[0] === "site_specific")) {
      strategies.push(intent === "web_research" ? "research" : "general_web");
    }
  } else if (intent === "browser") {
    // "Search for Tesla" with no content signals is a plain web search.
    if (strategies.length === 0) strategies.push("general_web");
  }
  // Dedupe while preserving order; at most primary + secondary.
  const seen = new Set<SearchStrategy>();
  const ordered = strategies.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  if (ordered.length === 0) ordered.push("general_web");
  return ordered.slice(0, 2);
}

// ---------------------------------------------------------------------------
// 2. Result-type classification (§3)
// ---------------------------------------------------------------------------

/** Semantic result types. */
export type SearchResultType =
  | "VIDEO"
  | "WEBSITE"
  | "ARTICLE"
  | "IMAGE"
  | "NEWS"
  | "DOCUMENT"
  | "AUDIO"
  | "PRODUCT"
  | "OTHER";

export const SEARCH_RESULT_TYPES: readonly SearchResultType[] = [
  "VIDEO",
  "WEBSITE",
  "ARTICLE",
  "IMAGE",
  "NEWS",
  "DOCUMENT",
  "AUDIO",
  "PRODUCT",
  "OTHER",
] as const;

/**
 * Observable evidence for ONE result. Every field is optional; the classifier
 * reads ONLY what is supplied and never invents metadata. Sources: result
 * title, visible labels/badges, surrounding text (snippet/context), domain,
 * URL, media indicators (duration, views), thumbnail/preview presence,
 * semantic role, and page structure hints.
 */
export interface ResultEvidence {
  title?: string;
  /** Visible labels/badges near the result ("Video", "News", "Ad", …). */
  labels?: string;
  /** Snippet / surrounding text / description. */
  surroundingText?: string;
  /** Bare domain ("youtube.com"), when known. */
  domain?: string;
  url?: string;
  /** Semantic/ARIA role ("video", "img", "article", "link", …), when known. */
  role?: string;
  /** Duration string ("12:34") or true when a duration badge was observed. */
  duration?: string | boolean;
  /** True when a thumbnail/preview image was observed on the result. */
  hasThumbnail?: boolean;
}

const MEDIA_DOMAINS = [
  "youtube",
  "youtu",
  "vimeo",
  "dailymotion",
  "twitch",
  "tiktok",
  "netflix",
  "hotstar",
] as const;

const AUDIO_DOMAINS = ["spotify", "soundcloud", "music.apple", "podcasts"] as const;

const VIDEO_WORDS =
  /\b(video|videos|watch|trailer|episode|season|clip|livestream|live\s*stream|views|subscribers|channel|vevo|music\s*video|official\s*video|shorts)\b/i;
const AUDIO_WORDS =
  /\b(audio|podcast|song|track|album|listen|mp3|playlist|artist|single|remix)\b/i;
const IMAGE_WORDS =
  /\b(image|images|photo|photos|picture|pictures|wallpaper|gallery|thumbnail|jpg|jpeg|png|webp|gif)\b/i;
const NEWS_WORDS =
  /\b(news|breaking|headline|headlines|reporter|correspondent|live\s*updates|coverage)\b/i;
const DOCUMENT_WORDS =
  /\b(pdf|document|manual|whitepaper|ebook|e-book|download|contract|guidelines)\b/i;
const PRODUCT_WORDS =
  /\b(price|buy|add\s*to\s*cart|shop|deal|discount|sale|product|order\s*now|in\s*stock|rs\.?\s*\d|\$\s*\d|₹\s*\d|£\s*\d|€\s*\d)\b/i;
const ARTICLE_WORDS =
  /\b(article|blog|guide|how\s*to|tutorial|explained|story|stories|opinion|essay|read\s*more)\b/i;
const DURATION_RE = /\b\d{1,3}:\d{2}(?::\d{2})?\b/;
const RECENCY_RE = /\b(\d+\s*(minutes?|hours?|days?)\s*ago|today|yesterday)\b/i;
const DOC_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?|txt|epub)(\?|#|$)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|svg|bmp)(\?|#|$)/i;

/** Extracts the bare domain from a URL; "" when unparseable (never throws). */
export function domainOf(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Classifies ONE result from multi-signal evidence (§3). Weighted scoring —
 * NO single signal decides alone, and a video-site domain is only one piece
 * of evidence among title, labels, surrounding text, media indicators,
 * thumbnail, and semantic role. In particular there is no
 * `if youtube.com then VIDEO` shortcut: a bare YouTube URL with no
 * video-indicating evidence scores as a video-site WEBSITE, not a VIDEO.
 * Ties resolve by fixed precedence (VIDEO first — media intent is the costlier
 * miss). Falls back to WEBSITE when link evidence (url/domain) exists, else
 * OTHER. Never invents metadata: unscored evidence contributes nothing.
 * Exported for unit tests.
 */
export function classifyResultType(evidence: ResultEvidence): SearchResultType {
  const text = [evidence.title, evidence.labels, evidence.surroundingText]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
  const domain = (evidence.domain ?? "").toLowerCase();
  const url = (evidence.url ?? "").toLowerCase();
  const role = (evidence.role ?? "").toLowerCase();
  const domainOrUrl = `${domain} ${url}`;
  const hasDuration =
    evidence.duration === true ||
    (typeof evidence.duration === "string" && DURATION_RE.test(evidence.duration)) ||
    DURATION_RE.test(text);

  let video = 0;
  let audio = 0;
  let image = 0;
  let news = 0;
  let document = 0;
  let product = 0;
  let article = 0;
  let website = 0;

  // Media indicators: duration badge, view counts, roles — strongest signals.
  if (hasDuration) video += 3;
  if (role === "video" || role === "media") video += 3;
  if (role === "audio") audio += 3;
  if (role === "img" || role === "image") image += 3;
  if (role === "article") article += 3;
  if (VIDEO_WORDS.test(text)) video += 2;
  if (AUDIO_WORDS.test(text)) audio += 2;
  if (IMAGE_WORDS.test(text)) image += 2;
  if (NEWS_WORDS.test(text)) news += 2;
  if (DOCUMENT_WORDS.test(text)) document += 2;
  if (PRODUCT_WORDS.test(text)) product += 2;
  if (ARTICLE_WORDS.test(text)) article += 2;
  if (evidence.labels !== undefined && /\bvideo\b/i.test(evidence.labels)) video += 2;
  if (evidence.labels !== undefined && /\bnews\b/i.test(evidence.labels)) news += 2;

  // URL/path signals (evidence, never verdicts on their own).
  if (/\/(watch|shorts|embed|reel|videos?\/|playlist)\b/.test(url)) video += 2;
  if (DOC_EXT_RE.test(url)) document += 3;
  if (IMAGE_EXT_RE.test(url)) image += 3;
  if (/(^|\/)news(\/|$|\?)/.test(url)) news += 2;
  if (evidence.hasThumbnail === true && (VIDEO_WORDS.test(text) || hasDuration)) video += 1;
  if (evidence.hasThumbnail === true && IMAGE_WORDS.test(text)) image += 1;

  // Domain evidence: a media-site domain supports — but never alone proves —
  // a media type. Requires at least one content signal to reach VIDEO/AUDIO.
  const mediaDomain = MEDIA_DOMAINS.some((d) => domain.includes(d));
  const audioDomain = AUDIO_DOMAINS.some((d) => domain.includes(d));
  if (mediaDomain) video += 1;
  if (audioDomain) audio += 1;

  // Recency + news context reads as NEWS; recency alone does not.
  if (RECENCY_RE.test(text) && (NEWS_WORDS.test(text) || news >= 2)) news += 1;

  // Homepage/website signals.
  if (/\b(official\s*(site|website|page)|homepage|home\s*page)\b/i.test(text)) website += 2;
  if (url !== "" && /^(https?:\/\/[^/]+\/?)$/.test(url.trim())) website += 1;

  const ranked: Array<[SearchResultType, number]> = [
    ["VIDEO", video],
    ["AUDIO", audio],
    ["IMAGE", image],
    ["NEWS", news],
    ["DOCUMENT", document],
    ["PRODUCT", product],
    ["ARTICLE", article],
    ["WEBSITE", website],
  ];
  let best: SearchResultType = "OTHER";
  let bestScore = 0;
  for (const [type, score] of ranked) {
    // Strictly greater wins, so ties keep the earlier (higher-precedence)
    // media type. A bare media domain (+1) can never win on its own.
    if (score > bestScore && score >= 2) {
      best = type;
      bestScore = score;
    }
  }
  if (best === "OTHER" && (url !== "" || domain !== "")) return "WEBSITE";
  return best;
}

// ---------------------------------------------------------------------------
// 3. Goal + result-type → continuation (§4–§9)
// ---------------------------------------------------------------------------

/** Machine-readable next step for a search result. */
export type ResultContinuation =
  | "search_complete"
  | "open_first_result"
  | "open_matching_result"
  | "open_and_play"
  | "return_link"
  | "read_and_answer";

export interface ResultRouting {
  continuation: ResultContinuation;
  /** Model-facing directive appended to the verified search observation. */
  directive: string;
}

const CONTINUATION_VERBS_RE =
  /\b(open|play|watch|listen|click|visit|launch|show|select|link|url|first|website|homepage|official|read|navigate|go\s+to)\b/i;
const PLAYBACK_RE = /\b(play|watch|listen|pause|resume)\b/i;
const LINK_RE = /\b(link|url|address|share\s+(the\s+)?link)\b/i;
const FIRST_RESULT_RE = /\b(first|1st|top)\s+(result|video|link|article|item|one)\b/i;
const OPEN_RE =
  /\b(open|click|visit|launch|navigate|go\s+to|show\s+me|take\s+me|website|homepage|official)\b/i;
const SEARCH_VERB_RE = /^(?:please\s+)?(?:search(?:\s+for)?|google|look\s*up)\b/i;

/**
 * True for a search-and-stop goal: a bare browser search with no continuation
 * verbs ("Search for Tesla."). Only then may reaching the search-results
 * state complete the task (§5). Anything asking to open/play/read/link along
 * the way needs a follow-up — the result is intermediate evidence.
 * Exported for unit tests.
 */
export function isSearchOnlyGoal(goal: string): boolean {
  const text = goal.trim();
  if (text === "" || !SEARCH_VERB_RE.test(text)) return false;
  return !CONTINUATION_VERBS_RE.test(text);
}

/**
 * Determines the next operation from BOTH the user goal and the (observed or
 * anticipated) result type (§4). Precedence: playback > link > explicit first
 * > open/website > news-read > search-only > default read/answer. The
 * directive is speakable-model guidance, never an action itself: every
 * continuation still flows through WebGuard → executor → verification, URLs
 * are only ever grounded observations, and playback is only real when
 * verified. Exported for unit tests.
 */
export function routeGoalResult(
  goal: string,
  resultType?: SearchResultType,
): ResultRouting {
  const text = goal.trim();
  // "Find the link to the Baby video": return the observed URL via the
  // existing answer contract — never open/play it unnecessarily.
  if (LINK_RE.test(text)) {
    return {
      continuation: "return_link",
      directive:
        "Link goal: return the observed result URL via the answer contract. Do not open or play it.",
    };
  }
  // "Find Baby and play it" (+ VIDEO/AUDIO): open → fresh media observation
  // → play → verify actual playback. A URL is locating evidence, NOT the
  // result; clicking/opening never equals playback started.
  if (PLAYBACK_RE.test(text)) {
    return {
      continuation: "open_and_play",
      directive:
        "Media goal: open/select the matching VIDEO from the fresh observation, re-observe the media page, start playback, and verify actual playback state. Opening the URL is not playback — verification decides.",
    };
  }
  // "Open the first result": first in verified page order.
  if (FIRST_RESULT_RE.test(text)) {
    return {
      continuation: "open_first_result",
      directive:
        "Open the FIRST grounded result in verified page order from the fresh observation (never a pre-search target, never an invented URL), then verify the destination.",
    };
  }
  // "Find the Tesla website" (+ WEBSITE): open verified result → fresh
  // destination observation → verify destination. Never invent URLs.
  if (OPEN_RE.test(text)) {
    return {
      continuation: "open_matching_result",
      directive:
        "Open the observed result whose title/domain/context best matches the goal (never invent a URL), then verify the destination from a fresh observation.",
    };
  }
  // News goals ("Find today's news about Tesla"): open/read/answer per goal —
  // a news URL alone never completes the request.
  if (resultType === "NEWS" || NEWS_GOAL_RE.test(text)) {
    return {
      continuation: "read_and_answer",
      directive:
        "News goal: open/read the matching NEWS result as the goal requires and answer from verified observations. A result URL alone is not completion.",
    };
  }
  // Bare search ("Search for Tesla"): the fresh search-results state may
  // complete the task. Anything else continues below.
  if (isSearchOnlyGoal(text)) {
    return {
      continuation: "search_complete",
      directive:
        "Search-only goal: the fresh search-results observation completes the task. Do not navigate or invent URLs.",
    };
  }
  // Image goals ("Find images of the Eiffel Tower"): perform the requested
  // image operation — never auto-navigate to a generic webpage.
  if (resultType === "IMAGE" || IMAGE_GOAL_RE.test(text)) {
    return {
      continuation: "read_and_answer",
      directive:
        "Image goal: perform the requested image operation from the fresh observation. Do not auto-navigate to a generic webpage.",
    };
  }
  // Default: ground the next step in the fresh observation (open the matching
  // result or answer from verified observations). The search result itself is
  // intermediate — never declare success on a discovered URL alone.
  return {
    continuation: "read_and_answer",
    directive:
      "Ground the next step in the fresh search observation: open the matching result or answer from verified observations. A discovered URL alone is not task completion.",
  };
}
