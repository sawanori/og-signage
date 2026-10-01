import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createRequestContext, runWithRequestContext, closeAfterResponseWithBody } from "vinext/shims/unified-request-context";
import type { Db } from "../../db/index";
import { companyResearchOutbox, memberSpotlights, memberSpotlightSubmissions, users } from "../../db/schema";
import type { AuthUser } from "../../lib/auth";
import { createSpotlight, listSpotlights } from "../../lib/services/spotlights";
import { submitSpotlightSubmission } from "../../lib/services/spotlight-submissions";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, bucket: null as unknown as SpotlightBucket, denied: null as 401 | 403 | null }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/r2", async (original) => ({ ...await original<typeof import("../../lib/r2")>(), getMediaBucket: () => state.bucket }));
vi.mock("../../lib/auth", () => {
  class AuthzError extends Error { constructor(readonly status: 401 | 403) { super("denied"); } }
  return {
    AuthzError,
    requireRole: async () => {
      if (state.denied) throw new AuthzError(state.denied);
      return { id: "staff", name: "Staff", email: "staff@example.com", role: "staff" };
    },
  };
});
// Use the installed production shim's actual after()/request context, rather than a callback mock.
vi.mock("next/server", async () => await import("vinext/shims/server"));

import { createSpotlightAction, deleteSpotlightAction, updateSpotlightAction } from "../../app/admin/_actions/spotlights";
import { approveSpotlightSubmissionAction, rejectSpotlightSubmissionAction } from "../../app/admin/_actions/spotlight-submissions";
import { createNoticeAction, type ActionResult } from "../../app/admin/_actions/content";

const staff: AuthUser = { id: "staff", name: "Staff", email: "staff@example.com", role: "staff" };
const form = (websiteUrl: string | null = "https://example.com/") => ({
  companyName: "企業", personName: "担当者", contactEmail: "member@example.com", personNameKana: null,
  role: null, quote: null, bio: null, tags: [], photoMediaId: null, logoMediaId: null, enabled: true, websiteUrl, websiteUrl2: null,
});
let db: Db;
let close: () => void;
let bindingFetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.bucket = new SpotlightBucket();
  state.denied = null;
  await db.insert(users).values(staff);
  bindingFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { eventId } = JSON.parse(init!.body as string);
    return Response.json({ eventId, status: "accepted" }, { status: 202 });
  });
  env.COMPANY_RESEARCH = { fetch: bindingFetch };
});
afterEach(() => { env.COMPANY_RESEARCH = undefined; vi.restoreAllMocks(); close(); });

async function request<T>(action: () => Promise<T>) {
  const background: Promise<unknown>[] = [];
  const ctx = createRequestContext({ executionContext: { waitUntil: (promise) => { background.push(promise); } } });
  const result = await runWithRequestContext(ctx, action);
  const response = closeAfterResponseWithBody(Response.json(result), ctx);
  return { result, response, background, ctx };
}

async function finish<T>(action: () => Promise<T>) {
  const execution = await request(action);
  await execution.response.json();
  await Promise.all(execution.background);
  return execution;
}

async function pendingSubmission() {
  await submitSpotlightSubmission(db, state.bucket, {
    requestKey: crypto.randomUUID(), companyName: "申請企業", personName: "申請者", email: "member@example.com", consent: true,
    websiteUrl: "https://pending.example.com/",
  }, {});
  return (await db.select().from(memberSpotlightSubmissions))[0];
}

