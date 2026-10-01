import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { companyResearchOutbox } from "../../db/schema";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { enqueueCompanyResearchEvent } from "../../lib/services/company-research-outbox";
import { dispatchCompanyResearchEvents } from "../../worker/company-research-dispatch";
import { openTempDb } from "../helpers/temp-db";

let db: Db;
let close: () => void;
beforeEach(async () => { ({ db, close } = await openTempDb()); });
afterEach(() => { vi.useRealTimers(); close(); });

async function queue() {
  const event = await buildCompanyResearchEvent({ sourceId: crypto.randomUUID(), sourceRevision: 0, eventType: "upsert", urls: [{ slot: 2, url: "https://example.com/" }] });
  await enqueueCompanyResearchEvent(db, event, 100);
  return event;
}

describe("非公開分析Workerへの配送", () => {
  it("Service Bindingが無ければclaimせず、正常な202を待って配送済みにする", async () => {
    const event = await queue();
    expect(await dispatchCompanyResearchEvents(db, undefined, 100)).toMatchObject({ unavailable: true });
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({ status: "pending", attempts: 0 });
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://company-research.internal/internal/sources");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual(event);
      expect((await db.select().from(companyResearchOutbox))[0].status).toBe("delivering");
      return Response.json({ eventId: event.eventId, status: "accepted" }, { status: 202 });
    });
    expect(await dispatchCompanyResearchEvents(db, { fetch }, 100)).toMatchObject({ delivered: 1, retried: 0 });
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({ status: "delivered", deliveredAt: 100, attempts: 1 });
    await dispatchCompanyResearchEvents(db, { fetch }, 101);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("応答喪失は同じeventIdで再送し、分析側が重複ACKしたら完了する", async () => {
    const event = await queue();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("secret response detail")).mockResolvedValueOnce(Response.json({ eventId: event.eventId, status: "accepted" }, { status: 202 }));
    expect(await dispatchCompanyResearchEvents(db, { fetch }, 100)).toMatchObject({ retried: 1 });
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({ status: "pending", lastErrorCode: "network_error", nextAttemptAt: 160 });
    await dispatchCompanyResearchEvents(db, { fetch }, 159);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await dispatchCompanyResearchEvents(db, { fetch }, 160)).toMatchObject({ delivered: 1 });
    expect(fetch.mock.calls.map((args) => JSON.parse(args[1].body).eventId)).toEqual([event.eventId, event.eventId]);
  });

  it.each([400, 409, 503, 429])("HTTP %i は分類して保持する", async (status) => {
    await queue();
    const fetch = vi.fn().mockResolvedValue(new Response("private body", { status }));
    await dispatchCompanyResearchEvents(db, { fetch }, 100);
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({
      status: status === 400 || status === 409 ? "blocked" : "pending", lastErrorCode: `http_${status}`, deliveredAt: null,
    });
  });

  it.each([
    new Response("{}", { status: 200 }),
    Response.json({ eventId: "different-id", status: "accepted" }, { status: 202 }),
    new Response("not json", { status: 202 }),
  ])("受付永続化を証明しない応答では配送済みにしない", async (response) => {
    await queue();
    await dispatchCompanyResearchEvents(db, { fetch: vi.fn().mockResolvedValue(response) }, 100);
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({ status: "pending", deliveredAt: null });
  });
});
