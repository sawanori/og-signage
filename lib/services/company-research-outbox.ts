import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/index";
import { companyResearchOutbox, nowSeconds } from "../../db/schema";
import { buildCompanyResearchEvent, type CompanyResearchEvent, type CompanyResearchUrl } from "../company-research-contract";

type WriteTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type OutboxDb = Db | WriteTransaction;
type Source = { id: string; revision: number; websiteUrl: string | null; websiteUrl2: string | null };

export type CompanyResearchOutboxRow = typeof companyResearchOutbox.$inferSelect;
export const COMPANY_RESEARCH_BATCH_SIZE = 25;
export const COMPANY_RESEARCH_LEASE_SECONDS = 300;

export function researchUrlsFromSpotlight(source: Source): CompanyResearchUrl[] {
  const urls: CompanyResearchUrl[] = [];
  if (source.websiteUrl) urls.push({ slot: 1, url: source.websiteUrl });
  if (source.websiteUrl2) urls.push({ slot: 2, url: source.websiteUrl2 });
  return urls;
}

/** 必ず紹介行の変更と同じ transaction で呼ぶ。ここでは外部サービスへ接続しない。 */
export async function enqueueCompanyResearchEvent(tx: OutboxDb, event: CompanyResearchEvent, now = nowSeconds()): Promise<void> {
  await tx.insert(companyResearchOutbox).values({
    eventId: event.eventId, sourceId: event.sourceId, sourceRevision: event.sourceRevision,
    eventType: event.eventType, urls: event.urls, urlFingerprint: event.urlFingerprint,
    occurredAt: event.occurredAt, nextAttemptAt: now,
  });
}

/** URLなしの初回登録はスルー。URLがあった登録を空にした時だけ revoke を送る。 */
export async function enqueueSpotlightResearch(tx: OutboxDb, source: Source, previous?: Source): Promise<void> {
  const urls = researchUrlsFromSpotlight(source);
  if (urls.length === 0 && (!previous || researchUrlsFromSpotlight(previous).length === 0)) return;
  await enqueueCompanyResearchEvent(tx, await buildCompanyResearchEvent({
    sourceId: source.id, sourceRevision: source.revision, eventType: urls.length > 0 ? "upsert" : "revoke", urls,
  }));
}

export async function enqueueSpotlightResearchDeletion(tx: OutboxDb, source: Source): Promise<void> {
  await enqueueCompanyResearchEvent(tx, await buildCompanyResearchEvent({
    sourceId: source.id, sourceRevision: source.revision + 1, eventType: "delete", urls: [],
  }));
}

function due(now: number) {
  return or(
    and(eq(companyResearchOutbox.status, "pending"), lte(companyResearchOutbox.nextAttemptAt, now)),
    and(eq(companyResearchOutbox.status, "delivering"), lte(companyResearchOutbox.leaseExpiresAt, now)),
  );
}

/** 同時Cronでも1件につき1つのlease。期限切れは安全に再配送する。 */
export async function claimCompanyResearchEvents(db: Db, now: number, limit = COMPANY_RESEARCH_BATCH_SIZE): Promise<CompanyResearchOutboxRow[]> {
  const candidates = await db.select({ eventId: companyResearchOutbox.eventId }).from(companyResearchOutbox)
    .where(due(now)).orderBy(asc(companyResearchOutbox.nextAttemptAt), asc(companyResearchOutbox.eventId)).limit(Math.min(COMPANY_RESEARCH_BATCH_SIZE, Math.max(0, limit)));
  const claimed: CompanyResearchOutboxRow[] = [];
  for (const candidate of candidates) {
    const rows = await db.update(companyResearchOutbox).set({
      status: "delivering", leaseToken: crypto.randomUUID(), leaseExpiresAt: now + COMPANY_RESEARCH_LEASE_SECONDS,
      attempts: sql`${companyResearchOutbox.attempts} + 1`,
    }).where(and(eq(companyResearchOutbox.eventId, candidate.eventId), due(now))).returning();
    if (rows[0]) claimed.push(rows[0]);
  }
  return claimed;
}

function ownedLease(row: CompanyResearchOutboxRow) {
  if (!row.leaseToken) throw new Error("Outbox lease is required");
  return and(eq(companyResearchOutbox.eventId, row.eventId), eq(companyResearchOutbox.status, "delivering"), eq(companyResearchOutbox.leaseToken, row.leaseToken));
}

export async function completeCompanyResearchDelivery(db: Db, row: CompanyResearchOutboxRow, now: number): Promise<boolean> {
  const changed = await db.update(companyResearchOutbox).set({ status: "delivered", deliveredAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: null })
    .where(ownedLease(row)).returning({ eventId: companyResearchOutbox.eventId });
  return changed.length === 1;
}

/** 400/409は契約確認待ち。それ以外は最大1時間のbackoffで永続的に再配送する。 */
export async function failCompanyResearchDelivery(db: Db, row: CompanyResearchOutboxRow, code: string, now: number, blocked = false): Promise<boolean> {
  const changed = await db.update(companyResearchOutbox).set({
    status: blocked ? "blocked" : "pending", leaseToken: null, leaseExpiresAt: null,
    lastErrorCode: code, nextAttemptAt: now + Math.min(3600, 60 * 2 ** Math.min(6, Math.max(0, row.attempts - 1))),
  }).where(ownedLease(row)).returning({ eventId: companyResearchOutbox.eventId });
  return changed.length === 1;
}

/** 未送信・失敗は消さない。配送済みだけ30日後に掃除する。 */
export async function purgeDeliveredCompanyResearchEvents(db: Db, now: number): Promise<number> {
  const rows = await db.delete(companyResearchOutbox).where(and(eq(companyResearchOutbox.status, "delivered"), lt(companyResearchOutbox.deliveredAt, now - 30 * 24 * 60 * 60)))
    .returning({ eventId: companyResearchOutbox.eventId });
  return rows.length;
}
