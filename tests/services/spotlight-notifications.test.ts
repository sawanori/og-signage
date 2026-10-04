import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { memberSpotlights, memberSpotlightSubmissions, users } from "../../db/schema";
import type { AuthUser } from "../../lib/auth";
import { notifySpotlightSubmission, retrySpotlightNotifications } from "../../lib/services/spotlight-notifications";
import { approveSpotlightSubmission, cleanupSpotlightSubmissions, listSpotlightSubmissions, rejectSpotlightSubmission, submitSpotlightSubmission } from "../../lib/services/spotlight-submissions";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

let db: Db;
let close: () => void;
let bucket: SpotlightBucket;
const fetchMock = vi.fn<typeof fetch>();
const staff: AuthUser = { id: "staff", email: "staff@example.com", name: "Staff", role: "staff" };
const NOW = 1_800_000_000;
const HALF_HOUR = 30 * 60;
const WEEK = 7 * 24 * 60 * 60;
const email = "member@example.com";
const name = "山田 <>&\"'";

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  bucket = new SpotlightBucket();
  await db.insert(users).values(staff);
  env.RESEND_API_KEY = "test-secret-key";
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
});
afterEach(() => { env.RESEND_API_KEY = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); close(); });

async function pending() {
  await submitSpotlightSubmission(db, bucket, { requestKey: crypto.randomUUID(), companyName: "所属", personName: name, email, consent: true }, {});
  return (await db.select().from(memberSpotlightSubmissions))[0];
}

async function stored(id: string) {
  return (await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id)))[0];
}

async function notification(id: string, overrides: Partial<typeof memberSpotlightSubmissions.$inferInsert> = {}) {
  await db.insert(memberSpotlightSubmissions).values({
    id, requestKey: id, requestFingerprint: "hash", consentedAt: NOW, consentVersion: 2,
    status: "approved", reviewedAt: NOW, contactEmail: email, notificationStatus: "pending", notificationName: name, notificationNextAt: NOW,
    ...overrides,
  });
}

