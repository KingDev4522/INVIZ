/**
 * Restricted-surface policy (PRD 6.1 §1.5; PRD 5 §73).
 * Content scripts cannot run on these surfaces; the worker marks such tabs
 * honestly (badge + popup + spoken notice) instead of pretending to work.
 * Pure function — unit-tested.
 */

const NON_INJECTABLE_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "view-source:",
  "chrome-search:",
  "file:",
];

const WEBSTORE_HOST = "chromewebstore.google.com";

export interface PageSupport {
  supported: boolean;
  reason: string;
}

export function supportOf(url: string | undefined): PageSupport {
  if (url === undefined || url === "") {
    return { supported: false, reason: "unknown-url" };
  }
  const lowered = url.toLowerCase();
  for (const scheme of NON_INJECTABLE_SCHEMES) {
    if (lowered.startsWith(scheme)) {
      return { supported: false, reason: `restricted-scheme:${scheme}` };
    }
  }
  try {
    if (new URL(url).hostname.toLowerCase() === WEBSTORE_HOST) {
      return { supported: false, reason: "restricted-host:webstore" };
    }
  } catch {
    return { supported: false, reason: "unparseable-url" };
  }
  return { supported: true, reason: "injectable" };
}
