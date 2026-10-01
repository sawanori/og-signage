import { env } from "cloudflare:workers";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/index";
import { memberSpotlightSubmissions, nowSeconds } from "../../db/schema";
import type { SpotlightNotificationStatus } from "../spotlight-submissions";

const RETRY_SECONDS = 30 * 60;
const EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** 審査確定後だけ呼ぶ。外部送信と結果保存の失敗を審査操作へ伝播させない。 */
export async function notifySpotlightSubmission(db: Db, id: string, now = nowSeconds()): Promise<SpotlightNotificationStatus> {
  try {
    const [row] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id));
    if (!row || row.notificationStatus !== "pending") return row?.notificationStatus ?? "skipped";
    if (row.status !== "approved" && row.status !== "rejected") return "pending";
    if (row.notificationAttempts >= MAX_ATTEMPTS || (row.reviewedAt !== null && now >= row.reviewedAt + EXPIRY_SECONDS)) {
      await db.update(memberSpotlightSubmissions).set({ notificationStatus: "failed", contactEmail: null, notificationName: null, notificationNextAt: null })
        .where(and(eq(memberSpotlightSubmissions.id, id), eq(memberSpotlightSubmissions.notificationStatus, "pending")));
      return "failed";
    }
    if (!env.RESEND_API_KEY) {
      console.warn("Spotlight notification deferred: RESEND_API_KEY is not configured");
      return "pending";
    }
    if (!row.contactEmail || !row.notificationName || row.notificationNextAt === null || row.notificationNextAt > now) return "pending";
    // 同時承認・Cronが重なっても1件だけ送る。途中停止時には30分後に再取得できる。
    const leaseUntil = now + RETRY_SECONDS;
    const claimed = await db.update(memberSpotlightSubmissions).set({ notificationNextAt: leaseUntil })
      .where(and(eq(memberSpotlightSubmissions.id, id), eq(memberSpotlightSubmissions.notificationStatus, "pending"), eq(memberSpotlightSubmissions.notificationNextAt, row.notificationNextAt)))
      .returning({ id: memberSpotlightSubmissions.id });
    if (claimed.length === 0) {
      const [current] = await db.select({ status: memberSpotlightSubmissions.notificationStatus }).from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id));
      return current?.status ?? "pending";
    }
    const approved = row.status === "approved";
    const subject = approved ? "メンバー紹介を掲載しました" : "メンバー紹介の登録について";
    const paragraphs = approved
      ? ["メンバー紹介にご登録いただき、ありがとうございます。", "スタッフが内容を確認し、館内とWebのサイネージに掲載しました。", "内容の修正や掲載の取りやめをご希望の場合は、スタッフへお伝えください。"]
      : ["メンバー紹介にご登録いただき、ありがとうございます。", "今回は掲載を見送りました。", "内容についてはスタッフへお問い合わせください。"];
    // 送った理由を末尾に書く（理由の無い短いメールは迷惑メールと判定されやすい。2026-10-01 ユーザー指示）
    const footer = [
      "このメールは、WeWork Ocean Gate のメンバー紹介にご登録いただいた方へ、登録時にご入力いただいたメールアドレス宛てにお送りしています。",
      "送信専用のアドレスのため、このメールには返信できません。",
    ];
    const text = [`${row.notificationName} 様`, ...paragraphs, "――――", ...footer].join("\n\n");
    const html = [
      `<p>${escapeHtml(row.notificationName)} 様</p>`,
      ...paragraphs.map((paragraph) => `<p>${paragraph}</p>`),
      "<hr>",
      ...footer.map((line) => `<p style="color:#666;font-size:12px">${line}</p>`),
    ].join("");
    let sent = false;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `spotlight-submission/${id}/${row.status}` },
        body: JSON.stringify({ from: env.SPOTLIGHT_NOTIFICATION_FROM, to: [row.contactEmail], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      sent = response.ok;
      // エラー応答は宛先や本文を含み得るため読み取らず、ログにも出さない。
    } catch { /* 通信エラーも通常の再送対象にする。 */ }
    const attempts = row.notificationAttempts + (sent ? 0 : 1);
    const status = sent ? "sent" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await db.update(memberSpotlightSubmissions).set({
      notificationStatus: status,
      notificationAttempts: attempts,
      notifiedAt: sent ? now : null,
      notificationNextAt: status === "pending" ? leaseUntil : null,
      contactEmail: status === "pending" ? row.contactEmail : null,
      notificationName: status === "pending" ? row.notificationName : null,
    }).where(and(eq(memberSpotlightSubmissions.id, id), eq(memberSpotlightSubmissions.notificationStatus, "pending"), eq(memberSpotlightSubmissions.notificationNextAt, leaseUntil)));
    return status;
  } catch {
    console.warn("Spotlight notification deferred: notification processing failed");
    return "pending";
  }
}

/** 30分ごとのCronから呼ぶ。通知待ちだけを古い順に最大20件処理する。 */
export async function retrySpotlightNotifications(db: Db, now: number): Promise<{ processed: number; sent: number; failed: number }> {
  const due = await db.select({ id: memberSpotlightSubmissions.id }).from(memberSpotlightSubmissions)
    .where(and(sql`${memberSpotlightSubmissions.notificationStatus} = 'pending'`, lte(memberSpotlightSubmissions.notificationNextAt, now)))
    .orderBy(asc(memberSpotlightSubmissions.notificationNextAt), asc(memberSpotlightSubmissions.id)).limit(BATCH_SIZE);
  const result = { processed: due.length, sent: 0, failed: 0 };
  for (const row of due) {
    const status = await notifySpotlightSubmission(db, row.id, now);
    if (status === "sent") result.sent++;
    if (status === "failed") result.failed++;
  }
  return result;
}