describe("審査結果のメール通知", () => {
  it.each(["approved", "rejected"] as const)("%sの確定後に日本語メールを送り、宛先と宛名を消す", async (status) => {
    const row = await pending();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async () => {
      expect((await stored(row.id)).status).toBe(status);
      return new Response("{}", { status: 200 });
    });
    const result = status === "approved"
      ? await approveSpotlightSubmission(db, bucket, staff, row.id, 0)
      : await rejectSpotlightSubmission(db, staff, row.id, 0);
    expect(result.notificationStatus).toBe("sent");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options).toMatchObject({ method: "POST", headers: { Authorization: "Bearer test-secret-key", "Content-Type": "application/json", "Idempotency-Key": `spotlight-submission/${row.id}/${status}` } });
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ from: "サイネージ管理 <noreply@non-turn.com>", to: [email], subject: status === "approved" ? "メンバー紹介を掲載しました" : "メンバー紹介の登録について" });
    expect(body.text).toContain(`${name} 様`);
    expect(body.html).toContain("山田 &lt;&gt;&amp;&quot;&#39; 様");
    expect(body.html).not.toContain(name);
    expect(body.text).toContain(status === "approved" ? "館内とWebのサイネージに掲載しました" : "今回は掲載を見送りました");
    expect(body.text).toContain(status === "approved" ? "修正や掲載の取りやめ" : "スタッフへお問い合わせ");
    for (const part of [body.text, body.html]) {
      expect(part).toContain("WeWork Ocean Gate の館内サイネージ「メンバー紹介」（運営：NonTurn合同会社）にご登録いただいた方へ");
      expect(part).toContain("登録規約は、登録ページの同意の欄からご確認いただけます。");
      expect(part).toContain("送信専用のアドレスのため、このメールには返信できません。");
    }
    expect(body.html).not.toMatch(/href|https?:/);
    expect(body.text).not.toMatch(/https?:/);
    expect(await stored(row.id)).toMatchObject({ status, notificationStatus: "sent", notificationAttempts: 0, notifiedAt: NOW, contactEmail: null, notificationName: null, notificationNextAt: null });
    if (status === "approved") {
      expect((await stored(row.id)).payload).toBeNull();
      // 通知の宛先は消すが、掲載メンバーには申請のアドレスを引き継ぐ（管理画面で見るだけ）
      expect((await db.select().from(memberSpotlights)).map((spotlight) => spotlight.contactEmail)).toEqual([email]);
      await approveSpotlightSubmission(db, bucket, staff, row.id, 0);
    } else await rejectSpotlightSubmission(db, staff, row.id, 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["approved", "rejected"] as const)("送信失敗でも%sは成立し、30分後に同じキーで再送する", async (status) => {
    const row = await pending();
    fetchMock.mockResolvedValueOnce(new Response(`failure ${email}`, { status: 503 }));
    const result = status === "approved"
      ? await approveSpotlightSubmission(db, bucket, staff, row.id, 0)
      : await rejectSpotlightSubmission(db, staff, row.id, 0);
    expect(result.notificationStatus).toBe("pending");
    expect(await stored(row.id)).toMatchObject({ status, notificationStatus: "pending", notificationAttempts: 1, contactEmail: email, notificationName: name, notificationNextAt: NOW + HALF_HOUR });
    expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR - 1)).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR)).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(fetchMock.mock.calls[1][1]?.headers);
    expect(await stored(row.id)).toMatchObject({ notificationStatus: "sent", contactEmail: null, notificationName: null, notifiedAt: NOW + HALF_HOUR, notificationAttempts: 1 });
  });

  it("通信例外をその内容をログに出さずに再送待ちにする", async () => {
    await notification("network");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error(`${email} test-secret-key ${name}`));
    expect(await notifySpotlightSubmission(db, "network", NOW)).toBe("pending");
    expect(await stored("network")).toMatchObject({ notificationAttempts: 1, notificationNextAt: NOW + HALF_HOUR });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/member@example|test-secret-key|山田/);
  });

  it("キー未設定なら送らず回数を増やさず、設定後にCronで送れる", async () => {
    env.RESEND_API_KEY = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = await pending();
    expect(await rejectSpotlightSubmission(db, staff, row.id, 0)).toEqual({ notificationStatus: "pending" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await stored(row.id)).toMatchObject({ notificationAttempts: 0, notificationStatus: "pending", contactEmail: email });
    expect(warn).toHaveBeenCalledWith("Spotlight notification deferred: RESEND_API_KEY is not configured");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(email);
    env.RESEND_API_KEY = "test-secret-key";
    expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR)).toEqual({ processed: 1, sent: 1, failed: 0 });
  });

  it("通知結果の保存に失敗しても承認は成功し、lease後の再送には同じキーを使う", async () => {
    const row = await pending();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.run(sql`CREATE TRIGGER fail_notification_save BEFORE UPDATE OF notification_status ON member_spotlight_submissions WHEN NEW.notification_status = 'sent' BEGIN SELECT RAISE(ABORT, 'notification save failed'); END`);
    expect((await approveSpotlightSubmission(db, bucket, staff, row.id, 0)).notificationStatus).toBe("pending");
    expect(await stored(row.id)).toMatchObject({ status: "approved", notificationStatus: "pending", notificationNextAt: NOW + HALF_HOUR });
    expect(await db.select().from(memberSpotlights)).toHaveLength(1);
    expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR - 1)).toEqual({ processed: 0, sent: 0, failed: 0 });
    await db.run(sql`DROP TRIGGER fail_notification_save`);
    expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR)).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(fetchMock.mock.calls[1][1]?.headers);
  });

  it("並行する通知処理はleaseを取得した1件だけが送信する", async () => {
    await notification("concurrent");
    let release!: () => void;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementationOnce(async () => { entered(); await paused; return new Response("{}"); });
    const first = notifySpotlightSubmission(db, "concurrent", NOW);
    await sending;
    expect(await notifySpotlightSubmission(db, "concurrent", NOW)).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe("sent");
  });
});

