/**
 * Canonical character-sheet `##` heading rules for knowledge-store body writes.
 *
 * The heading discipline used to be a standing DM prompt obligation
 * ("always use these exact names"); per the directive-burden effort it is now
 * enforced at the write boundary instead of remembered. Character sheet
 * bodies use exactly {@link CHARACTER_SHEET_HEADINGS}; unambiguous variants are
 * canonicalized deterministically, anything else is rejected with an
 * actionable diagnostic, and `## Changelog` is write-protected because
 * changelog entries only flow through the history/append_log path.
 *
 * Pure functions only — the store decides which writes are character sheets.
 */
import type { KnowledgeRepair } from "@machine-violet/shared/types/knowledge.js";

export const CHARACTER_SHEET_HEADINGS = [
  "Relationships",
  "Stats",
  "Skills",
  "Inventory",
  "Conditions",
  "Notes",
] as const;

export type SheetBodyResult =
  | { ok: true; body: string; repairs: KnowledgeRepair[] }
  | { ok: false; message: string };

/** Lowercased heading variant → canonical heading. Exact names win first. */
const CANONICAL = new Map<string, string>();
for (const heading of CHARACTER_SHEET_HEADINGS) CANONICAL.set(heading.toLowerCase(), heading);
// Documented invented alternatives (character-promotion.md names the first
// two) and unambiguous singulars. Everything else is rejected, not guessed.
for (const [variant, canonical] of Object.entries({
  ability: "Stats",
  abilities: "Stats",
  stat: "Stats",
  equipment: "Inventory",
  relationship: "Relationships",
  skill: "Skills",
  condition: "Conditions",
  note: "Notes",
}))
  CANONICAL.set(variant, canonical);

/**
 * Normalize one body write (a full body or an append_text fragment).
 * `###` subheadings and preamble prose are untouched.
 */
export function normalizeSheetBody(body: string): SheetBodyResult {
  const repairs: KnowledgeRepair[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("## ") || line.startsWith("### ")) continue;
    const heading = line.slice(3).trim();
    const lower = heading.toLowerCase();
    if (lower === "changelog")
      return {
        ok: false,
        message: "## Changelog is write-protected on character sheets. Record changelog entries through the history/append_log path instead and retry without a ## Changelog section.",
      };
    const canonical = CANONICAL.get(lower);
    if (!canonical)
      return {
        ok: false,
        message: `Character sheet bodies use only these canonical section headings: ${CHARACTER_SHEET_HEADINGS.join(", ")}. "${line.trim()}" is not one of them — merge its content into the closest canonical section and retry.`,
      };
    const to = `## ${canonical}`;
    if (to !== line) {
      repairs.push({ code: "sheet_heading_canonicalized", from: line, to });
      lines[i] = to;
    }
  }
  return { ok: true, body: lines.join("\n"), repairs };
}
