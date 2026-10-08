/**
 * Context budgeting serializer (PRD 6.4 §1.3; PRD 6 §4.5; PRD 5 §33–34).
 * Packs a page snapshot into a bounded model input: 10k-token cap, priority
 * order (focus → fields → headings → interactives, 120 candidates max),
 * structural exclusion of sensitive values, and an explicit cut-log.
 * Field VALUES never exist in snapshots (Phase 1 carries states only), so
 * exclusion is structural; the serializer additionally refuses any item that
 * somehow carries a value payload.
 */

import {
  MAX_ELEMENT_CANDIDATES,
  MAX_HEADING_CANDIDATES,
  QWEN_INPUT_TOKEN_BUDGET,
} from "../../../shared/constants.js";

export interface BudgetItem {
  id: string;
  role: string;
  name: string;
  states: Record<string, string | boolean | number>;
  fieldKind: string | null;
  sensitive: boolean;
  /** Any value payload here is a defect — refused, never serialized. */
  value?: unknown;
}

export interface ProseRegionInput {
  id: string;
  label: string;
  text: string;
  chars: number;
}

export interface BudgetInput {
  url: string;
  title: string;
  generation: number;
  items: BudgetItem[];
  headings: Array<{ level: number; text: string }>;
  landmarks: Array<{ role: string; name: string }>;
  forms: Array<{ name: string; fieldCount: number }>;
  focusId?: string;
  /** Readable body prose. Without this the model cannot read or answer
   *  anything on an article page — the element list is widgets only. */
  prose?: ProseRegionInput[];
}

/**
 * Tokens held back from every section so the assembled page (with its newlines
 * and final region) never lands above the caller's cap.
 */
const RESERVE_TOKENS = 64;

export interface BudgetOutput {
  text: string;
  estimatedTokens: number;
  includedItems: number;
  cut: {
    droppedItems: number;
    /** Items removed by the candidate-count cap before budgeting. */
    cappedItems: number;
    /** Repeated identical controls folded into one line (see dedupeByIdentity). */
    dedupedItems: number;
    droppedHeadings: number;
    /** Prose characters actually included (0 when the page has no regions). */
    proseChars: number;
    bytes: number;
  };
}

/** One representative plus how many identical siblings it stands for. */
interface DedupedItem {
  item: BudgetItem;
  identical: number;
}

/**
 * Folds identical controls into a single line.
 *
 * Measured on a real GitHub repo page: 99 elements, 56 of them exact repeats
 * (22 "Star" links, 18 "Fork", 12 avatars). Those lines carry no information
 * the model can act on — they are indistinguishable from each other — but
 * they crowd the context and, on a small model, measurably increase guessing
 * at element ids. The FIRST occurrence (highest priority after ordering) is
 * kept and stays fully usable; the count is reported so nothing is silently
 * lost, and the model is told more exist.
 */
function dedupeByIdentity(ordered: BudgetItem[]): DedupedItem[] {
  const firstIndex = new Map<string, DedupedItem>();
  const out: DedupedItem[] = [];
  for (const item of ordered) {
    const key = `${item.role}|${item.name}`;
    const existing = firstIndex.get(key);
    if (existing !== undefined) {
      existing.identical += 1;
      continue;
    }
    const entry: DedupedItem = { item, identical: 0 };
    firstIndex.set(key, entry);
    out.push(entry);
  }
  return out;
}

/** Conservative tokenizer estimate: ~4 chars/token + 15% margin. */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.15);
}

/**
 * Coarse image-token comparator for the sparse vision fallback (P0-1).
 *
 * This is NOT a provider measurement — no image-token count has been proven
 * against Ollama/Groq here. It exists so a screenshot step can log image cost
 * next to text cost in the same coarse unit: ~1k tokens per megapixel
 * (1024x1024 ≈ 1024). Treat every logged value as budget-comparison only.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.ceil((width * height) / 1024);
}

function formatItem(item: BudgetItem): string {
  const stateEntries = Object.entries(item.states)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  const statePart = stateEntries !== "" ? ` [${stateEntries}]` : "";
  const fieldPart = item.fieldKind !== null ? ` <${item.fieldKind}>` : "";
  return `${item.id} ${item.role} "${item.name}"${fieldPart}${statePart}`;
}

/**
 * Serializes a page snapshot within budget. Priority: focused element first,
 * then form fields (task-relevant), then headings, then other interactives.
 */
