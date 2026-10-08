/**
 * Model output-contract validator — REAL (PRD 6.4 §1.2; PRD 4 §25, §90–91).
 * Accepts exactly one of the six controlled outcomes with all required fields;
 * everything else is rejected and never interpreted. Malformed model output is
 * a transport-level failure, not an instruction (PRD 5 §66).
 */
import {
  validateStructuredAction,
  SKILL_ID_RE,
  SKILL_INPUT_MAX_KEYS,
  SKILL_INPUT_VALUE_MAX_CHARS,
} from "./types.js";
import type { AgentOutcome } from "./types.js";

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(`model output rejected: ${message}`);
    this.name = "ModelOutputError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requiredText(obj: Record<string, unknown>, field: string, max: number): string {
  const v = obj[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ModelOutputError(`missing or empty "${field}"`);
  }
  if (v.length > max) {
    throw new ModelOutputError(`"${field}" exceeds ${max} characters`);
  }
  return v;
}

/** Drops a wrapping markdown fence (```json … ```), if present. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return fenced !== null && fenced[1] !== undefined ? fenced[1] : text;
}

/** Drops a reasoning-model <think>…</think> preamble, if present. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Spoken-output brevity cap: at most two sentences.
 *
 * The prompt orders this, but prompts are preferences, not enforcement — so a
 * long answer is trimmed here instead of rejected (rejecting would burn the
 * single corrective re-ask on verbosity). Fragment without terminal
 * punctuation counts as one sentence and passes through.
 */
export function trimToTwoSentences(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const sentences = trimmed.match(/[^.!?…]+[.!?…]+["'”’)\]]*|[^.!?…]+$/gu);
  if (sentences === null || sentences.length <= 2) return trimmed;
  return `${sentences[0]}${sentences[1]}`.trim();
}

/**
 * Returns balanced top-level JSON objects found in `text`, in order.
 * Brace counting is string-aware so braces inside values cannot end the
 * object early, and every `{` is tried as a start so an unbalanced brace in
 * surrounding prose cannot mask the real object. This only *locates*
 * candidate JSON — each candidate is still parsed and fully validated, so
 * tolerance here cannot smuggle anything past the output contract.
 */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closedAt = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          closedAt = i;
          break;
        }
      }
    }
    if (closedAt !== -1) found.push(text.slice(start, closedAt + 1));
  }
  return found;
}

/**
 * Parses model text into an object, tolerating the three shapes reasoning
 * models actually emit: bare JSON, fenced JSON, and JSON wrapped in prose or
 * a reasoning preamble. Purely a *syntactic* recovery step: the result still
 * has to satisfy the full outcome contract below.
 */
function parseModelJson(raw: string): Record<string, unknown> {
  const attempts: string[] = [];
  const withoutThink = stripThink(raw);
  for (const base of [raw, withoutThink]) {
    attempts.push(base, stripFence(base));
  }
  for (const balanced of [...balancedObjects(withoutThink), ...balancedObjects(raw)]) {
    attempts.push(balanced);
  }
  for (const candidate of attempts) {
    if (candidate.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // try the next candidate shape
    }
  }
  throw new ModelOutputError("not parseable JSON");
}

/**
 * Action keys that carry no execution semantics. Reasoning models routinely
 * bolt a spoken `text`/`summary` onto an otherwise valid action; rejecting the
 * whole outcome for that alone turned ~50% of live turns into hard failures.
 * Only this explicit allowlist is dropped — anything else (run, script, eval,
 * …) still fails the closed schema in validateStructuredAction, which is the
 * control that stops smuggled payloads (PRD 4 §79).
 */
const PRESENTATION_ONLY_ACTION_KEYS: ReadonlySet<string> = new Set([
  "text",
  "summary",
  "reason",
  "explanation",
  "note",
  "notes",
  "label",
  "comment",
]);

/** Expectation vocabulary the model uses interchangeably (see types.ts). */
const EXPECTATION_TYPE_ALIASES: Readonly<Record<string, string>> = {
  value_present: "field_value_present",
  has_value: "field_value_present",
  element_clicked: "element_present",
  clicked: "element_present",
  changed: "element_state",
  content_changed: "url_changed",
  loaded: "navigation_completed",
};

/**
 * Rewrites an expectation's `type` to the vocabulary the verification engine
 * actually implements. Accepting a variant without translating it would pass
 * validation and then be unevaluable at verification time, so the translation
 * happens here — at the model boundary — and nowhere else.
 */
function normalizeExpectation(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, unknown>;
  const type = rec["type"];
  if (typeof type !== "string") return rec;
  const alias = EXPECTATION_TYPE_ALIASES[type];
  if (alias === undefined) return rec;
  return { ...rec, type: alias };
}

function normalizeActionInput(v: unknown): unknown {
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!PRESENTATION_ONLY_ACTION_KEYS.has(key)) {
      out[key] = key === "expect" ? normalizeExpectation(value) : value;
    }
  }
  return out;
}

