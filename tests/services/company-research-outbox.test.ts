import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { companyResearchOutbox, memberSpotlights, memberSpotlightSubmissions, users } from "../../db/schema";
import type { AuthUser } from "../../lib/auth";
import { buildCompanyResearchEvent, canonicalizeResearchUrls, companyResearchEventSchema, computeResearchFingerprint } from "../../lib/company-research-contract";
import { claimCompanyResearchEvents, completeCompanyResearchDelivery, enqueueCompanyResearchEvent, failCompanyResearchDelivery, purgeDeliveredCompanyResearchEvents } from "../../lib/services/company-research-outbox";
import { createSpotlight, deleteSpotlight, updateSpotlight } from "../../lib/services/spotlights";
import { submitSpotlightSubmission } from "../../lib/services/spotlight-submissions";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, session: null as unknown, bucket: null as unknown as SpotlightBucket }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/r2", async (original) => ({ ...await original<typeof import("../../lib/r2")>(), getMediaBucket: () => state.bucket }));
vi.mock("../../lib/auth", async (original) => {
  const actual = await original<typeof import("../../lib/auth")>();
  return {
    ...actual,
    requireRole: (role: import("../../lib/auth").Role) => actual.requireRole(role, { db: state.db, getSession: async () => state.session }),
  };
});

import { createSpotlightAction, deleteSpotlightAction, updateSpotlightAction } from "../../app/admin/_actions/spotlights";
import { approveSpotlightSubmissionAction } from "../../app/admin/_actions/spotlight-submissions";

let db: Db;
let close: () => void;
const staff: AuthUser = { id: "staff", name: "Staff", email: "staff@example.com", role: "staff" };
const form = (websiteUrl: string | null = null, websiteUrl2: string | null = null) => ({
  companyName: "企業", personName: "Private Person", personNameKana: null, contactEmail: "private@example.com",
  role: null, quote: null, bio: "Private registration text", tags: [], photoMediaId: null, logoMediaId: null, enabled: true, websiteUrl, websiteUrl2,
});

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.session = null;
  state.bucket = new SpotlightBucket();
});
afterEach(() => { vi.unstubAllGlobals(); close(); });

async function event(sourceId = crypto.randomUUID(), sourceRevision = 0) {
  return buildCompanyResearchEvent({ sourceId, sourceRevision, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }], occurredAt: "2026-10-01T00:00:00Z" });
}

