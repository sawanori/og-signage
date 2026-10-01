import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { memberSpotlightSubmissions, users } from "../../db/schema";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, bucket: null as unknown as SpotlightBucket, session: null as unknown }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/r2", async (original) => ({ ...await original<typeof import("../../lib/r2")>(), getMediaBucket: () => state.bucket }));
vi.mock("../../lib/auth", async (original) => {
  const actual = await original<typeof import("../../lib/auth")>();
  const deps = () => ({ db: state.db, getSession: async () => state.session });
  return { ...actual, requireRole: (role: "staff" | "administrator") => actual.requireRole(role, deps()), withRole: <C>(role: "staff" | "administrator", handler: (request: Request, context: C, user: import("../../lib/auth").AuthUser) => Promise<Response>) => actual.withRole(role, handler, deps) };
});
const { POST } = await import("../../app/api/spotlight-submissions/route");
const { GET } = await import("../../app/api/spotlight-submissions/[id]/images/[kind]/route");
const { approveSpotlightSubmissionAction, rejectSpotlightSubmissionAction } = await import("../../app/admin/_actions/spotlight-submissions");
const BASE = "https://signage.example.com";
let close: () => void;
const data = () => ({ requestKey: crypto.randomUUID(), companyName: "所属", personName: "名前", email: "member@example.com", consent: true });
const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
function form(value: unknown = data(), photo = true) {
  const body = new FormData();
  body.append("data", JSON.stringify(value));
  if (photo) body.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
  return body;
}
function request(body: BodyInit = form(), headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/spotlight-submissions`, { method: "POST", headers: { origin: BASE, "cf-connecting-ip": "192.0.2.1", ...headers }, body });
}
beforeEach(async () => {
  const opened = await openTempDb();
  state.db = opened.db; close = opened.close; state.bucket = new SpotlightBucket(); state.session = null;
  await state.db.insert(users).values({ id: "staff", email: "staff@example.com", role: "staff" });
});
afterEach(() => { vi.restoreAllMocks(); close(); });

describe("匿名の申請POST", () => {
  it("ログインなしで画像を保存し一般的な202だけを返す", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("受付時には送信しない"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { accepted: true } });
    expect((await state.db.select().from(memberSpotlightSubmissions))[0].status).toBe("pending");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("古い画面のメール無し申請は400で再読み込みを案内する", async () => {
    const value: Record<string, unknown> = data();
    delete value.email;
    const response = await POST(request(form(value)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_input", message: "メールアドレスを入力してください。画面を読み込み直してください" } });
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
  });
  it("メールの形式不正は値を漏らさず400、同じキーで宛先だけ変更すると409", async () => {
    const invalid = "private-invalid-address";
    const response = await POST(request(form({ ...data(), email: invalid })));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(invalid);
    const value = data();
    expect((await POST(request(form(value)))).status).toBe(202);
    const conflict = await POST(request(form({ ...value, email: "other@example.com" })));
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("@example.com");
  });
  it("他Originは保存もrate limitも呼ぶ前に403", async () => {
    const limiter = vi.spyOn(env.SPOTLIGHT_SUBMISSION_RATE_LIMITER, "limit");
    expect((await POST(request(form(), { origin: "https://other.example.com" }))).status).toBe(403);
    expect(limiter).not.toHaveBeenCalled();
    expect(state.bucket.putCalls).toHaveLength(0);
  });
  it("専用レート制限は本文を読む前に429と60秒を返す", async () => {
    const limiter = vi.spyOn(env.SPOTLIGHT_SUBMISSION_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    const req = request();
    const response = await POST(req);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(req.bodyUsed).toBe(false);
    expect(limiter).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
  });
  it.each([undefined, "1"])("Content-Lengthなし/偽装でも実ストリーム5MiB超を拒否（%s）", async (length) => {
    const headers = { "content-type": "multipart/form-data; boundary=test", ...(length ? { "content-length": length } : {}) };
    const response = await POST(request(new Uint8Array(5 * 1024 * 1024 + 1), headers));
    expect(response.status).toBe(413);
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
    expect(state.bucket.putCalls).toHaveLength(0);
  });
  it("Content-Length超過はストリームを読む前に413", async () => {
    const req = request(form(), { "content-length": String(5 * 1024 * 1024 + 1) });
    expect((await POST(req)).status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });
  it.each(["data", "photo", "extra"])("重複/余分フィールド%sを拒否", async (field) => {
    const body = form(); body.append(field, "unexpected");
    expect((await POST(request(body))).status).toBe(400);
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
  });
  it("不正JSON、10KiB超data、未同意、管理項目混入を保存前に拒否", async () => {
    const invalid = form(); invalid.set("data", "{");
    expect((await POST(request(invalid))).status).toBe(400);
    const large = form(); large.set("data", " ".repeat(10 * 1024 + 1));
    expect((await POST(request(large))).status).toBe(413);
    expect((await POST(request(form({ ...data(), consent: false })))).status).toBe(400);
    expect((await POST(request(form({ ...data(), enabled: true })))).status).toBe(400);
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
  });
  it("画像各2MiB超・形式偽装・空画像は保存前に拒否", async () => {
    for (const [bytes, type, status] of [[new Uint8Array(2 * 1024 * 1024 + 1), "image/jpeg", 413], [jpeg, "image/png", 415], [new Uint8Array(), "image/jpeg", 415]] as const) {
      const body = form(); body.set("photo", new Blob([bytes], { type }), "photo");
      expect((await POST(request(body))).status).toBe(status);
    }
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
  });
  it("data10KiB・画像2MiB・multipart5MiBは上限ちょうどなら受け付ける", async () => {
    const body = form();
    const json = String(body.get("data"));
    body.set("data", json + " ".repeat(10 * 1024 - new TextEncoder().encode(json).length));
    const image = new Uint8Array(2 * 1024 * 1024); image.set(jpeg);
    body.set("photo", new Blob([image], { type: "image/jpeg" }), "photo.jpg");
    let encoded = request(body);
    let content = new Uint8Array(await encoded.arrayBuffer());
    if (content.length % 2 !== 0) {
      body.set("photo", new Blob([image], { type: "image/jpeg" }), "photo0.jpg");
      encoded = request(body);
      content = new Uint8Array(await encoded.arrayBuffer());
    }
    const bytes = new Uint8Array(5 * 1024 * 1024);
    bytes.set(content);
    // 正しいmultipartの末尾CRLFを増やして、フィールド制限内のまま受信上限へ合わせる。
    for (let offset = content.length; offset < bytes.length; offset += 2) { bytes[offset] = 13; bytes[offset + 1] = 10; }
    const response = await POST(request(bytes, { "content-type": encoded.headers.get("content-type")! }));
    expect(response.status).toBe(202);
    expect((await state.db.select().from(memberSpotlightSubmissions))[0].photoFile?.size).toBe(2 * 1024 * 1024);
  });
  it.each([
    ["SVG", new TextEncoder().encode("<svg></svg>"), "image/svg+xml"],
    ["動画", new Uint8Array([0, 0, 0, 20, ...new TextEncoder().encode("ftypisom")]), "video/mp4"],
    ["WebPと称したJPEG", jpeg, "image/webp"],
  ] as const)("%sは415で保存しない", async (_name, bytes, mimeType) => {
    const body = form();
    body.set("photo", new Blob([bytes], { type: mimeType }), "image");
    expect((await POST(request(body))).status).toBe(415);
    expect(await state.db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
    expect(state.bucket.putCalls).toHaveLength(0);
  });
  it("保存後のR2失敗は503で成功にはしない", async () => {
    vi.spyOn(state.bucket, "put").mockRejectedValue(new Error("storage failure"));
    expect((await POST(request())).status).toBe(503);
    expect((await state.db.select().from(memberSpotlightSubmissions))[0].status).toBe("receiving");
  });
  it("画像保存後のDB更新失敗は503で、同じkeyの再送が既存画像を使って再開する", async () => {
    const value = data();
    await state.db.run(sql`CREATE TRIGGER fail_submission_complete BEFORE UPDATE OF status ON member_spotlight_submissions WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'completion failed'); END`);
    expect((await POST(request(form(value)))).status).toBe(503);
    expect(state.bucket.objects.size).toBe(1);
    expect((await state.db.select().from(memberSpotlightSubmissions))[0].status).toBe("receiving");
    await state.db.run(sql`DROP TRIGGER fail_submission_complete`);
    expect((await POST(request(form(value)))).status).toBe(202);
    expect(await state.db.select().from(memberSpotlightSubmissions)).toMatchObject([{ status: "pending" }]);
    expect(state.bucket.objects.size).toBe(1);
  });
});

describe("Staff認証付き画像とActions", () => {
  it("未存在・kind不正・添付なしの申請画像は404", async () => {
    await POST(request());
    const [row] = await state.db.select().from(memberSpotlightSubmissions);
    state.session = { userId: "staff", sessionVersion: 0 };
    for (const params of [{ id: "missing", kind: "photo" }, { id: row.id, kind: "invalid" }, { id: row.id, kind: "logo" }]) {
      expect((await GET(new Request(`${BASE}/image`), { params: Promise.resolve(params) })).status).toBe(404);
    }
  });
  it.each(["staff", "administrator"] as const)("%sは両審査Actionを使用でき、失効sessionVersionでは拒否される", async (role) => {
    await state.db.update(users).set({ role }).where(eq(users.id, "staff"));
    for (const action of [approveSpotlightSubmissionAction, rejectSpotlightSubmissionAction]) {
      await POST(request(form(data(), false)));
      const rows = await state.db.select().from(memberSpotlightSubmissions);
      const row = rows.find((candidate) => candidate.status === "pending")!;
      state.session = { userId: "staff", sessionVersion: 99 };
      expect(await action(row.id, 0)).toMatchObject({ error: { code: "unauthorized" } });
      state.session = { userId: "staff", sessionVersion: 0 };
      expect(await action(row.id, 0)).toHaveProperty("data");
    }
  });
  it("未ログイン・無効化したStaffを画像/承認/却下で拒否する", async () => {
    await POST(request());
    const [row] = await state.db.select().from(memberSpotlightSubmissions);
    const context = { params: Promise.resolve({ id: row.id, kind: "photo" }) };
    expect((await GET(new Request(`${BASE}/image`), context)).status).toBe(401);
    expect(await approveSpotlightSubmissionAction(row.id, 0)).toMatchObject({ error: { code: "unauthorized" } });
    state.session = { userId: "staff", sessionVersion: 0 };
    await state.db.update(users).set({ isActive: false }).where(eq(users.id, "staff"));
    expect((await GET(new Request(`${BASE}/image`), context)).status).toBe(401);
    expect(await rejectSpotlightSubmissionAction(row.id, 0)).toMatchObject({ error: { code: "unauthorized" } });
    expect((await state.db.select().from(memberSpotlightSubmissions))[0].status).toBe("pending");
  });
  it("Staffは非公開画像を確認し承認でき、承認後の申請画像は404", async () => {
    await POST(request());
    const [row] = await state.db.select().from(memberSpotlightSubmissions);
    state.session = { userId: "staff", sessionVersion: 0 };
    const context = { params: Promise.resolve({ id: row.id, kind: "photo" }) };
    const image = await GET(new Request(`${BASE}/image`), context);
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(await approveSpotlightSubmissionAction(row.id, 0)).toMatchObject({ data: { spotlightId: expect.any(String) } });
    expect((await GET(new Request(`${BASE}/image`), context)).status).toBe(404);
  });
});
