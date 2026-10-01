import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { openResearchDatabase } from "../../research/db/client";
import { researchEvents, researchJobs, researchSubjects } from "../../research/db/schema";
import { acceptResearchEvent, handleIntake } from "../../research/intake";
import { openTestResearchDatabase } from "./db-helper";

const connections: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });
async function database() { const connection = await openTestResearchDatabase(); connections.push(connection); return connection; }
export const event = (revision = 0, url = "https://example.com/", sourceId = "member-1") => buildCompanyResearchEvent({ sourceId, sourceRevision: revision, eventType: "upsert", urls: [{ slot: 1, url }] });

describe("independent research database and intake", () => {
  it("fails without an explicit research connection instead of using any main configuration", async () => {
    const factory = vi.fn();
    expect(() => openResearchDatabase({}, factory)).toThrow("RESEARCH_DATABASE_URL");
    expect(factory).not.toHaveBeenCalled();
    const { client } = await database();
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    expect(tables.rows.map((row) => row.name)).toContain("research_jobs");
    expect(tables.rows.map((row) => row.name)).not.toContain("member_spotlights");
  });

  it("persists one reservation across response-loss replay and rejects a changed payload with the same event ID", async () => {
    const { db } = await database();
    const input = await event();
    expect(await acceptResearchEvent(db, input, 100)).toEqual({ eventId: input.eventId, status: "accepted" });
    await acceptResearchEvent(db, input, 101);
    expect(await db.select().from(researchJobs)).toHaveLength(1);
    expect(await db.select().from(researchEvents)).toHaveLength(1);
    await expect(acceptResearchEvent(db, { ...input, occurredAt: "2026-10-02T00:00:00Z" }, 102)).rejects.toMatchObject({ status: 409 });
  });

  it("rolls back event and subject when job creation fails", async () => {
    const { db } = await database();
    await db.run(sql`CREATE TRIGGER fail_job BEFORE INSERT ON research_jobs BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(acceptResearchEvent(db, await event(), 100)).rejects.toThrow();
    expect(await db.select().from(researchEvents)).toHaveLength(0);
    expect(await db.select().from(researchSubjects)).toHaveLength(0);
  });

  it("deduplicates simultaneous delivery using real independent DB connections", async () => {
    const first = await database(); const second = first.openAnother();
    try {
      const input = await event();
      await Promise.all([acceptResearchEvent(first.db, input, 100), acceptResearchEvent(second.db, input, 100)]);
      expect(await first.db.select().from(researchJobs)).toHaveLength(1);
    } finally { second.close(); }
  });

  it("keeps the latest URL and never resurrects a deleted source, even with a larger revision", async () => {
    const { db } = await database();
    await acceptResearchEvent(db, await event(2, "https://new.example.com/"), 100);
    await acceptResearchEvent(db, await event(1), 101);
    expect((await db.select().from(researchJobs))[0].urls[0].url).toBe("https://new.example.com/");
    const deletion = await buildCompanyResearchEvent({ sourceId: "member-1", sourceRevision: 3, eventType: "delete", urls: [] });
    await acceptResearchEvent(db, deletion, 102);
    await acceptResearchEvent(db, await event(4), 103);
    const [subject] = await db.select().from(researchSubjects);
    expect(subject).toMatchObject({ status: "deleted", currentJobId: null, currentProfileId: null, sourceRevision: 3 });
    expect((await db.select().from(researchJobs))[0]).toMatchObject({ status: "superseded", purgeAfter: 102 + 7 * 86_400 });
  });

  it("allows new URLs after revoke while preserving the old generation's deletion deadline", async () => {
    const { db } = await database();
    await acceptResearchEvent(db, await event(), 100);
    await acceptResearchEvent(db, await buildCompanyResearchEvent({ sourceId: "member-1", sourceRevision: 1, eventType: "revoke", urls: [] }), 101);
    await acceptResearchEvent(db, await event(2), 102);
    const jobs = await db.select().from(researchJobs);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].purgeAfter).toBe(101 + 7 * 86_400);
    expect(jobs[1].purgeAfter).toBeNull();
    expect((await db.select().from(researchSubjects))[0].status).toBe("active");
  });

  it("reuses an in-progress job for same URLs and detaches a previous profile on URL change", async () => {
    const { db } = await database();
    await acceptResearchEvent(db, await event(), 100);
    const [before] = await db.select().from(researchSubjects);
    await db.update(researchSubjects).set({ currentProfileId: "previous-profile" }).where(eq(researchSubjects.sourceId, before.sourceId));
    await acceptResearchEvent(db, await event(1), 101);
    expect((await db.select().from(researchSubjects))[0].currentJobId).toBe(before.currentJobId);
    await acceptResearchEvent(db, await event(2, "https://example.com/services"), 102);
    expect((await db.select().from(researchSubjects))[0]).toMatchObject({ generation: 2, currentProfileId: null });
  });

  it("validates the private POST contract, body limits and fingerprints", async () => {
    const { db } = await database();
    const url = "https://private/internal/sources";
    expect((await handleIntake(new Request(url), db)).status).toBe(405);
    expect((await handleIntake(new Request("https://private/results"), db)).status).toBe(404);
    expect((await handleIntake(new Request(url, { method: "POST", body: "not-json" }), db)).status).toBe(400);
    expect((await handleIntake(new Request(url, { method: "POST", body: "x".repeat(16_385) }), db)).status).toBe(413);
    const input = await event();
    expect((await handleIntake(new Request(url, { method: "POST", body: JSON.stringify({ ...input, urlFingerprint: "0".repeat(64) }) }), db)).status).toBe(400);
    expect((await handleIntake(new Request(url, { method: "POST", body: JSON.stringify(input) }), db)).status).toBe(202);
  });
});