describe("再送の上限と保持期限", () => {
  it("Cron1回につき20件まで処理し、残りは次回に回す", async () => {
    for (let index = 0; index < 21; index++) await notification(`batch-${String(index).padStart(2, "0")}`);
    expect(await retrySpotlightNotifications(db, NOW)).toEqual({ processed: 20, sent: 20, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(await retrySpotlightNotifications(db, NOW)).toEqual({ processed: 1, sent: 1, failed: 0 });
  });

  it("5回失敗したらfailedにして宛先と宛名を消す", async () => {
    await notification("five");
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    for (let index = 0; index < 5; index++) {
      expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR * index)).toEqual({ processed: 1, sent: 0, failed: index === 4 ? 1 : 0 });
    }
    expect(await stored("five")).toMatchObject({ notificationStatus: "failed", notificationAttempts: 5, contactEmail: null, notificationName: null, notificationNextAt: null });
    expect(await retrySpotlightNotifications(db, NOW + HALF_HOUR * 5)).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([true, false])("7日経過したらAPIキー有無(%s)によらず送らず宛先を消す", async (hasKey) => {
    await notification("expired");
    if (!hasKey) env.RESEND_API_KEY = undefined;
    expect(await retrySpotlightNotifications(db, NOW + WEEK)).toEqual({ processed: 1, sent: 0, failed: 1 });
    expect(await stored("expired")).toMatchObject({ notificationStatus: "failed", notificationAttempts: 0, contactEmail: null, notificationName: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("回収が先でもpendingの通知と文面は残り、送信後に回収できる", async () => {
    const row = await pending();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await rejectSpotlightSubmission(db, staff, row.id, 0);
    expect(await cleanupSpotlightSubmissions(db, bucket, NOW)).toEqual({ expired: 0, completed: 0, failed: 0 });
    expect(await stored(row.id)).toMatchObject({ contactEmail: email, notificationName: name, payload: row.payload, cleanupCompletedAt: null });
    await retrySpotlightNotifications(db, NOW + HALF_HOUR);
    expect(await cleanupSpotlightSubmissions(db, bucket, NOW + HALF_HOUR)).toEqual({ expired: 0, completed: 1, failed: 0 });
    expect(await stored(row.id)).toMatchObject({ payload: null, contactEmail: null, notificationName: null });
  });

  it("アドレスを持つ期限切れ申請の回収が失敗してもメールアドレスは消す", async () => {
    const row = await pending();
    await db.update(memberSpotlightSubmissions).set({ status: "expired", cleanupNextAt: NOW }).where(eq(memberSpotlightSubmissions.id, row.id));
    await db.run(sql`CREATE TRIGGER fail_cleanup BEFORE UPDATE OF cleanup_completed_at ON member_spotlight_submissions WHEN NEW.cleanup_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END`);
    expect(await cleanupSpotlightSubmissions(db, bucket, NOW)).toEqual({ expired: 0, completed: 0, failed: 1 });
    expect(await stored(row.id)).toMatchObject({ contactEmail: null, payload: row.payload, cleanupCompletedAt: null });
  });
});

describe("メールアドレスのない既存申請", () => {
  it.each(["approved", "rejected"] as const)("確認待ちの表示と%sを維持し通知なしで処理する", async (status) => {
    const row = await pending();
    await db.update(memberSpotlightSubmissions).set({ contactEmail: null, consentVersion: 1 });
    expect(await listSpotlightSubmissions(db, staff)).toMatchObject([{ contactEmail: null, consentVersion: 1 }]);
    const result = status === "approved"
      ? await approveSpotlightSubmission(db, bucket, staff, row.id, 0)
      : await rejectSpotlightSubmission(db, staff, row.id, 0);
    expect(result.notificationStatus).toBe("skipped");
    expect(await stored(row.id)).toMatchObject({ status, notificationStatus: "skipped", contactEmail: null, notificationName: null });
    if (status === "rejected") expect(await cleanupSpotlightSubmissions(db, bucket, NOW)).toEqual({ expired: 0, completed: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("承認済み・却下済みの通知状態NULLも再審査応答と回収が動く", async () => {
    await notification("old-approved", { contactEmail: null, notificationStatus: null, notificationNextAt: null, notificationName: null });
    await notification("old-rejected", { status: "rejected", contactEmail: null, notificationStatus: null, notificationNextAt: null, notificationName: null, cleanupNextAt: NOW });
    expect(await approveSpotlightSubmission(db, bucket, staff, "old-approved", 0)).toEqual({ spotlightId: null, notificationStatus: "skipped" });
    expect(await rejectSpotlightSubmission(db, staff, "old-rejected", 0)).toEqual({ notificationStatus: "skipped" });
    expect(await cleanupSpotlightSubmissions(db, bucket, NOW)).toEqual({ expired: 0, completed: 1, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
