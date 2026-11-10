import { describe, it, expect, afterEach } from "vitest";
import { SqliteKnowledgeStore } from "../knowledge/sqlite-store.js";
import { ENTITY_TOOLS, buildKnowledgeToolHandler } from "./tools.js";
import { readPublicCampaignRecord } from "./public-knowledge.js";

const stores: SqliteKnowledgeStore[] = [];
const setup = () => { const store = new SqliteKnowledgeStore(":memory:"); stores.push(store); return { store, handler: buildKnowledgeToolHandler(store, { sceneNumber: 7 }) }; };
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

describe("generic campaign memory contracts", () => {
  it("keeps schemas stable while nested empty collections and typed data are created", async () => {
    const { store, handler } = setup();
    const definitions = JSON.stringify(ENTITY_TOOLS);
    const result = await handler("remember", { operations: [
      { op: "create_collection", name: "Spells", note: "Learned named spells and practitioners" },
      { op: "create_collection", parent: "Spells", name: "Arcane" },
      { op: "upsert", collection: "Spells/Arcane", name: "Firefly", fields: { level: 2, learned: true, notes: null, casts: [1, { potency: 0.5 }] } },
    ] });
    expect(result?.is_error).toBeUndefined();
    const node = await store.read("Firefly");
    expect(node.fields).toMatchObject({ level: 2, learned: true, notes: null, casts: [1, { potency: 0.5 }] });
    expect(JSON.stringify(ENTITY_TOOLS)).toBe(definitions);
    expect(JSON.stringify(ENTITY_TOOLS)).not.toContain('"enum":["character"');
    expect(JSON.parse((await handler("knowledge", { action: "outline" }))!.content)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Spells", kind: "collection", note: "Learned named spells and practitioners" })]));
  });

  it("rejects bad operations before writes, then accepts corrected input", async () => {
    const { store, handler } = setup();
    const before = await store.snapshot();
    const bad = await handler("remember", { operations: [{ op: "upsert", collection: "Characters" }] });
    expect(bad?.is_error).toBe(true);
    expect(bad?.content).toContain("name or uid");
    expect(await store.snapshot()).toBe(before);
    expect(await store.pendingNotices()).toEqual([]);
    const retry = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Bob" }] });
    expect(retry?.is_error).toBeUndefined();
    expect(JSON.parse(retry!.content).identities).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Bob", uid: expect.any(String) })]));
  });

  it("rejects invented sheet headings with an actionable diagnostic, then accepts the corrected retry", async () => {
    const { store, handler } = setup();
    const bad = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Aldric", body: "## Combat\n- swordsmanship" }] });
    expect(bad?.is_error).toBe(true);
    expect(bad?.content).toContain('"## Combat" is not one of them');
    expect(bad?.content).toContain("Relationships, Stats, Skills, Inventory, Conditions, Notes");
    expect(await store.resolve("Aldric")).toBeNull();
    const retry = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Aldric", body: "## Skills\n- swordsmanship" }] });
    expect(retry?.is_error).toBeUndefined();
    expect((await store.read("Aldric")).body).toBe("## Skills\n- swordsmanship");
    const repaired = await handler("remember", { operations: [{ op: "patch", uid: "Aldric", body: "## Abilities\nSTR: 18" }] });
    expect(repaired?.is_error).toBeUndefined();
    expect(JSON.parse(repaired!.content).repairs).toEqual([{ code: "sheet_heading_canonicalized", from: "## Abilities", to: "## Stats" }]);
    expect((await store.read("Aldric")).body).toBe("## Stats\nSTR: 18");
  });

  it("rejects a batch containing an invented heading before applying any operation", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Aldric", body: "## Notes\n- travels light" }] });
    const bad = await handler("remember", { operations: [
      { op: "patch", uid: "Aldric", body: "## Skills\n- swordsmanship" },
      { op: "patch", uid: "Aldric", body: "## Combat\n- swordsmanship" },
    ] });
    expect(bad?.is_error).toBe(true);
    expect((await store.read("Aldric")).body).toBe("## Notes\n- travels light");
  });

  it("keeps ## Changelog write-protected while history stays the entry path", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Aldric", body: "## Notes\n- quiet", history: "**Scene 001**: Created." }] });
    const bad = await handler("remember", { operations: [{ op: "patch", uid: "Aldric", body: "## Changelog\n- **Scene 002**: Wrote himself in." }] });
    expect(bad?.is_error).toBe(true);
    expect(bad?.content).toContain("write-protected");
    expect(bad?.content).toContain("history/append_log");
    expect((await store.read("Aldric")).body).toBe("## Notes\n- quiet");
    expect((await store.read("Aldric")).logs).toHaveLength(1);
  });

  it("canonicalizes append_text fragments but leaves string leaves and other collections alone", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Aldric", fields: { motto: "## Equipment" } }, { op: "upsert", collection: "Lore", name: "Tome", body: "## Combat\n- annotated" }] });
    const repaired = await handler("remember", { operations: [{ op: "append_text", uid: "Aldric", text: "\n## Equipment\n- Wrench" }] });
    expect(JSON.parse(repaired!.content).repairs).toEqual([{ code: "sheet_heading_canonicalized", from: "## Equipment", to: "## Inventory" }]);
    expect((await store.read("Aldric")).body).toBe("\n## Inventory\n- Wrench");
    const motto = (await store.read("Aldric")).children!.find((child) => child.name === "motto")!;
    await handler("remember", { operations: [{ op: "append_text", uid: motto.uid, text: " forever" }] });
    expect((await store.read(motto.uid)).value).toBe("## Equipment forever");
    expect((await store.read("Tome")).body).toBe("## Combat\n- annotated");
  });

  it("lets engine-side store writes keep curated free-form sections", async () => {
    const { store, handler } = setup();
    // Setup materialization, seeds, and sheet specialists bypass the tool
    // contract by design and own their section formats.
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Ada", body: "## Mechanics\nSTR: 10\n\n## What she's hiding (DM only)\n- the ledger" }]);
    expect((await store.read("Ada")).body).toContain("## What she's hiding (DM only)");
    expect(await handler("knowledge", { action: "read", handle: "Ada" })).not.toBeNull();
  });

  it("resolves aliases and same-name updates without a clarification result", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Tall Hat", aliases: ["Bob"], fields: { mood: "happy", hp: 8 } }] });
    const uid = await store.resolve("Tall Hat");
    const result = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Bob", fields: { hp: 7 }, history: "Took one damage" }] });
    expect(result?.is_error).toBeUndefined();
    expect(await store.resolve("Bob")).toBe(uid);
    expect((await store.read(uid!)).fields).toMatchObject({ mood: "happy", hp: 7 });
    expect((await store.read(uid!)).logs).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Took one damage" })]));
  });

  it("validates explicit disclosure before effects and accepts a corrected private/public batch", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Zhijun Nabo", aliases: ["King"], body: "PRIVATE_SENTINEL", fields: { secret: "PRIVATE_SENTINEL" } }] });
    await store.acknowledgeNotices((await store.pendingNotices()).map(notice => notice.id));
    const before = await store.snapshot();
    for (const operation of [
      { op: "disclose", uid: "Zhijun Nabo", summary: "The echo identified themself." },
      { op: "disclose", uid: "Zhijun Nabo", name: "Zhijun Nabo" },
      { op: "disclose", uid: "Zhijun Nabo", name: "Zhijun Nabo", summary: "The echo identified themself.", fields: { secret: "PRIVATE_SENTINEL" } },
    ]) {
      const bad = await handler("remember", { operations: [{ op: "patch", uid: "Zhijun Nabo", body: "Uncommitted change" }, operation] });
      expect(bad?.is_error).toBe(true);
      expect(await store.snapshot()).toBe(before);
      expect(await store.pendingNotices()).toEqual([]);
    }
    const retry = await handler("remember", { operations: [
      { op: "patch", uid: "Zhijun Nabo", fields: { manifestations: "PRIVATE_SENTINEL: incomplete" } },
      { op: "disclose", uid: "Zhijun Nabo", name: "Zhijun Nabo", summary: "The reflective echo identified themself as Veyruin's last junior archivist." },
    ] });
    expect(retry?.is_error).toBeUndefined();
    expect((await store.read("Zhijun Nabo")).visibility).toBe("private");
    expect((await readPublicCampaignRecord(store, "Zhijun Nabo"))?.content).toContain("last junior archivist");
    expect((await readPublicCampaignRecord(store, "Zhijun Nabo"))?.content).not.toContain("PRIVATE_SENTINEL");
    expect(await readPublicCampaignRecord(store, "King")).toBeNull();
    expect(JSON.parse(retry!.content).noticeId).toBeTypeOf("number");
  });

  it("preserves references during unrelated edits and returns committed impact candidates", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Locations", name: "Castle" }, { op: "upsert", collection: "Characters", name: "Resident" }, { op: "add_reference", source: "Resident", target: "Castle", label: "lives there" }] });
    const result = await handler("remember", { operations: [{ op: "patch", uid: "Castle", fields: { burned: true }, history: "Burned" }] });
    expect(JSON.parse(result!.content).candidates).toContain(await store.resolve("Resident"));
    await handler("remember", { operations: [{ op: "patch", uid: "Resident", fields: { hp: 8 } }] });
    expect((await store.read("Resident")).references).toEqual(expect.arrayContaining([expect.objectContaining({ target: await store.resolve("Castle") })]));
    expect((await store.read("Resident")).fields).not.toHaveProperty("dead");
  });

  it("searches and pages the complete text appended through a string-leaf UID", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Lore", name: "Chronicle", fields: { detail: "Start. " } }] });
    const leaf = (await store.read("Chronicle")).children![0].uid;
    const suffix = "x".repeat(20000) + " late discovery";
    expect((await handler("remember", { operations: [{ op: "append_text", uid: leaf, text: suffix }] }))?.is_error).toBeUndefined();
    let recovered = "";
    let offset = 0;
    do {
      const page = JSON.parse((await handler("knowledge", { action: "read", handle: leaf, textOffset: offset, textLimit: 3000 }))!.content);
      recovered += page.value;
      offset = page.textNextOffset ?? 0;
    } while (offset);
    expect(recovered).toBe("Start. " + suffix);
    const hits = JSON.parse((await handler("knowledge", { action: "search", query: "late discovery" }))!.content);
    expect(hits).toContainEqual(expect.objectContaining({ uid: leaf, owner: { uid: (await store.resolve("Chronicle"))!, name: "Chronicle" } }));
  });
  it("records current-scene provenance for append_log without overwriting an explicit historical scene", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Lore", name: "Chronicle" }] });
    const result = await handler("remember", { operations: [
      { op: "append_log", uid: "Chronicle", body: "Current observation", metadata: {} },
      { op: "append_log", uid: "Chronicle", body: "Earlier observation", metadata: { sceneNumber: 2 } },
    ] });
    expect(result?.is_error).toBeUndefined();
    expect((await store.read("Chronicle")).logs.map(log => log.metadata)).toEqual([{ scene: 7 }, { sceneNumber: 2 }]);
  });
  it("reads bulk text/history in bounded pages and searches typed scalar leaves", async () => {
    const { handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Lore", name: "Chronicle", body: "a".repeat(20000) + "needle", fields: { detail: "x".repeat(1000) + "leafneedle" }, history: "h".repeat(2000) }] });
    const first = JSON.parse((await handler("knowledge", { action: "read", handle: "Chronicle", textLimit: 12, logTextLimit: 13 }))!.content);
    expect(first.body).toHaveLength(12);
    expect(first.logs[0].body).toHaveLength(13);
    expect(first.textLength).toBe(20006);
    const hits = JSON.parse((await handler("knowledge", { action: "search", query: "leafneedle" }))!.content);
    expect(hits.length).toBeGreaterThan(0);
    const bad = await handler("knowledge", { action: "read", handle: "Chronicle", textOffset: -1 });
    expect(bad?.is_error).toBe(true);
  });
});