describe("成功した通常保存後の分析配送", () => {
  it("保存をcommitしてからwaitUntilへ登録し、未完了の配送を待たず応答を返す", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bindingFetch.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return Response.json({ eventId: JSON.parse(init!.body as string).eventId, status: "accepted" }, { status: 202 });
    });
    const execution = await request(() => createSpotlightAction(form()));
    expect(execution.result.data?.id).toBeTruthy();
    expect(await db.select().from(memberSpotlights)).toHaveLength(1);
    expect((await db.select().from(companyResearchOutbox))[0].status).toBe("pending");
    expect(execution.background).toHaveLength(1);
    expect(bindingFetch).not.toHaveBeenCalled();
    let backgroundDone = false;
    void Promise.all(execution.background).then(() => { backgroundDone = true; });
    try {
      expect(await execution.response.json()).toMatchObject({ data: { id: execution.result.data!.id } });
      await vi.waitFor(() => expect(bindingFetch).toHaveBeenCalledTimes(1));
      expect(backgroundDone).toBe(false);
    } finally {
      release();
      await Promise.all(execution.background);
    }
    expect((await db.select().from(companyResearchOutbox))[0].status).toBe("delivered");
  });

  it.each(["update", "delete", "approve"] as const)("%s の成功後も永続イベントを配送する", async (operation) => {
    let action: () => Promise<unknown>;
    if (operation === "approve") {
      const pending = await pendingSubmission();
      action = () => approveSpotlightSubmissionAction(pending.id, pending.revision);
    } else {
      const row = await createSpotlight(db, staff, form());
      await db.delete(companyResearchOutbox);
      action = operation === "update"
        ? () => updateSpotlightAction(row.id, { ...form("https://changed.example.com/"), revision: row.revision })
        : () => deleteSpotlightAction(row.id);
    }
    const execution = await finish(action);
    expect(execution.result).toHaveProperty("data");
    expect(execution.background).toHaveLength(1);
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({ status: "delivered", eventType: operation === "delete" ? "delete" : "upsert" });
  });

  it.each([401, 403] as const)("HTTP 200で返る認可エラー%iは4経路とも配送を登録しない", async (status) => {
    state.denied = status;
    for (const action of [
      () => createSpotlightAction(form()),
      () => updateSpotlightAction("missing", { ...form(), revision: 0 }),
      () => deleteSpotlightAction("missing"),
      () => approveSpotlightSubmissionAction("missing", 0),
    ]) {
      const execution = await finish<ActionResult<unknown>>(action);
      expect(execution.response.status).toBe(200);
      expect(execution.result.error?.code).toBe(status === 401 ? "unauthorized" : "forbidden");
      expect(execution.background).toHaveLength(0);
    }
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("入力エラー・競合・不存在・承認失敗と別リクエストの読み取りは配送を登録しない", async () => {
    const success = await finish(() => createSpotlightAction(form()));
    bindingFetch.mockClear();
    const id = success.result.data!.id;
    for (const action of [
      () => createSpotlightAction({ ...form(), companyName: "" }),
      () => updateSpotlightAction(id, { ...form(), revision: 10 }),
      () => deleteSpotlightAction("missing"),
      () => approveSpotlightSubmissionAction("missing", 0),
    ]) {
      const execution = await finish<ActionResult<unknown>>(action);
      expect(execution.result.error).toBeTruthy();
      expect(execution.background).toHaveLength(0);
    }
    const read = await finish(() => listSpotlights(db));
    expect(read.background).toHaveLength(0);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("申請却下と無関係な保存は、待機中outboxがあっても配送を登録しない", async () => {
    await createSpotlight(db, staff, form());
    const pending = await pendingSubmission();
    const rejected = await finish(() => rejectSpotlightSubmissionAction(pending.id, 0));
    const unrelated = await finish(() => createNoticeAction({ title: "お知らせ", body: null, imageMediaId: null, qrUrl: null, enabled: true, displayMode: "always" }));
    expect(rejected.result).toHaveProperty("data");
    expect(unrelated.result).toHaveProperty("data");
    expect(rejected.background).toHaveLength(0);
    expect(unrelated.background).toHaveLength(0);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("URLなしの保存は外部配送を発生させない", async () => {
    expect((await finish(() => createSpotlightAction(form(null)))).result).toHaveProperty("data");
    expect(await db.select().from(companyResearchOutbox)).toHaveLength(0);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("response後のDB取得・配送の失敗も保存成功を変えず、outboxを残す", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const execution = await request(() => createSpotlightAction(form()));
    // A DB failure after the transaction committed, before the background claim.
    state.db = null as unknown as Db;
    expect(await execution.response.json()).toHaveProperty("data");
    await Promise.all(execution.background);
    expect(log).toHaveBeenCalledWith("[after-save] Research delivery failed; the durable outbox remains available for retry");
    state.db = db;
    bindingFetch.mockRejectedValue(new Error("private downstream details"));
    const retried = await finish(() => updateSpotlightAction(execution.result.data!.id, { ...form(), revision: 0 }));
    expect(retried.result).toHaveProperty("data");
    expect((await db.select().from(companyResearchOutbox)).every((row) => row.status === "pending")).toBe(true);
  });

  it("afterのrequest scopeが使えなくても保存成功を保ち、失敗したtransactionからは登録しない", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createSpotlightAction(form())).toHaveProperty("data");
    expect(log).toHaveBeenCalledWith("[after-save] Research scheduling unavailable; the durable outbox remains available for retry");
    const background: Promise<unknown>[] = [];
    const ctx = createRequestContext({ executionContext: { waitUntil: (promise) => { background.push(promise); } } });
    await db.run(sql`CREATE TRIGGER reject_research BEFORE INSERT ON company_research_outbox BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    await expect(runWithRequestContext(ctx, () => createSpotlightAction(form()))).rejects.toThrow();
    expect(background).toHaveLength(0);
    expect(await db.select().from(memberSpotlights)).toHaveLength(1);
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});
