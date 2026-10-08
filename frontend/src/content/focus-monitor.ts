/**
 * Focus monitor + semantic announcement builder (PRD 6.1 §1.3; PRD 2 §3–4).
 * Produces announcement OBJECTS (name/role/states/hint/lang); delivery to
 * audio is Phase 2's Audio Controller. Identical consecutive announcements
 * are deduplicated here so the queue never fills with repeats.
 */

export type AnnounceLang = "en" | "hi";
export type Verbosity = "terse" | "standard";

export interface Announcement {
  elementId: string | null;
  name: string;
  role: string;
  stateBits: string[];
  hint: string;
  lang: AnnounceLang;
  /** Spoken form, assembled from the parts above. */
  text: string;
  signature: string;
}

const ROLE_LABELS: Record<string, { en: string; hi: string }> = {
  button: { en: "Button", hi: "बटन" },
  link: { en: "Link", hi: "लिंक" },
  textbox: { en: "Edit box", hi: "एडिट बॉक्स" },
  searchbox: { en: "Search box", hi: "खोज बॉक्स" },
  combobox: { en: "Combo box", hi: "कॉम्बो बॉक्स" },
  checkbox: { en: "Checkbox", hi: "चेकबॉक्स" },
  radio: { en: "Radio button", hi: "रेडियो बटन" },
  select: { en: "Drop-down", hi: "ड्रॉप-डाउन" },
  textarea: { en: "Text area", hi: "टेक्स्ट क्षेत्र" },
  heading: { en: "Heading", hi: "शीर्षक" },
  dialog: { en: "Dialog", hi: "संवाद" },
  menuitem: { en: "Menu item", hi: "मेनू आइटम" },
  tab: { en: "Tab", hi: "टैब" },
  slider: { en: "Slider", hi: "स्लाइडर" },
  switch: { en: "Switch", hi: "स्विच" },
  img: { en: "Image", hi: "चित्र" },
  list: { en: "List", hi: "सूची" },
  navigation: { en: "Navigation", hi: "नेविगेशन" },
  main: { en: "Main content", hi: "मुख्य सामग्री" },
  form: { en: "Form", hi: "फ़ॉर्म" },
  // Hover-only role for readable text blocks (paragraphs, cards). The
  // keyboard path never produces it (generic is excluded before announcement),
  // so adding it cannot change focus narration.
  text: { en: "Text", hi: "पाठ" },
};

const HINTS: Record<string, { en: (name: string) => string; hi: (name: string) => string }> = {
  searchbox: {
    en: () => "Type your search query.",
    hi: () => "अपनी खोज लिखें।",
  },
  "button:submit": {
    en: (name) => `Activates ${name}.`,
    hi: (name) => `${name} सक्रिय करता है।`,
  },
};

export function roleLabel(role: string, lang: AnnounceLang): string {
  const entry = ROLE_LABELS[role];
  if (entry === undefined) return role;
  return lang === "hi" ? entry.hi : entry.en;
}

export function stateBits(
  states: Record<string, string | boolean | number>,
  lang: AnnounceLang,
): string[] {
  const bits: string[] = [];
  if (states["checked"] === true) bits.push(lang === "hi" ? "चयनित" : "checked");
  if (states["checked"] === false && "checked" in states) {
    bits.push(lang === "hi" ? "अचयनित" : "not checked");
  }
  if (states["expanded"] === true) bits.push(lang === "hi" ? "खुला" : "expanded");
  if (states["expanded"] === false && "expanded" in states) {
    bits.push(lang === "hi" ? "बंद" : "collapsed");
  }
  if (states["selected"] === true) bits.push(lang === "hi" ? "चयनित" : "selected");
  if (states["pressed"] === true) bits.push(lang === "hi" ? "दबा हुआ" : "pressed");
  if (states["required"] === true) bits.push(lang === "hi" ? "आवश्यक" : "required");
  if (states["invalid"] === true || states["invalid"] === "true") {
    bits.push(lang === "hi" ? "अमान्य" : "invalid");
  }
  if (states["disabled"] === true) bits.push(lang === "hi" ? "अक्षम" : "disabled");
  if (typeof states["level"] === "number") {
    bits.push(lang === "hi" ? `स्तर ${states["level"]}` : `level ${states["level"]}`);
  }
  return bits;
}

