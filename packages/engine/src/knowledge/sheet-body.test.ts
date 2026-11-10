import { describe, it, expect } from "vitest";
import { CHARACTER_SHEET_HEADINGS, normalizeSheetBody } from "./sheet-body.js";

describe("normalizeSheetBody", () => {
  it("leaves canonical sheet bodies untouched", () => {
    const body = "Aldric keeps to the road.\n\n## Stats\nHP: 42\n\n### Substats\nSTR: 10\n\n## Inventory\n- Sword";
    const result = normalizeSheetBody(body);
    expect(result).toEqual({ ok: true, body, repairs: [] });
  });

  it("keeps preamble prose and ### subheadings out of scope", () => {
    const body = "Her nickname was Equipment.\n\n## Notes\n### Equipment log\n- inline ## Stats text is not a line-start heading";
    const result = normalizeSheetBody(body);
    expect(result).toEqual({ ok: true, body, repairs: [] });
  });

  it("coerces ## Abilities to ## Stats and reports the repair", () => {
    const result = normalizeSheetBody("## Abilities\nSTR: 18");
    expect(result).toEqual({ ok: true, body: "## Stats\nSTR: 18", repairs: [{ code: "sheet_heading_canonicalized", from: "## Abilities", to: "## Stats" }] });
  });

  it("coerces ## Equipment to ## Inventory and reports the repair", () => {
    const result = normalizeSheetBody("## Equipment\n- Rope");
    expect(result).toEqual({ ok: true, body: "## Inventory\n- Rope", repairs: [{ code: "sheet_heading_canonicalized", from: "## Equipment", to: "## Inventory" }] });
  });

  it("canonicalizes casing and trailing whitespace variants", () => {
    const result = normalizeSheetBody("## STATS \nHP: 1");
    expect(result).toEqual({ ok: true, body: "## Stats\nHP: 1", repairs: [{ code: "sheet_heading_canonicalized", from: "## STATS ", to: "## Stats" }] });
  });

  it("coerces unambiguous singulars", () => {
    const result = normalizeSheetBody("## Skill\n- Salvage\n\n## Condition\n- Winded");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe("## Skills\n- Salvage\n\n## Conditions\n- Winded");
    expect(result.repairs.map((repair) => repair.to)).toEqual(["## Skills", "## Conditions"]);
  });

  it("rejects invented headings with an actionable diagnostic", () => {
    const result = normalizeSheetBody("## Combat\n- Swordsmanship");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"## Combat" is not one of them');
    expect(result.message).toContain(CHARACTER_SHEET_HEADINGS.join(", "));
  });

  it("keeps ## Changelog write-protected and points at the entry path", () => {
    const result = normalizeSheetBody("## Changelog\n- **Scene 001**: Created.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("write-protected");
    expect(result.message).toContain("history/append_log");
  });

  it("rejects case-variant changelog headings too", () => {
    expect(normalizeSheetBody("## changelog\n- x").ok).toBe(false);
  });

  it("normalizes append_text fragments by the same rules", () => {
    const result = normalizeSheetBody("\n## Equipment\n- Wrench");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe("\n## Inventory\n- Wrench");
    expect(result.repairs).toEqual([{ code: "sheet_heading_canonicalized", from: "## Equipment", to: "## Inventory" }]);
  });
});