describe("会社分析イベントと通常保存", () => {
  it("URL集合を正規化し、順序・tracking以外の意味のあるqueryを保持する", async () => {
    const first = [{ slot: 1 as const, url: " HTTPS://Example.com:443/service?a=1&utm_source=test#detail " }, { slot: 2 as const, url: "https://example.com/service?a=1" }];
    expect(canonicalizeResearchUrls(first)).toEqual([{ slot: 1, url: "https://example.com/service?a=1" }]);
    expect(await computeResearchFingerprint(first)).toEqual(await computeResearchFingerprint([{ slot: 2, url: "https://example.com/service?a=1" }]));
    expect(await computeResearchFingerprint(first)).not.toEqual(await computeResearchFingerprint([{ slot: 1, url: "https://example.com/service?a=2" }]));
    const valid = await event();
    expect(companyResearchEventSchema.safeParse({ ...valid, privateEmail: "private@example.com" }).success).toBe(false);
    expect(companyResearchEventSchema.safeParse({ ...valid, urls: [] }).success).toBe(false);
    expect(companyResearchEventSchema.safeParse({ ...valid, eventType: "delete" }).success).toBe(false);
    expect(companyResearchEventSchema.safeParse({ ...valid, urls: [valid.urls[0], valid.urls[0]] }).success).toBe(false);
  });

  it("URLなしは予約せず、URL2だけでも保存後の最小イベントを予約し外部fetchは呼ばない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await createSpotlight(db, staff, form());
    expect(await db.select().from(companyResearchOutbox)).toHaveLength(0);
    const row = await createSpotlight(db, staff, form(null, "https://second.example.com/"));
    const [queued] = await db.select().from(companyResearchOutbox);
    expect(queued).toMatchObject({ sourceId: row.id, sourceRevision: 0, eventType: "upsert", urls: [{ slot: 2, url: row.websiteUrl2 }], status: "pending" });
    const serialized = JSON.stringify(queued);
    for (const privateValue of ["Private Person", "private@example.com", "Private registration text"]) expect(serialized).not.toContain(privateValue);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("旧clientのURL2省略は保存後の値を使い、両URL削除・本体削除は順番に無効化する", async () => {
    const first = await createSpotlight(db, staff, form("https://first.example.com/", "https://second.example.com/"));
    const { websiteUrl2: ignored, ...legacyForm } = form("https://first.example.com/");
    void ignored;
    const edited = await updateSpotlight(db, staff, first.id, { ...legacyForm, revision: 0 });
    const [retained] = await db.select().from(companyResearchOutbox).where(eq(companyResearchOutbox.sourceRevision, 1));
    expect(retained.urls).toEqual([{ slot: 1, url: first.websiteUrl! }, { slot: 2, url: first.websiteUrl2! }]);
    const cleared = await updateSpotlight(db, staff, first.id, { ...form(), revision: edited.revision });
    const [revoked] = await db.select().from(companyResearchOutbox).where(eq(companyResearchOutbox.sourceRevision, 2));
    expect(revoked).toMatchObject({ eventType: "revoke", urls: [] });
    await deleteSpotlight(db, staff, cleared.id);
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
    expect(await db.select().from(companyResearchOutbox)).toHaveLength(4);
    expect((await db.select().from(companyResearchOutbox).where(eq(companyResearchOutbox.sourceRevision, 3)))[0]).toMatchObject({ sourceId: first.id, eventType: "delete", urls: [] });
  });

  it("入力不正・revision競合は新しいイベントを作らない", async () => {
    const first = await createSpotlight(db, staff, form("https://example.com/"));
    await expect(createSpotlight(db, staff, { ...form(), companyName: "" })).rejects.toMatchObject({ status: 400 });
    await updateSpotlight(db, staff, first.id, { ...form("https://example.com/"), revision: 0 });
    await expect(updateSpotlight(db, staff, first.id, { ...form("https://changed.example.com/"), revision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(companyResearchOutbox)).toHaveLength(2);
  });

  it.each(["anonymous", "disabled", "stale-session", "deleted-user"] as const)("%s は通常保存・更新・削除・申請承認を拒否し、本体とoutboxを変更しない", async (mode) => {
    const [user] = await db.insert(users).values({ ...staff, isActive: mode !== "disabled", sessionVersion: 1 }).returning();
    const first = await createSpotlight(db, staff, form());
    await submitSpotlightSubmission(db, state.bucket, {
      requestKey: crypto.randomUUID(), companyName: "申請企業", personName: "申請者", email: "pending@example.com", consent: true,
      websiteUrl: "https://pending.example.com/", websiteUrl2: "https://pending-second.example.com/",
    }, {});
    const [pending] = await db.select().from(memberSpotlightSubmissions);
    state.session = mode === "anonymous" ? null : { userId: user.id, sessionVersion: mode === "stale-session" ? 0 : user.sessionVersion };
    if (mode === "deleted-user") await db.delete(users).where(eq(users.id, user.id));
    const denied = { error: { code: "unauthorized", message: "ログインしてください" } };

    expect(await createSpotlightAction(form("https://new.example.com/"))).toEqual(denied);
    expect(await updateSpotlightAction(first.id, { ...form("https://changed.example.com/"), revision: first.revision })).toEqual(denied);
    expect(await deleteSpotlightAction(first.id)).toEqual(denied);
    expect(await approveSpotlightSubmissionAction(pending.id, pending.revision)).toEqual(denied);

    expect(await db.select().from(memberSpotlights)).toEqual([first]);
    expect(await db.select().from(memberSpotlightSubmissions)).toEqual([pending]);
    expect(await db.select().from(companyResearchOutbox)).toHaveLength(0);
  });

  it("outbox DB失敗は作成・更新・削除を同じtransactionでrollbackする", async () => {
    const first = await createSpotlight(db, staff, form("https://example.com/"));
    await db.run(sql`CREATE TRIGGER reject_research BEFORE INSERT ON company_research_outbox BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END`);
    await expect(createSpotlight(db, staff, form("https://new.example.com/"))).rejects.toThrow();
    await expect(updateSpotlight(db, staff, first.id, { ...form("https://changed.example.com/"), revision: 0 })).rejects.toThrow();
    await expect(deleteSpotlight(db, staff, first.id)).rejects.toThrow();
    expect(await db.select().from(memberSpotlights)).toEqual([first]);
    expect(await db.select().from(companyResearchOutbox)).toHaveLength(1);
  });
});

describe("outboxのleaseとSQL制約", () => {
  it("同じsource/revision/typeを二重予約できず、SQL CHECKで壊れたイベントを拒否する", async () => {
    const first = await event();
    await enqueueCompanyResearchEvent(db, first, 100);
    await expect(enqueueCompanyResearchEvent(db, { ...first, eventId: crypto.randomUUID() }, 100)).rejects.toThrow();
    await expect(db.update(companyResearchOutbox).set({ sourceRevision: -1 })).rejects.toThrow();
    await expect(db.update(companyResearchOutbox).set({ urls: [] })).rejects.toThrow();
    await expect(db.run(sql`UPDATE company_research_outbox SET status = 'invalid'`)).rejects.toThrow();
  });

  it("一回25件までclaimし、同時実行でもleaseを二重取得しない", async () => {
    for (let i = 0; i < 26; i++) await enqueueCompanyResearchEvent(db, await event(), 100);
    const [first, second] = await Promise.all([claimCompanyResearchEvents(db, 100), claimCompanyResearchEvents(db, 100)]);
    expect(first.length).toBeLessThanOrEqual(25);
    expect(second.length).toBeLessThanOrEqual(25);
    const claimed = [...first, ...second];
    expect(new Set(claimed.map(({ eventId }) => eventId)).size).toBe(claimed.length);
    const rest = await claimCompanyResearchEvents(db, 100);
    expect(claimed.length + rest.length).toBe(26);
  });

  it("期限切れを再取得し、古いleaseの完了・失敗報告で新leaseを上書きしない", async () => {
    await enqueueCompanyResearchEvent(db, await event(), 100);
    const [first] = await claimCompanyResearchEvents(db, 100);
    expect(await claimCompanyResearchEvents(db, 399)).toHaveLength(0);
    const [recovered] = await claimCompanyResearchEvents(db, 400);
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(recovered.attempts).toBe(2);
    expect(await completeCompanyResearchDelivery(db, first, 401)).toBe(false);
    expect(await failCompanyResearchDelivery(db, first, "network_error", 401)).toBe(false);
    expect(await completeCompanyResearchDelivery(db, recovered, 401)).toBe(true);
  });

  it("失敗はbackoffし、契約エラーを停止し、配送済みの30日超だけ掃除する", async () => {
    for (let i = 0; i < 3; i++) await enqueueCompanyResearchEvent(db, await event(), 100);
    const [retry, blocked, sent] = await claimCompanyResearchEvents(db, 100);
    await failCompanyResearchDelivery(db, retry, "http_503", 100);
    await failCompanyResearchDelivery(db, blocked, "http_400", 100, true);
    await completeCompanyResearchDelivery(db, sent, 100);
    expect(await claimCompanyResearchEvents(db, 159)).toHaveLength(0);
    expect((await claimCompanyResearchEvents(db, 160)).map(({ eventId }) => eventId)).toEqual([retry.eventId]);
    expect(await purgeDeliveredCompanyResearchEvents(db, 100 + 30 * 86400)).toBe(0);
    expect(await purgeDeliveredCompanyResearchEvents(db, 101 + 30 * 86400)).toBe(1);
    expect((await db.select().from(companyResearchOutbox)).map(({ eventId }) => eventId).sort()).toEqual([retry.eventId, blocked.eventId].sort());
  });
});