function hintFor(
  role: string,
  el: Element,
  name: string,
  lang: AnnounceLang,
  verbosity: Verbosity,
): string {
  if (verbosity === "terse") return "";
  if (role === "searchbox") {
    return lang === "hi" ? HINTS["searchbox"]?.hi(name) ?? "" : HINTS["searchbox"]?.en(name) ?? "";
  }
  if (role === "button" && el instanceof HTMLButtonElement && el.type === "submit") {
    const key = "button:submit";
    return lang === "hi" ? HINTS[key]?.hi(name) ?? "" : HINTS[key]?.en(name) ?? "";
  }
  if (role === "button" && el instanceof HTMLInputElement && el.type === "submit") {
    const key = "button:submit";
    return lang === "hi" ? HINTS[key]?.hi(name) ?? "" : HINTS[key]?.en(name) ?? "";
  }
  return "";
}

export interface AnnouncementInput {
  elementId: string | null;
  name: string;
  role: string;
  states: Record<string, string | boolean | number>;
  element: Element;
  lang: AnnounceLang;
  verbosity: Verbosity;
}

export function buildAnnouncement(input: AnnouncementInput): Announcement {
  const label = roleLabel(input.role, input.lang);
  const bits = stateBits(input.states, input.lang);
  const hint = hintFor(input.role, input.element, input.name, input.lang, input.verbosity);
  const displayName = input.name !== "" ? input.name : label;
  const parts = [displayName, label, ...bits];
  if (hint !== "") parts.push(hint);
  // Terse (default): the name alone — "Email", not "Email. Edit box. required."
  // Standard: full sentence with role, states, and hints.
  const text =
    input.verbosity === "terse"
      ? displayName
      : input.lang === "hi"
        ? parts.join(" ")
        : parts.map((p) => p.replace(/\.$/, "")).join(". ") + ".";
  const signature = [input.elementId, input.name, input.role, bits.join("|"), hint].join("~");
  return {
    elementId: input.elementId,
    name: input.name,
    role: input.role,
    stateBits: bits,
    hint,
    lang: input.lang,
    text,
    signature,
  };
}

/**
 * Whether an announcement is worth speaking.
 *
 * A widget with no accessible name has nothing to say: the old code spoke the
 * bare role word, so opening any article announced "Link" (the site-logo
 * anchor) and similar nameless chrome. Nameless widgets are now silent, which
 * matches how screen readers treat an unnamed control.
 */
export function isAnnounceableTarget(
  el: Element,
  role: string,
  name: string,
): boolean {
  if (role === "generic" || role === "none" || role === "presentation") return false;
  if (name.trim() === "") return false; // nothing meaningful to speak
  return isMeaningfulFocusTarget(el, role);
}

/** Elements worth announcing on focus (PRD 2 §4: meaningful interactives). */
export function isMeaningfulFocusTarget(el: Element, role: string): boolean {
  if (role === "generic" || role === "none" || role === "presentation") return false;
  const focusable =
    (el as HTMLElement).tabIndex >= 0 || isNativelyFocusableTag(el);
  return focusable;
}

/**
 * Brand/logo furniture: an anchor or image that exists only to link home. Its
 * accessible name is the site name, which is never useful mid-page, so it is
 * treated as chrome and skipped by announcements.
 */
export function isSiteBranding(el: Element, role: string, name: string): boolean {
  if (role !== "link" && role !== "img") return false;
  const inBanner = el.closest("header, [role='banner']") !== null;
  if (!inBanner) return false;
  // Logo images / home anchors: only an image inside, or an anchor to "/".
  if (el.tagName.toLowerCase() === "img") return true;
  if (el.querySelector("img, svg") !== null) return true;
  const href = el.getAttribute("href");
  if (href === "/" || href === "" || href === "#") return true;
  // A header link whose entire label is the site name adds no information.
  return name.trim() !== "" && el.textContent?.trim() === name.trim() && href === "/";
}