export function serializePage(
  input: BudgetInput,
  budget: number = QWEN_INPUT_TOKEN_BUDGET,
): BudgetOutput {
  // Hard ceiling: nothing emitted may exceed it. A few tokens are reserved so
  // the final assembled page still fits after join/newline overhead.
  const cap = Math.max(0, budget - RESERVE_TOKENS);
  for (const item of input.items) {
    if (item.value !== undefined) {
      throw new Error(`refusing to serialize value payload for ${item.id}`);
    }
  }
  const header =
    `PAGE url=${input.url} title="${input.title}" generation=${input.generation}\n` +
    `FORMS: ${input.forms.map((f) => `${f.name || "unnamed"}(${f.fieldCount})`).join("; ") || "none"}\n` +
    `LANDMARKS: ${input.landmarks.map((l) => `${l.role}${l.name !== "" ? `:${l.name}` : ""}`).join("; ") || "none"}`;

  const focusItem = input.focusId !== undefined
    ? input.items.find((i) => i.id === input.focusId)
    : undefined;
  // Settings-heavy pages have 200+ controls — switches/checkboxes must not be
  // truncated. Prioritize toggle-like controls before generic fields.
  function isToggleLike(i: BudgetItem): boolean {
    return i.role === "switch" || i.role === "checkbox" || i.role === "combobox" || i.states["checked"] !== undefined || i.states["expanded"] !== undefined;
  }
  const toggleFields = input.items.filter((i) => i.fieldKind !== null && isToggleLike(i) && i.id !== focusItem?.id);
  const otherFields = input.items.filter((i) => i.fieldKind !== null && !isToggleLike(i) && i.id !== focusItem?.id);
  const rest = input.items.filter(
    (i) => i.fieldKind === null && i.id !== focusItem?.id,
  );
  const ordered = [
    ...(focusItem !== undefined ? [focusItem] : []),
    ...toggleFields,
    ...otherFields,
    ...rest,
  ];
  const dedupedAll = dedupeByIdentity(ordered);
  // Counted from the folded list, not the raw one: otherwise items removed by
  // dedupe are reported as "capped" as well and the cut log double-counts them.
  const cappedItems = Math.max(0, dedupedAll.length - MAX_ELEMENT_CANDIDATES);
  // Generic head+tail preservation: document order puts persistent
  // header/nav first and main content last, so a pure prefix cut always
  // starves the tail (media grids, main actions) on large pages. Keeping a
  // head segment (focused/toggle/field priorities live there) plus a tail
  // segment keeps both chrome AND content groundable within the same budget.
  // Relative order within each segment is preserved, so ordinal references
  // ("first", "Nth") stay stable. No site-specific ranking involved.
  const HEAD_KEEP = 20;
  const deduped =
    dedupedAll.length <= MAX_ELEMENT_CANDIDATES
      ? dedupedAll
      : [
          ...dedupedAll.slice(0, HEAD_KEEP),
          ...dedupedAll.slice(dedupedAll.length - (MAX_ELEMENT_CANDIDATES - HEAD_KEEP)),
        ];
  const budgeted = deduped.map((d) => d.item);
  const dedupedItems = deduped.reduce((sum, d) => sum + d.identical, 0);

  const lines: string[] = [header, "ELEMENTS:"];
  let includedItems = 0;
  for (let i = 0; i < budgeted.length; i += 1) {
    const entry = deduped[i] as DedupedItem;
    const line =
      entry.identical > 0
        ? `${formatItem(entry.item)} [+${entry.identical} more identical]`
        : formatItem(entry.item);
    if (estimateTokens(`${lines.join("\n")}\n${line}`) > cap) break;
    lines.push(line);
    includedItems += 1;
  }

  const headingLines = input.headings
    .slice(0, MAX_HEADING_CANDIDATES)
    .map((h) => `H${h.level} ${h.text}`);
  let includedHeadings = 0;
  for (const line of headingLines) {
    if (estimateTokens(`${lines.join("\n")}\n${line}`) > cap) break;
    lines.push(line);
    includedHeadings += 1;
  }

  // Prose is what makes an article page answerable and readable, so it takes
  // whatever budget remains after elements and headings. Each region is
  // admitted only if it fits the cap exactly as measured — the char/token
  // estimate carries a 1.15 margin, so the allowance is derived from it rather
  // than assumed.
  const prose = input.prose ?? [];
  let includedProseChars = 0;
  if (prose.length > 0) {
    lines.push("PROSE (readable page text — use these region ids for read actions):");
    for (const region of prose) {
      const headerLine = `${region.id} "${region.label}" (${region.chars} chars):`;
      const withHeader = [...lines, headerLine];
      const afterHeader = estimateTokens(withHeader.join("\n"));
      if (afterHeader >= cap) break;
      // ~4 chars per token, plus the estimator's 1.15 safety margin.
      const roomChars = Math.floor(((cap - afterHeader) / 1.15) * 4) - 16;
      // A region too small to be worth a turn is dropped, but say so rather
      // than letting the model assume the page has no more text.
      if (roomChars < 80) {
        lines.push(`${headerLine} [omitted — no budget left]`);
        break;
      }
      const truncated = roomChars < region.text.length;
      const body = truncated
        ? `${region.text.slice(0, roomChars).trimEnd()}…`
        : region.text;
      const candidate = [...withHeader, body];
      // Safety net: never emit an over-budget page, even if the arithmetic
      // above is off by a character.
      if (estimateTokens(candidate.join("\n")) > cap) {
        lines.push(`${headerLine} [omitted — out of context budget]`);
        break;
      }
      lines.push(headerLine, body);
      includedProseChars += body.length;
    }
  }

  const text = lines.join("\n");
  return {
    text,
    estimatedTokens: estimateTokens(text),
    includedItems,
    cut: {
      droppedItems: budgeted.length - includedItems,
      cappedItems,
      dedupedItems,
      // Measured against the full input so headings lost to the candidate cap
      // are reported too, not just the ones lost to the token budget.
      droppedHeadings: input.headings.length - includedHeadings,
      proseChars: includedProseChars,
      bytes: text.length,
    },
  };
}
