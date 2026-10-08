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