function isNativelyFocusableTag(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href");
  return (
    tag === "button" ||
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    tag === "summary" ||
    tag === "area"
  );
}

// --- Hover (cursor-aware) narration -----------------------------------------
// The keyboard path above answers "what received focus". Hover answers "what
// is under the cursor" — focusability is irrelevant there, so this is a
// separate eligibility path sharing the same announcement builder, dedupe,
// branding suppression and text pipeline (accessible name first, visible text
// otherwise). Deliberately dependency-free (DOM APIs only): focus-monitor
// stays importable without the extractor modules.

/** Cap for hover-read text (matches the accessible-name cap). */
export const HOVER_TEXT_MAX_CHARS = 200;
/** Ancestor levels climbed looking for a readable block (card/container). */
const HOVER_CLIMB_MAX = 4;
/** Never read page furniture or code as hover text. */
const HOVER_SKIP_SELECTOR = "script,style,noscript,template,option,select";

function collapseHoverText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Visible-text candidate for one element ("" = nothing worth reading). */
function hoverTextOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return "";
  if (el.closest(HOVER_SKIP_SELECTOR) !== null) return "";
  // The cursor is on laid-out content; still refuse anything explicitly
  // hidden so collapsed/honeypot text is never narrated.
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return "";
  return collapseHoverText(el.textContent ?? "").slice(0, HOVER_TEXT_MAX_CHARS);
}

export interface HoverTarget {
  element: Element;
  name: string;
  role: string;
}

/**
 * Resolves what a hovered element should narrate (null = stay silent).
 *
 * Order: focusable named widgets behave exactly as on keyboard focus;
 * named-but-unfocusable elements (headings, images with alt, other labelled
 * content) narrate their own name; unnamed elements resolve to the nearest
 * readable block (paragraph, card, container) WITHOUT reading the page —
 * the climb stops after HOVER_CLIMB_MAX levels and never leaves for
 * body/html. Brand chrome stays silent (same rule as focus).
 */
export function resolveHoverTarget(el: Element, role: string, name: string): HoverTarget | null {
  const structural = role === "generic" || role === "none" || role === "presentation";
  if (!structural && name.trim() !== "") {
    // Named content under the cursor: headings, images with alt text,
    // labelled widgets — focusability deliberately not consulted.
    return { element: el, name: name.trim().slice(0, HOVER_TEXT_MAX_CHARS), role };
  }
  // Structural wrappers (div/span/...) and unnamed elements: resolve to the
  // nearest readable block (paragraph, card, container) WITHOUT reading the
  // page — the climb stops after HOVER_CLIMB_MAX levels and never reaches
  // body/html. Brand chrome stays silent (same rule as focus).
  let node: Element | null = el;
  for (let level = 0; level <= HOVER_CLIMB_MAX && node !== null; level += 1) {
    const text = hoverTextOf(node);
    if (text !== "") return { element: node, name: text, role: "text" };
    node = node.parentElement;
  }
  return null;
}

/**
 * Composed-tree ancestor check. `Node.contains` does NOT pierce shadow DOM
 * (host.contains(shadowInner) is false), so a plain `contains` guard would
 * reject the very shadow-descend the hover path exists for. This walks the
 * composed tree instead: closed shadow roots terminate the walk at their
 * host (unreachable by design — same as assistive technology).
 */
export function isDescendantComposed(ancestor: Element, node: Element): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current === ancestor) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : current.parentElement;
  }
  return false;
}

export interface HoverClock {
  now(): number;
  schedule(fn: () => void, ms: number): void;
}

const SYSTEM_HOVER_CLOCK: HoverClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    setTimeout(fn, ms);
  },
};

/**
 * Rapid-movement coalescer with trailing-edge guarantee.
 *
 * The old handler DROPPED every event within 600ms of the previous one, so a
 * fast-moving cursor skipped most content. This processes slow movement
 * immediately (same cadence as before) and coalesces bursts: intermediate
 * targets may be skipped, but the LATEST target is always flushed after the
 * settle delay. TTS spam is prevented downstream (priority-5 focus-takeover
 * speaks only the newest + signature dedupe), never here.
 */