/**
 * Validates parsed model output (object, or model text to recover).
 * Unknown outcome types, missing fields, and schema-invalid actions throw.
 * Extra unknown fields on the outcome are ignored (strictness is on type +
 * required fields); on an action, only presentation-only keys are dropped
 * before the closed schema runs.
 */
export function validateModelOutput(raw: unknown): AgentOutcome {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    obj = parseModelJson(raw);
  }
  if (!isRecord(obj)) {
    throw new ModelOutputError("must be a JSON object");
  }
  if (typeof obj["type"] !== "string") {
    throw new ModelOutputError("missing outcome \"type\"");
  }

  switch (obj["type"]) {
    case "answer": {
      const text = trimToTwoSentences(requiredText(obj, "text", 4000));
      return { type: "answer", text };
    }
    case "ask_user": {
      const question = requiredText(obj, "question", 500);
      const out: AgentOutcome = { type: "ask_user", question };
      if (obj["field"] !== undefined) {
        if (typeof obj["field"] !== "string" || obj["field"] === "") {
          throw new ModelOutputError("\"field\" must be a non-empty string");
        }
        out.field = obj["field"];
      }
      if (obj["sensitivity"] !== undefined) {
        if (obj["sensitivity"] !== "ordinary" && obj["sensitivity"] !== "high") {
          throw new ModelOutputError("\"sensitivity\" must be ordinary|high");
        }
        out.sensitivity = obj["sensitivity"];
      }
      return out;
    }
    case "action": {
      if (!isRecord(obj["action"])) {
        throw new ModelOutputError("\"action\" must be an object");
      }
      const checked = validateStructuredAction(normalizeActionInput(obj["action"]));
      if (!checked.ok) {
        throw new ModelOutputError(`invalid action: ${checked.errors.join("; ")}`);
      }
      return {
        type: "action",
        action: (normalizeActionInput(obj["action"]) as unknown as NonNullable<AgentOutcome["action"]>),
      };
    }
    case "confirmation_required": {
      const reason = requiredText(obj, "reason", 500);
      if (!isRecord(obj["action"])) {
        throw new ModelOutputError("\"action\" must be an object");
      }
      const normalized = normalizeActionInput(obj["action"]);
      const checked = validateStructuredAction(normalized);
      if (!checked.ok) {
        throw new ModelOutputError(`invalid action: ${checked.errors.join("; ")}`);
      }
      return {
        type: "confirmation_required",
        reason,
        action: (normalized as unknown as NonNullable<AgentOutcome["action"]>),
      };
    }
    case "task_complete": {
      const out: AgentOutcome = { type: "task_complete" };
      if (obj["summary"] !== undefined) {
        if (typeof obj["summary"] !== "string") {
          throw new ModelOutputError("\"summary\" must be a string");
        }
        out.text = trimToTwoSentences(obj["summary"].slice(0, 1000));
      }
      return out;
    }
    case "cannot_complete": {
      const reason = trimToTwoSentences(requiredText(obj, "reason", 500));
      return { type: "cannot_complete", reason };
    }
    case "skill": {
      // The model may only NAME a skill. The id is syntactically bounded here;
      // the Skill Registry separately decides whether it exists, is executable,
      // and can resolve for the current page. Unknown/disabled ids therefore
      // pass validation but fail closed in the controller — never executed.
      const skillId = obj["skill_id"];
      if (typeof skillId !== "string" || !SKILL_ID_RE.test(skillId)) {
        throw new ModelOutputError(
          "\"skill_id\" must match ^[a-z][a-z0-9_]{0,63}$",
        );
      }
      const rawInput = obj["input"];
      const input: Record<string, string | number | boolean> = {};
      if (rawInput !== undefined && rawInput !== null) {
        if (!isRecord(rawInput)) {
          throw new ModelOutputError("\"input\" must be an object");
        }
        const keys = Object.keys(rawInput);
        if (keys.length > SKILL_INPUT_MAX_KEYS) {
          throw new ModelOutputError(`"input" exceeds ${SKILL_INPUT_MAX_KEYS} keys`);
        }
        for (const key of keys) {
          if (!/^[A-Za-z0-9_]{1,40}$/.test(key)) {
            throw new ModelOutputError(`input key "${key}" is invalid`);
          }
          const value = rawInput[key];
          if (typeof value === "string") {
            if (value.length > SKILL_INPUT_VALUE_MAX_CHARS) {
              throw new ModelOutputError(
                `input "${key}" exceeds ${SKILL_INPUT_VALUE_MAX_CHARS} characters`,
              );
            }
            input[key] = value;
          } else if (typeof value === "number") {
            if (!Number.isFinite(value)) {
              throw new ModelOutputError(`input "${key}" must be a finite number`);
            }
            input[key] = value;
          } else if (typeof value === "boolean") {
            input[key] = value;
          } else {
            throw new ModelOutputError(
              `input "${key}" must be a string, number, or boolean`,
            );
          }
        }
      }
      return { type: "skill", skill: { skillId, input } };
    }
    default:
      throw new ModelOutputError(`unknown outcome type "${obj["type"] as string}"`);
  }
}
