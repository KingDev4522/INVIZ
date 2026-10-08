/**
 * EXPERIMENTAL (CONTEXT_MODE=hybrid): compact target registry serializer.
 *
 * Purpose (Phase 5): give the model ONLY what it needs to map visual intent to
 * an executable browser target — while the screenshot carries the layout.
 *
 * What it deliberately drops relative to serializePage():
 *   - LANDMARKS / FORMS / HEADINGS — structural furniture that the screenshot
 *     now conveys visually, and which never carries an executable id.
 *   - dedupe-by-identity — a visually duplicated control is a DIFFERENT
 *     element with a different eNN. Folding them together would make the
 *     registry a strict subset of what the screenshot shows, which is exactly
 *     how you manufacture "hallucinated target" failures: the model names an
 *     id it can see but that was folded away.
 *
 * What it must NEVER change:
 *   - The ids are the SAME eNN ids produced by ElementRegistry.rebuild() from
 *     the same snapshot the DOM path uses. This is not a second target-ID
 *     system: it is a different VIEW of the one authoritative registry, so
 *     WebGuard target-existence, generation freshness, provenance and the
 *     content-script resolve() all keep working untouched.
 *   - Sensitive field kinds still printed. They are a safety signal, not
 *     context budget.
 *
 * Prose (rNN) passes through when the caller needs read capability, because
 * `read` actions target region ids and there is no screenshot equivalent of
 * "read this text block" that the executor understands.
 */
import { estimateTokens, type BudgetItem, type ProseRegionInput } from "./context-budget.js";
import { MAX_ELEMENT_CANDIDATES } from "../../../shared/constants.js";

export interface RegistryInput {
  url: string;
  title: string;
  generation: number;
  items: BudgetItem[];
  /** Readable body prose, only when the task actually needs to read the page. */
  prose?: ProseRegionInput[];
}

export interface RegistryOutput {
  text: string;
  estimatedTokens: number;
  includedItems: number;
  omittedItems: number;
  includedRegions: number;
}

/** Compact per-target line: `e12 button "Sign in" <password> [disabled]`. */
function formatTarget(item: BudgetItem): string {
  const stateEntries = Object.entries(item.states)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  const statePart = stateEntries !== "" ? ` [${stateEntries}]` : "";
  const fieldPart = item.fieldKind !== null ? ` <${item.fieldKind}>` : "";
  // `value` must never reach a model. BudgetInput guarantees snapshots carry
  // none; refuse loudly here if one ever does rather than serialize it.
  if (item.value !== undefined) {
    return `${item.id} ${item.role} "${item.name}" <redacted>`;
  }
  return `${item.id} ${item.role} "${item.name}"${fieldPart}${statePart}`;
}

/**
 * Builds the [VERIFIED PAGE STATE] body for a hybrid turn.
 *
 * Document order is preserved (it is also the order ElementRegistry assigned
 * ids in), so a reader can correlate registry position with visual position
 * without a lookup table.
 */
export function serializeRegistry(input: RegistryInput): RegistryOutput {
  const included = input.items.slice(0, MAX_ELEMENT_CANDIDATES);
  const omittedItems = input.items.length - included.length;
  const prose = input.prose ?? [];

  const lines: string[] = [
    `PAGE url=${input.url} title="${input.title}" generation=${input.generation}`,
    `TARGETS: ${included.length} of ${input.items.length} executable element ids (eNN).`,
    "These are the ONLY valid action targets. Ids not listed here do not exist.",
    "ELEMENTS:",
    ...included.map(formatTarget),
  ];

  if (omittedItems > 0) {
    lines.push(`[${omittedItems} additional targets omitted by context cap]`);
  }

  let includedRegions = 0;
  if (prose.length > 0) {
    lines.push("PROSE (readable page text — use these region ids for read actions):");
    for (const region of prose) {
      const header = `${region.id} "${region.label}" (${region.chars} chars):`;
      const body = region.text.slice(0, 400);
      lines.push(header, body);
      includedRegions += 1;
    }
  }

  const text = lines.join("\n");
  return {
    text,
    estimatedTokens: estimateTokens(text),
    includedItems: included.length,
    omittedItems,
    includedRegions,
  };
}