export class HoverCoalescer {
  private pending: Element | null = null;
  private lastProcessAt = 0;
  private scheduled = false;

  constructor(
    private readonly process: (el: Element) => void,
    private readonly clock: HoverClock = SYSTEM_HOVER_CLOCK,
    private readonly immediateMs = 600,
    private readonly settleMs = 250,
  ) {}

  push(el: Element): void {
    this.pending = el;
    if (this.clock.now() - this.lastProcessAt >= this.immediateMs) {
      this.flush();
      return;
    }
    if (this.scheduled) return; // a flush is already queued; latest wins
    this.scheduled = true;
    this.clock.schedule(() => {
      this.scheduled = false;
      this.flush();
    }, this.settleMs);
  }

  private flush(): void {
    const el = this.pending;
    this.pending = null;
    if (el === null) return;
    this.lastProcessAt = this.clock.now();
    this.process(el);
  }
}

export type AnnouncementListener = (a: Announcement) => void;

export class FocusMonitor {
  private lastSignature: string | null = null;
  private listeners = new Set<AnnouncementListener>();
  private lang: AnnounceLang = "en";
  private verbosity: Verbosity = "terse";
  private boundHandler: ((e: FocusEvent) => void) | null = null;

  constructor(
    private readonly resolve: (el: Element) => {
      elementId: string | null;
      name: string;
      role: string;
      states: Record<string, string | boolean | number>;
    } | null,
  ) {}

  setLang(lang: AnnounceLang): void {
    this.lang = lang;
    this.lastSignature = null; // language switch re-announces
  }

  setVerbosity(v: Verbosity): void {
    this.verbosity = v;
    this.lastSignature = null;
  }

  onAnnouncement(cb: AnnouncementListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Testable entry point: process one focused element. */
  handleFocus(el: Element): Announcement | null {
    const resolved = this.resolve(el);
    if (resolved === null) return null;
    if (isSiteBranding(el, resolved.role, resolved.name)) return null;
    if (!isAnnounceableTarget(el, resolved.role, resolved.name)) return null;
    const announcement = buildAnnouncement({
      elementId: resolved.elementId,
      name: resolved.name,
      role: resolved.role,
      states: resolved.states,
      element: el,
      lang: this.lang,
      verbosity: this.verbosity,
    });
    if (announcement.signature === this.lastSignature) return null; // dedupe
    this.lastSignature = announcement.signature;
    this.listeners.forEach((cb) => cb(announcement));
    return announcement;
  }

  /**
   * Cursor-aware entry point: process one hovered element.
   *
   * Unlike handleFocus, keyboard focusability is NOT required — the cursor is
   * already on the content, so headings, plain text, images with alt text and
   * readable containers are all legitimate narration targets. Brand/chrome
   * suppression, empty-content silence and cross-announcement dedupe are kept.
   */
  handleHover(el: Element): Announcement | null {
    const resolved = this.resolve(el);
    if (resolved === null) return null;
    if (isSiteBranding(el, resolved.role, resolved.name)) return null;
    const target = resolveHoverTarget(el, resolved.role, resolved.name);
    if (target === null) return null;
    const announcement = buildAnnouncement({
      elementId: resolved.elementId,
      name: target.name,
      role: target.role,
      states: resolved.states,
      element: target.element,
      lang: this.lang,
      verbosity: this.verbosity,
    });
    if (announcement.signature === this.lastSignature) return null; // dedupe
    this.lastSignature = announcement.signature;
    this.listeners.forEach((cb) => cb(announcement));
    return announcement;
  }

  start(): void {
    if (this.boundHandler !== null) return;
    this.boundHandler = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof Element) this.handleFocus(target);
    };
    document.addEventListener("focusin", this.boundHandler, true);
  }

  stop(): void {
    if (this.boundHandler === null) return;
    document.removeEventListener("focusin", this.boundHandler, true);
    this.boundHandler = null;
  }
}
