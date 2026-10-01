import { env } from "cloudflare:workers";
import type { InStatement } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { media, memberSpotlights, memberSpotlightSubmissions, users } from "../../db/schema";
import type { AuthUser } from "../../lib/auth";
import { approveSpotlightSubmission, cleanupSpotlightSubmissions, countPendingSpotlightSubmissions, getSpotlightSubmissionImage, listSpotlightSubmissions, rejectSpotlightSubmission, submitSpotlightSubmission } from "../../lib/services/spotlight-submissions";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

let db: Db;
let close: () => void;
let bucket: SpotlightBucket;
const jpeg = { bytes: new Uint8Array([255, 216, 255, 224, 1, 2, 3]), mimeType: "image/jpeg" };
const input = () => ({ requestKey: crypto.randomUUID(), companyName: "所属", personName: "名前", email: "member@example.com", consent: true });
const staff: AuthUser = { id: "staff", email: "staff@example.com", name: "Staff", role: "staff" };
beforeEach(async () => {
  ({ db, close } = await openTempDb()); bucket = new SpotlightBucket();
  env.RESEND_API_KEY = "test-resend-key";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
});
afterEach(() => { env.RESEND_API_KEY = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); close(); });

describe("本人申請の受付", () => {
  it("メールは専用列だけに保存し、受付では送信せず公開テーブルに入れない", async () => {
    expect(await submitSpotlightSubmission(db, bucket, input(), {})).toEqual({ accepted: true });
    expect(await db.select().from(memberSpotlightSubmissions)).toMatchObject([{ status: "pending", revision: 0, consentVersion: 3, contactEmail: "member@example.com", notificationStatus: null }]);
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
    expect(await db.select().from(media)).toHaveLength(0);
    expect(JSON.stringify((await db.select().from(memberSpotlightSubmissions))[0].payload)).not.toContain("member@example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("画像保存より先にキーを記録し、写真とロゴの両方を条件付き保存する", async () => {
    const put = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementation(async (key, bytes, options) => {
      const [row] = await db.select().from(memberSpotlightSubmissions);
      expect(row.status).toBe("receiving");
      expect([row.photoFile?.r2Key, row.logoFile?.r2Key]).toContain(key);
      return put(key, bytes, options);
    });
    await submitSpotlightSubmission(db, bucket, input(), { photo: jpeg, logo: jpeg });
    expect(bucket.putCalls).toHaveLength(2);
    expect(bucket.putCalls.every((call) => call.options?.onlyIf?.etagDoesNotMatch === "*")).toBe(true);
    const [row] = await db.select().from(memberSpotlightSubmissions);
    expect(row.photoFile).toMatchObject({ size: 7, mimeType: "image/jpeg" });
    expect(row.photoFile?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("同じ送信を並列・応答喪失後に再送しても1件だけになる", async () => {
    const data = input();
    const result = await Promise.all([submitSpotlightSubmission(db, bucket, data, { photo: jpeg }), submitSpotlightSubmission(db, bucket, data, { photo: jpeg })]);
    expect(result).toEqual([{ accepted: true }, { accepted: true }]);
    const count = bucket.putCalls.length;
    await submitSpotlightSubmission(db, bucket, data, { photo: jpeg });
    expect(bucket.putCalls).toHaveLength(count);
    expect(await db.select().from(memberSpotlightSubmissions)).toHaveLength(1);
  });

  it("同じkeyで文面・画像・メールアドレスが変われば409", async () => {
    const data = input();
    await submitSpotlightSubmission(db, bucket, data, { photo: jpeg });
    await expect(submitSpotlightSubmission(db, bucket, { ...data, personName: "別人" }, { photo: jpeg })).rejects.toMatchObject({ status: 409 });
    await expect(submitSpotlightSubmission(db, bucket, data, {})).rejects.toMatchObject({ status: 409 });
    await expect(submitSpotlightSubmission(db, bucket, { ...data, email: "other@example.com" }, { photo: jpeg })).rejects.toMatchObject({ status: 409 });
  });

  it("保存途中の失敗後は同じ画像を再利用して不足ファイルを保存できる", async () => {
    const data = input();
    const put = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementation(async (key, bytes, options) => {
      if (key.endsWith("/logo")) throw new Error("unavailable");
      return put(key, bytes, options);
    });
    await expect(submitSpotlightSubmission(db, bucket, data, { photo: jpeg, logo: jpeg })).rejects.toMatchObject({ status: 503 });
    expect((await db.select().from(memberSpotlightSubmissions))[0].status).toBe("receiving");
    expect(bucket.objects.size).toBe(1);
    vi.restoreAllMocks();
    await submitSpotlightSubmission(db, bucket, data, { photo: jpeg, logo: jpeg });
    expect(bucket.objects.size).toBe(2);
    expect((await db.select().from(memberSpotlightSubmissions))[0].status).toBe("pending");
  });

  it("期限切れは410、却下や承認済みは同じ一般応答を返して新規保存しない", async () => {
    const data = input();
    await submitSpotlightSubmission(db, bucket, data, {});
    for (const status of ["approved", "rejected"] as const) {
      await db.update(memberSpotlightSubmissions).set({ status });
      expect(await submitSpotlightSubmission(db, bucket, data, {})).toEqual({ accepted: true });
    }
    await db.update(memberSpotlightSubmissions).set({ status: "expired" });
    await expect(submitSpotlightSubmission(db, bucket, data, {})).rejects.toMatchObject({ status: 410 });
  });

  it("空マーカーを画像として再利用しない", async () => {
    const data = input();
    await submitSpotlightSubmission(db, bucket, data, { photo: jpeg });
    const [row] = await db.select().from(memberSpotlightSubmissions);
    await db.update(memberSpotlightSubmissions).set({ status: "receiving" }).where(eq(memberSpotlightSubmissions.id, row.id));
    bucket.objects.set(row.photoFile!.r2Key, new Uint8Array());
    await expect(submitSpotlightSubmission(db, bucket, data, { photo: jpeg })).rejects.toMatchObject({ status: 503 });
    expect(bucket.objects.get(row.photoFile!.r2Key)).toHaveLength(0);
  });

  it("不正画像・未同意はDB/R2を書き込まない", async () => {
    await expect(submitSpotlightSubmission(db, bucket, { ...input(), consent: false }, {})).rejects.toMatchObject({ status: 400 });
    await expect(submitSpotlightSubmission(db, bucket, input(), { photo: { ...jpeg, mimeType: "image/png" } })).rejects.toMatchObject({ status: 415 });
    expect(await db.select().from(memberSpotlightSubmissions)).toHaveLength(0);
    expect(bucket.putCalls).toHaveLength(0);
  });
});

describe("申請画像の回収", () => {
  const DAY = 24 * 60 * 60;
  beforeEach(async () => { await db.insert(users).values(staff); });

  async function rejected() {
    await submitSpotlightSubmission(db, bucket, input(), { photo: jpeg, logo: jpeg }, 100);
    const [row] = await db.select().from(memberSpotlightSubmissions);
    await rejectSpotlightSubmission(db, staff, row.id, 0);
    await db.update(memberSpotlightSubmissions).set({ cleanupNextAt: 100 }).where(eq(memberSpotlightSubmissions.id, row.id));
    return row;
  }

  it("古いreceivingを取得した直後に同じ申請の受信が再開したら期限切れにしない", async () => {
    const data = input();
    vi.spyOn(bucket, "put").mockRejectedValue(new Error("temporary failure"));
    await expect(submitSpotlightSubmission(db, bucket, data, { photo: jpeg }, 100)).rejects.toMatchObject({ status: 503 });
    const select = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementationOnce((fields) => {
      const builder = select(fields);
      const from = builder.from.bind(builder);
      vi.spyOn(builder, "from").mockImplementationOnce((table) => {
        const query = from(table);
        const all = query.all.bind(query);
        vi.spyOn(query, "all").mockImplementationOnce(async () => {
          const snapshot = await all();
          await expect(submitSpotlightSubmission(db, bucket, data, { photo: jpeg }, 100 + DAY)).rejects.toMatchObject({ status: 503 });
          return snapshot;
        });
        return query;
      });
      return builder;
    });
    expect(await cleanupSpotlightSubmissions(db, bucket, 100 + DAY)).toEqual({ expired: 0, completed: 0, failed: 0 });
    expect((await db.select().from(memberSpotlightSubmissions))[0]).toMatchObject({ status: "receiving", updatedAt: 100 + DAY, cleanupNextAt: null });
  });

  it("却下画像を空マーカーに置換し、回収完了後はR2へ再アクセスしない", async () => {
    const row = await rejected();
    expect(await cleanupSpotlightSubmissions(db, bucket, 200)).toEqual({ expired: 0, completed: 1, failed: 0 });
    expect(bucket.objects.get(row.photoFile!.r2Key)).toHaveLength(0);
    expect(bucket.objects.get(row.logoFile!.r2Key)).toHaveLength(0);
    expect((await db.select().from(memberSpotlightSubmissions))[0]).toMatchObject({ payload: null, cleanupNextAt: null, cleanupCompletedAt: 200, photoFile: row.photoFile });
    const calls = bucket.putCalls.length;
    expect(await cleanupSpotlightSubmissions(db, bucket, 200 + DAY)).toEqual({ expired: 0, completed: 0, failed: 0 });
    expect(bucket.putCalls).toHaveLength(calls);
  });

  it("24時間の受信中は期限切れへ移し、画像なしも完了にする。pending/approvedは保護する", async () => {
    await submitSpotlightSubmission(db, bucket, input(), {}, 100);
    const [row] = await db.select().from(memberSpotlightSubmissions);
    await db.update(memberSpotlightSubmissions).set({ status: "receiving" }).where(eq(memberSpotlightSubmissions.id, row.id));
    await submitSpotlightSubmission(db, bucket, input(), { photo: jpeg }, 100);
    await submitSpotlightSubmission(db, bucket, input(), { photo: jpeg }, 100);
    const pending = (await db.select().from(memberSpotlightSubmissions)).filter((candidate) => candidate.status === "pending");
    await approveSpotlightSubmission(db, bucket, staff, pending[1].id, 0);
    expect(await cleanupSpotlightSubmissions(db, bucket, 100 + DAY)).toEqual({ expired: 1, completed: 1, failed: 0 });
    expect((await db.select().from(memberSpotlightSubmissions)).find((candidate) => candidate.id === row.id)).toMatchObject({ status: "expired", cleanupCompletedAt: 100 + DAY });
    expect([...bucket.objects.values()].every((bytes) => bytes.length === jpeg.bytes.length)).toBe(true);
  });

  it("期限切れの走査と回収はそれぞれ50件までで後続へ繰り越す", async () => {
    const payload = { companyName: "所属", personName: "名前", personNameKana: null, role: null, quote: null, bio: null, tags: [] };
    await db.insert(memberSpotlightSubmissions).values(Array.from({ length: 51 }, (_, i) => ({ id: `receiving-${i}`, requestKey: `receiving-${i}`, requestFingerprint: "a", payload, consentedAt: 100, consentVersion: 1, createdAt: 100, updatedAt: 100 })));
    expect(await cleanupSpotlightSubmissions(db, bucket, 100 + DAY)).toEqual({ expired: 50, completed: 50, failed: 0 });
    expect(await cleanupSpotlightSubmissions(db, bucket, 100 + DAY)).toEqual({ expired: 1, completed: 1, failed: 0 });
  });

  it("回収済み1万件があっても実際の回収クエリは未回収用の部分索引を使う", async () => {
    await db.run(sql`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000)
      INSERT INTO member_spotlight_submissions (id, request_key, request_fingerprint, status, consented_at, consent_version, created_at, updated_at, cleanup_completed_at)
      SELECT 'done-' || n, 'done-' || n, 'hash', 'rejected', 1, 1, 1, 1, 100 FROM sequence`);
    await db.insert(memberSpotlightSubmissions).values({ id: "due", requestKey: "due", requestFingerprint: "hash", status: "expired", consentedAt: 1, consentVersion: 1, cleanupNextAt: 100 });
    await db.run(sql`ANALYZE`);
    const execute = vi.spyOn(db.$client, "execute");
    expect(await cleanupSpotlightSubmissions(db, bucket, 200)).toEqual({ expired: 0, completed: 1, failed: 0 });
    const statements: InStatement[] = execute.mock.calls.map(([statement]) => statement);
    const statement = statements.find((statement) => typeof statement !== "string" && statement.sql.startsWith("select ") && statement.sql.includes('"cleanup_completed_at" is null') && statement.sql.includes("order by"));
    if (!statement || typeof statement === "string") throw new Error("回収クエリが実行されていません");
    const plan = await db.$client.execute({ ...statement, sql: `EXPLAIN QUERY PLAN ${statement.sql}` });
    expect(plan.rows.map((row) => row.detail).join("\n")).toContain("USING INDEX member_spotlight_submissions_cleanup_idx");
  });

  it("途中失敗は翌日に回して後続を処理し、全キー成功するまでpayloadを残す", async () => {
    const row = await rejected();
    bucket.failKeys.add(row.logoFile!.r2Key);
    await db.insert(memberSpotlightSubmissions).values({ id: "after", requestKey: "after", requestFingerprint: "a", status: "expired", payload: row.payload, consentedAt: 100, consentVersion: 1, cleanupNextAt: 101 });
    expect(await cleanupSpotlightSubmissions(db, bucket, 200)).toEqual({ expired: 0, completed: 1, failed: 1 });
    expect((await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, row.id)))[0]).toMatchObject({ cleanupNextAt: 200 + DAY, cleanupCompletedAt: null, payload: row.payload });
    bucket.failKeys.clear();
    expect(await cleanupSpotlightSubmissions(db, bucket, 200 + DAY)).toEqual({ expired: 0, completed: 1, failed: 0 });
  });

  it("mediaが同じキーを参照していたら回収を完了せず保護する", async () => {
    const row = await rejected();
    await db.insert(media).values({ name: "protected", type: "image", r2Key: row.photoFile!.r2Key });
    expect(await cleanupSpotlightSubmissions(db, bucket, 200)).toEqual({ expired: 0, completed: 0, failed: 1 });
    expect(bucket.objects.get(row.photoFile!.r2Key)).toHaveLength(7);
  });

  it("マーカー完了後にDB完了更新が失敗しても追跡情報を残して再試行する", async () => {
    const row = await rejected();
    await db.run(sql`CREATE TRIGGER fail_cleanup_completion BEFORE UPDATE OF cleanup_completed_at ON member_spotlight_submissions WHEN NEW.cleanup_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'completion failed'); END`);
    expect(await cleanupSpotlightSubmissions(db, bucket, 200)).toEqual({ expired: 0, completed: 0, failed: 1 });
    expect((await db.select().from(memberSpotlightSubmissions))[0]).toMatchObject({ cleanupCompletedAt: null, payload: row.payload });
    await db.run(sql`DROP TRIGGER fail_cleanup_completion`);
    expect(await cleanupSpotlightSubmissions(db, bucket, 200 + DAY)).toEqual({ expired: 0, completed: 1, failed: 0 });
  });

  it("遅延putより先に回収が完了しても画像は復活しない", async () => {
    const data = input();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const put = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementation(async (key, bytes, options) => {
      if (options?.onlyIf) { entered(); await paused; }
      return put(key, bytes, options);
    });
    const sending = submitSpotlightSubmission(db, bucket, data, { photo: jpeg }, 100);
    const rejectedSend = expect(sending).rejects.toMatchObject({ status: 410 });
    await reached;
    expect(await cleanupSpotlightSubmissions(db, bucket, 100 + DAY)).toEqual({ expired: 1, completed: 1, failed: 0 });
    release();
    await rejectedSend;
    expect([...bucket.objects.values()]).toEqual([new Uint8Array()]);
    expect((await db.select().from(memberSpotlightSubmissions))[0].status).toBe("expired");
  });

  it("画像put成功後、pending更新前に期限切れ回収したら410で終わり画像を復活させない", async () => {
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const stored = new Promise<void>((resolve) => { entered = resolve; });
    const put = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementation(async (key, bytes, options) => {
      const result = await put(key, bytes, options);
      if (options?.onlyIf) { entered(); await paused; }
      return result;
    });
    const sending = submitSpotlightSubmission(db, bucket, input(), { photo: jpeg }, 100);
    const expiredSend = expect(sending).rejects.toMatchObject({ status: 410 });
    await stored;
    expect([...bucket.objects.values()]).toEqual([jpeg.bytes]);
    expect(await cleanupSpotlightSubmissions(db, bucket, 100 + DAY)).toEqual({ expired: 1, completed: 1, failed: 0 });
    release();
    await expiredSend;
    expect([...bucket.objects.values()]).toEqual([new Uint8Array()]);
    expect((await db.select().from(memberSpotlightSubmissions))[0]).toMatchObject({ status: "expired", cleanupCompletedAt: 100 + DAY });
  });
});

describe("スタッフによる申請の審査", () => {
  beforeEach(async () => { await db.insert(users).values(staff); });
  async function pending() {
    await submitSpotlightSubmission(db, bucket, input(), { photo: jpeg, logo: jpeg }, 100);
    return (await db.select().from(memberSpotlightSubmissions))[0];
  }

  it("一覧はpendingだけ、Staff専用画像URLを持つDTOで古い順に返す", async () => {
    const row = await pending();
    const details = await listSpotlightSubmissions(db, staff);
    expect(details).toEqual([{ id: row.id, companyName: "所属", personName: "名前", submittedAt: 100, revision: 0, payload: row.payload, consentedAt: 100, consentVersion: 3, contactEmail: "member@example.com", photoUrl: `/api/spotlight-submissions/${row.id}/images/photo`, logoUrl: `/api/spotlight-submissions/${row.id}/images/logo` }]);
    const image = await getSpotlightSubmissionImage(db, bucket, staff, row.id, "photo");
    expect(image.file.mimeType).toBe("image/jpeg");
    expect(new Uint8Array(await image.object.arrayBuffer())).toEqual(jpeg.bytes);
    await rejectSpotlightSubmission(db, staff, row.id, 0);
    expect(await listSpotlightSubmissions(db, staff)).toEqual([]);
    await expect(getSpotlightSubmissionImage(db, bucket, staff, row.id, "photo")).rejects.toMatchObject({ status: 404 });
  });

  it("ベル用の確認待ち件数はpendingだけを数える", async () => {
    expect(await countPendingSpotlightSubmissions(db, staff)).toBe(0);
    const first = await pending();
    await pending();
    expect(await countPendingSpotlightSubmissions(db, staff)).toBe(2);
    await approveSpotlightSubmission(db, bucket, staff, first.id, 0);
    expect(await countPendingSpotlightSubmissions(db, staff)).toBe(1);
  });

  it("承認で画像2件と紹介1件を作り、古いrevisionでの承認再送も増殖しない", async () => {
    const row = await pending();
    const result = await approveSpotlightSubmission(db, bucket, staff, row.id, 0);
    expect(await approveSpotlightSubmission(db, bucket, staff, row.id, 999)).toEqual(result);
    const [spotlight] = await db.select().from(memberSpotlights);
    expect(spotlight).toMatchObject({ id: result.spotlightId, companyName: "所属", personName: "名前", enabled: true });
    // 申請のアドレスを掲載メンバーに引き継ぐ（管理画面で見るだけ）
    expect(spotlight.contactEmail).toBe("member@example.com");
    const images = await db.select().from(media);
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.r2Key).sort()).toEqual([row.logoFile!.r2Key, row.photoFile!.r2Key].sort());
    expect(images.every((image) => image.fileSize === 7 && image.sha256?.length === 64 && image.width === null && image.state === "active")).toBe(true);
    // 文面は紹介へ写したので申請側には残さない。再送判定用のfingerprintと同意日時は残す
    expect((await db.select().from(memberSpotlightSubmissions))[0]).toMatchObject({ status: "approved", revision: 1, reviewedBy: "staff", approvedSpotlightId: result.spotlightId, payload: null, requestFingerprint: row.requestFingerprint, consentedAt: 100 });
    await db.delete(memberSpotlights).where(eq(memberSpotlights.id, result.spotlightId!));
    expect(await approveSpotlightSubmission(db, bucket, staff, row.id, 0)).toEqual({ spotlightId: null, notificationStatus: "sent" });
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
  });

  it("pendingの古いrevisionは409、却下再送は成功、却下後承認は409", async () => {
    const row = await pending();
    await expect(approveSpotlightSubmission(db, bucket, staff, row.id, 1)).rejects.toMatchObject({ status: 409 });
    await expect(rejectSpotlightSubmission(db, staff, row.id, 1)).rejects.toMatchObject({ status: 409 });
    expect(await rejectSpotlightSubmission(db, staff, row.id, 0)).toEqual({ notificationStatus: "sent" });
    expect(await rejectSpotlightSubmission(db, staff, row.id, 999)).toEqual({ notificationStatus: "sent" });
    await expect(approveSpotlightSubmission(db, bucket, staff, row.id, 0)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
  });

  it("同時承認は1件だけ掲載し、承認と却下では片方だけ確定する", async () => {
    const row = await pending();
    const approvals = await Promise.all([approveSpotlightSubmission(db, bucket, staff, row.id, 0), approveSpotlightSubmission(db, bucket, staff, row.id, 0)]);
    expect(approvals[0].spotlightId).toEqual(approvals[1].spotlightId);
    expect(await db.select().from(memberSpotlights)).toHaveLength(1);
    await submitSpotlightSubmission(db, bucket, input(), {});
    const second = (await db.select().from(memberSpotlightSubmissions)).find((candidate) => candidate.status === "pending")!;
    const outcomes = await Promise.allSettled([approveSpotlightSubmission(db, bucket, staff, second.id, 0), rejectSpotlightSubmission(db, staff, second.id, 0)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { status: 409 } }]);
  });

  it("画像欠落やサイズ不一致では部分掲載しない", async () => {
    const row = await pending();
    bucket.objects.set(row.photoFile!.r2Key, new Uint8Array());
    // スタッフには本人向けの「送信結果を確認」ではなく、画像を読めなかったことを伝える
    await expect(approveSpotlightSubmission(db, bucket, staff, row.id, 0)).rejects.toMatchObject({ status: 503, message: "申請の画像を読み込めませんでした。時間をおいてもう一度お試しください" });
    expect(await db.select().from(media)).toHaveLength(0);
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
    expect((await db.select().from(memberSpotlightSubmissions))[0].status).toBe("pending");
  });

  it("DB挿入途中の失敗は素材・紹介・承認を全部rollbackする", async () => {
    const row = await pending();
    await db.run(sql`CREATE TRIGGER reject_spotlight_insert BEFORE INSERT ON member_spotlights BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END`);
    await expect(approveSpotlightSubmission(db, bucket, staff, row.id, 0)).rejects.toThrow();
    expect(await db.select().from(media)).toHaveLength(0);
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
    expect((await db.select().from(memberSpotlightSubmissions))[0]).toMatchObject({ status: "pending", revision: 0, reviewedAt: null });
    expect(bucket.objects.size).toBe(2);
  });
});
