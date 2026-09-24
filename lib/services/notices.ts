/**
 * お知らせのサービス（lib/validators.ts の noticeInputSchema / noticeUpdateSchema で検証）。
 *
 * - 権限は Staff 以上（計画 6 節の権限表）。
 * - 更新は revision による条件付き更新。不一致は conflict エラー（409）。
 * - 画像参照（imageMediaId）は media が state=active かつ type=image のものだけ許す。
 * - content_version のような単調カウンタは持たない。各行の revision だけを 1 ずつ増やす。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import { media, notices, nowSeconds } from "../../db/schema";
import { AuthzError, type AuthUser, type Role } from "../auth";
import { noticeInputSchema, noticeUpdateSchema, type NoticeInput, type NoticeUpdate } from "../validators";

/** サービス層の業務エラー。Server Action・Route Handler で `{ error: { code, message } }` に変換する */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** 呼び出し元が保持している AuthUser の役割を確認する（DB 照合済みの前提。administrator は staff の操作もできる） */
export function assertRole(user: AuthUser, role: Role): void {
  if (role === "administrator" && user.role !== "administrator") throw new AuthzError(403);
}

/** Zod での検証。失敗は 400 の ServiceError（先頭のエラーメッセージを使う） */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? "入力が正しくありません";
    throw new ServiceError(400, "invalid_input", message);
  }
  return result.data;
}

/** 画像参照は media が active かつ image のものだけ許す。null は「画像なし」として許可する */
export async function assertActiveImage(db: Db, mediaId: string | null): Promise<void> {
  if (mediaId === null) return;
  const [row] = await db.select({ type: media.type, state: media.state }).from(media).where(eq(media.id, mediaId));
  if (!row || row.type !== "image" || row.state !== "active") {
    throw new ServiceError(400, "invalid_media", "指定した画像が見つからないか、使用できません");
  }
}

export type NoticeRow = typeof notices.$inferSelect;

export async function listNotices(db: Db): Promise<NoticeRow[]> {
  return db.select().from(notices).orderBy(desc(notices.updatedAt));
}

export async function getNotice(db: Db, id: string): Promise<NoticeRow> {
  const [row] = await db.select().from(notices).where(eq(notices.id, id));
  if (!row) throw new ServiceError(404, "not_found", "お知らせが見つかりません");
  return row;
}

export async function createNotice(db: Db, user: AuthUser, input: unknown): Promise<NoticeRow> {
  assertRole(user, "staff");
  const data: NoticeInput = parseInput(noticeInputSchema, input);
  await assertActiveImage(db, data.imageMediaId);

  const [row] = await db
    .insert(notices)
    .values({
      title: data.title,
      body: data.body,
      imageMediaId: data.imageMediaId,
      enabled: data.enabled,
      displayMode: data.displayMode,
      displayStartTime: data.displayStartTime,
      displayEndTime: data.displayEndTime,
    })
    .returning();
  return row;
}

export async function updateNotice(db: Db, user: AuthUser, id: string, input: unknown): Promise<NoticeRow> {
  assertRole(user, "staff");
  const data: NoticeUpdate = parseInput(noticeUpdateSchema, input);
  await assertActiveImage(db, data.imageMediaId);

  const updated = await db
    .update(notices)
    .set({
      title: data.title,
      body: data.body,
      imageMediaId: data.imageMediaId,
      enabled: data.enabled,
      displayMode: data.displayMode,
      displayStartTime: data.displayStartTime,
      displayEndTime: data.displayEndTime,
      revision: sql`${notices.revision} + 1`,
      updatedAt: nowSeconds(),
    })
    .where(and(eq(notices.id, id), eq(notices.revision, data.revision)))
    .returning();
  if (updated.length > 0) return updated[0];

  // 0 件だったのは「そもそも無い」か「revision がずれている」かのどちらか
  await getNotice(db, id);
  throw new ServiceError(409, "conflict", "他の人が先に更新しました");
}

export async function deleteNotice(db: Db, user: AuthUser, id: string): Promise<void> {
  assertRole(user, "staff");
  await getNotice(db, id);
  await db.delete(notices).where(eq(notices.id, id));
}
