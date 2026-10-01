import type { Db } from "../db/index";
import { companyResearchEventSchema } from "../lib/company-research-contract";
import {
  claimCompanyResearchEvents, completeCompanyResearchDelivery, failCompanyResearchDelivery,
  COMPANY_RESEARCH_BATCH_SIZE, type CompanyResearchOutboxRow,
} from "../lib/services/company-research-outbox";

export interface CompanyResearchServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const DISPATCH_TIMEOUT_MS = 10_000;
const DISPATCH_CONCURRENCY = 5;

export type CompanyResearchDispatchResult = { delivered: number; retried: number; blocked: number; unavailable: boolean };

/** Service Binding の202（受付DBへの永続化完了）まで待つ。生のHTTP bodyや例外をログへ出さない。 */
export async function dispatchCompanyResearchEvents(db: Db, binding: CompanyResearchServiceBinding | undefined, now: number, limit = COMPANY_RESEARCH_BATCH_SIZE): Promise<CompanyResearchDispatchResult> {
  const result: CompanyResearchDispatchResult = { delivered: 0, retried: 0, blocked: 0, unavailable: !binding };
  if (!binding) return result;
  const rows = await claimCompanyResearchEvents(db, now, limit);
  let cursor = 0;
  async function deliver(row: CompanyResearchOutboxRow): Promise<void> {
    const parsed = companyResearchEventSchema.safeParse({
      schemaVersion: 1, eventId: row.eventId, sourceId: row.sourceId, sourceRevision: row.sourceRevision,
      eventType: row.eventType, urls: row.urls, urlFingerprint: row.urlFingerprint, occurredAt: row.occurredAt,
    });
    if (!parsed.success) {
      if (await failCompanyResearchDelivery(db, row, "invalid_event", now, true)) result.blocked++;
      return;
    }
    let code = "network_error";
    let blocked = false;
    try {
      const response = await binding!.fetch("https://company-research.internal/internal/sources", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      code = `http_${response.status}`;
      blocked = response.status === 400 || response.status === 409;
      if (response.status === 202) {
        const acknowledgment: unknown = await response.json();
        if (typeof acknowledgment === "object" && acknowledgment !== null && "eventId" in acknowledgment && "status" in acknowledgment &&
          acknowledgment.eventId === row.eventId && acknowledgment.status === "accepted") {
          if (await completeCompanyResearchDelivery(db, row, now)) result.delivered++;
          return;
        }
        code = "invalid_acknowledgment";
      }
    } catch {
      // API body・URL・例外messageには個人情報やcredentialが入り得るため永続化しない。
    }
    if (await failCompanyResearchDelivery(db, row, code, now, blocked)) {
      if (blocked) result.blocked++;
      else result.retried++;
    }
  }
  // 一つのDB障害で他の処理を置き去りにしない。全てsettleしてからCronを失敗させる。
  const workers = Array.from({ length: Math.min(DISPATCH_CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      await deliver(row);
    }
  });
  const completed = await Promise.allSettled(workers);
  if (completed.some((entry) => entry.status === "rejected")) throw new Error("Company research outbox persistence failed");
  return result;
}
