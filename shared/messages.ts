/**
 * Message registry + error vocabulary (PRD 4 §62, §72–74).
 * User-facing speech strings live here once, in English and Hindi.
 * No ad-hoc error sentences anywhere else.
 */

export const MESSAGE_TYPES: readonly string[] = [
  "START_VOICE_TURN",
  "VOICE_CAPTURE_START",
  "VOICE_CAPTURE_STOP",
  "VOICE_TRANSCRIPT",
  "VOICE_STATUS",
  "CAPTURE_LEVEL",
  "DIAG_CAPTURE",
  "USER_OVERRIDE",
  "FOCUS_CHANGED",
  "PAGE_STATE_UPDATED",
  "PAGE_GENERATION_CHANGED",
  "AI_REQUEST",
  "AI_RESPONSE",
  "ACTION_PROPOSED",
  "ACTION_ALLOWED",
  "ACTION_BLOCKED",
  "ACTION_CONFIRMATION_REQUIRED",
  "ACTION_EXECUTE",
  "OBSERVE_VERIFY",
  "READ_TEXT",
  "REQUEST_SNAPSHOT",
  "AGENT_ACTIVE",
  "ACTION_RESULT",
  "VERIFICATION_REQUEST",
  "VERIFICATION_RESULT",
  "TASK_STATE_UPDATED",
  "TTS_SPEAK",
  "TTS_REPEAT",
  "TTS_STOP",
  "TTS_STOPPED",
  "TTS_PRIMARY_RESET",
  "GATE_OPEN",
  "GATE_CLOSED",
  "CANCEL_TASK",
  "OFFSCREEN_READY",
] as const;

export function isKnownMessageType(t: string): boolean {
  return (MESSAGE_TYPES as readonly string[]).includes(t);
}

export type ErrorCode =
  | "CANNOT_ACCESS_PAGE"
  | "CANNOT_UNDERSTAND_PAGE"
  | "ELEMENT_NOT_FOUND"
  | "ACTION_FAILED"
  | "ACTION_BLOCKED"
  | "CONFIRMATION_REQUIRED"
  | "TASK_CANCELLED"
  | "TASK_LIMIT_REACHED"
  | "AI_SERVICE_UNAVAILABLE"
  | "VOICE_CAPTURE_FAILED"
  | "CAPTURE_EMPTY"
  | "TRANSCRIPTION_FAILED"
  | "RATE_LIMITED"
  | "VERIFICATION_FAILED"
  | "STALE_TARGET"
  | "UNSUPPORTED_PAGE";

export const ERROR_CODES: readonly ErrorCode[] = [
  "CANNOT_ACCESS_PAGE",
  "CANNOT_UNDERSTAND_PAGE",
  "ELEMENT_NOT_FOUND",
  "ACTION_FAILED",
  "ACTION_BLOCKED",
  "CONFIRMATION_REQUIRED",
  "TASK_CANCELLED",
  "TASK_LIMIT_REACHED",
  "AI_SERVICE_UNAVAILABLE",
  "VOICE_CAPTURE_FAILED",
  "CAPTURE_EMPTY",
  "TRANSCRIPTION_FAILED",
  "RATE_LIMITED",
  "VERIFICATION_FAILED",
  "STALE_TARGET",
  "UNSUPPORTED_PAGE",
] as const;

export type SpeechLang = "en" | "hi";

export const ERROR_SPEECH: Record<ErrorCode, Record<SpeechLang, string>> = {
  CANNOT_ACCESS_PAGE: {
    en: "I can't read the current page yet. Reload the page and try again.",
    hi: "मैं यह पेज अभी पढ़ नहीं पा रहा। पेज reload करके दोबारा कोशिश करें।",
  },
  CANNOT_UNDERSTAND_PAGE: {
    en: "I couldn't understand this page.",
    hi: "मैं इस पेज को समझ नहीं पाया।",
  },
  ELEMENT_NOT_FOUND: {
    en: "I couldn't find that element.",
    hi: "मुझे वह एलिमेंट नहीं मिला।",
  },
  ACTION_FAILED: {
    en: "That action failed.",
    hi: "वह कार्रवाई विफल रही।",
  },
  ACTION_BLOCKED: {
    en: "That action was blocked for safety.",
    hi: "वह कार्रवाई सुरक्षा के कारण रोक दी गई।",
  },
  CONFIRMATION_REQUIRED: {
    en: "I need your confirmation before I continue.",
    hi: "आगे बढ़ने से पहले मुझे आपकी अनुमति चाहिए।",
  },
  TASK_CANCELLED: {
    en: "Task cancelled.",
    hi: "कार्य रद्द किया गया।",
  },
  TASK_LIMIT_REACHED: {
    en: "I reached the task limit, so I'm stopping.",
    hi: "कार्य की सीमा पूरी हो गई, इसलिए मैं रुक रहा हूँ।",
  },
  AI_SERVICE_UNAVAILABLE: {
    en: "The AI service is unavailable. Basic navigation still works.",
    hi: "AI सेवा उपलब्ध नहीं है। बुनियादी नेविगेशन अभी भी काम करेगा।",
  },
  VOICE_CAPTURE_FAILED: {
    en: "Voice capture failed. Start capture again to retry.",
    hi: "आवाज़ रिकॉर्ड नहीं हो पाई। पुनः प्रयास के लिए दोबारा बोलें।",
  },
  CAPTURE_EMPTY: {
    en: "I didn't hear anything. Please try again.",
    hi: "मैंने कुछ नहीं सुना। कृपया दोबारा कोशिश करें।",
  },
  TRANSCRIPTION_FAILED: {
    en: "I couldn't transcribe that. Please try again.",
    hi: "मैं उसे लिख नहीं पाया। कृपया दोबारा बोलें।",
  },
  RATE_LIMITED: {
    en: "Too many requests. Wait a few seconds and try again.",
    hi: "बहुत अधिक अनुरोध। कुछ सेकंड रुककर दोबारा कोशिश करें।",
  },
  VERIFICATION_FAILED: {
    en: "I couldn't verify that result.",
    hi: "मैं उस परिणाम की पुष्टि नहीं कर पाया।",
  },
  STALE_TARGET: {
    en: "The page changed, so that action is no longer valid.",
    hi: "पेज बदल गया है, इसलिए वह कार्रवाई अब मान्य नहीं है।",
  },
  UNSUPPORTED_PAGE: {
    en: "This page isn't supported.",
    hi: "यह पेज समर्थित नहीं है।",
  },
};

export function getErrorSpeech(code: ErrorCode, lang: SpeechLang): string {
  return ERROR_SPEECH[code][lang];
}
