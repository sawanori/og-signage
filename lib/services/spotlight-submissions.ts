import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/index";
import { media, memberSpotlights, memberSpotlightSubmissions, nowSeconds } from "../../db/schema";
import type { AuthUser } from "../auth";
import { sniffMime } from "../file-sniff";
import { putSpotlightSubmissionMarker, type MediaBucket } from "../r2";
import {
  SPOTLIGHT_SUBMISSION_CONSENT_VERSION,
  SPOTLIGHT_SUBMISSION_CLEANUP_BATCH_SIZE,
  SPOTLIGHT_SUBMISSION_EXPIRY_SECONDS,
  SPOTLIGHT_SUBMISSION_IMAGE_KINDS,
  SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES,
  spotlightSubmissionInputSchema,
  type SpotlightSubmissionFile,
  type SpotlightSubmissionImageKind,
  type SpotlightSubmissionDetail,
  type SpotlightSubmissionApproval,
} from "../spotlight-submissions";
import { assertRole } from "./notices";

export class SpotlightSubmissionError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 415 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "SpotlightSubmissionError";
  }
}

const unavailable = () => new SpotlightSubmissionError(503, "temporarily_unavailable", "送信結果を確認できません。時間をおいて同じ内容で再確認してください");
const conflict = () => new SpotlightSubmissionError(409, "conflict", "他のスタッフが処理しました。最新の一覧を確認してください");
const accepted = { accepted: true } as const;
type SubmissionRow = typeof memberSpotlightSubmissions.$inferSelect;
export type SpotlightSubmissionImages = Partial<Record<SpotlightSubmissionImageKind, { bytes: Uint8Array; mimeType: string }>>;

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function findSubmission(db: Db, id: string): Promise<SubmissionRow> {
  const [row] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id));
  if (!row) throw new SpotlightSubmissionError(404, "not_found", "申請が見つかりません");
  return row;
}

function isAccepted(row: SubmissionRow): boolean {
  if (row.status === "expired") throw new SpotlightSubmissionError(410, "expired", "送信の有効期限が切れました。内容を確認してもう一度送信してください");
  return row.status !== "receiving";
}

/** DBに追跡情報を残してからR2へ保存する。同じkeyでの再送では画像を上書きしない。 */
export async function submitSpotlightSubmission(
  db: Db,
  bucket: MediaBucket,
  input: unknown,
  images: SpotlightSubmissionImages,
  now = nowSeconds(),
): Promise<{ accepted: true }> {
  const parsed = spotlightSubmissionInputSchema.safeParse(input);
  if (!parsed.success) throw new SpotlightSubmissionError(400, "invalid_input", parsed.error.issues[0]?.message ?? "入力が正しくありません");
  const { requestKey, consent, ...payload } = parsed.data;
  const id = crypto.randomUUID();
  const files: Partial<Record<SpotlightSubmissionImageKind, SpotlightSubmissionFile>> = {};
  for (const kind of SPOTLIGHT_SUBMISSION_IMAGE_KINDS) {
    const image = images[kind];
    if (!image) continue;
    if (image.bytes.length > SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES) throw new SpotlightSubmissionError(413, "file_too_large", "画像は1枚2MiBまでです");
    const mimeType = sniffMime(image.bytes);
    if (!mimeType || mimeType === "video/mp4" || mimeType !== image.mimeType) throw new SpotlightSubmissionError(415, "unsupported_image", "JPEG・PNG・WebPの画像を選択してください");
    files[kind] = { r2Key: `member-submissions/${id}/${kind}`, mimeType, size: image.bytes.length, sha256: await digest(image.bytes) };
  }
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify({ payload, consent, photo: files.photo?.sha256 ?? null, logo: files.logo?.sha256 ?? null })));
  await db.insert(memberSpotlightSubmissions).values({
    id, requestKey, requestFingerprint: fingerprint, payload, photoFile: files.photo ?? null, logoFile: files.logo ?? null,
    consentedAt: now, consentVersion: SPOTLIGHT_SUBMISSION_CONSENT_VERSION, createdAt: now, updatedAt: now,
  }).onConflictDoNothing({ target: memberSpotlightSubmissions.requestKey });
  let [row] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.requestKey, requestKey));
  if (row.requestFingerprint !== fingerprint) throw new SpotlightSubmissionError(409, "request_conflict", "送信内容が一致しません。スタッフへご相談ください");
  if (isAccepted(row)) return accepted;
  const refreshed = await db.update(memberSpotlightSubmissions).set({ updatedAt: now })
    .where(and(eq(memberSpotlightSubmissions.id, row.id), eq(memberSpotlightSubmissions.status, "receiving"), eq(memberSpotlightSubmissions.updatedAt, row.updatedAt))).returning();
  if (refreshed.length === 0) {
    row = await findSubmission(db, row.id);
    if (isAccepted(row)) return accepted;
  }
  for (const kind of SPOTLIGHT_SUBMISSION_IMAGE_KINDS) {
    const file = kind === "photo" ? row.photoFile : row.logoFile;
    if (!file) continue;
    try {
      const saved = await bucket.put(file.r2Key, images[kind]!.bytes, { httpMetadata: { contentType: file.mimeType }, onlyIf: { etagDoesNotMatch: "*" } });
      if (saved === null) {
        const current = await findSubmission(db, row.id);
        if (isAccepted(current)) return accepted;
        const existing = await bucket.head(file.r2Key);
        if (!existing || existing.size !== file.size || existing.size === 0) throw unavailable();
      }
    } catch (error) {
      if (error instanceof SpotlightSubmissionError) throw error;
      throw unavailable();
    }
  }
  const completed = await db.update(memberSpotlightSubmissions).set({ status: "pending", submittedAt: now, updatedAt: now })
    .where(and(eq(memberSpotlightSubmissions.id, row.id), eq(memberSpotlightSubmissions.status, "receiving"))).returning({ id: memberSpotlightSubmissions.id });
  if (completed.length === 0 && !isAccepted(await findSubmission(db, row.id))) throw unavailable();
  return accepted;
}

export async function listSpotlightSubmissions(db: Db, user: AuthUser): Promise<SpotlightSubmissionDetail[]> {
  assertRole(user, "staff");
  const rows = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.status, "pending"))
    .orderBy(asc(memberSpotlightSubmissions.submittedAt), asc(memberSpotlightSubmissions.id));
  return rows.map((row) => {
    if (!row.payload || row.submittedAt === null) throw unavailable();
    return {
      id: row.id, companyName: row.payload.companyName, personName: row.payload.personName, revision: row.revision,
      submittedAt: row.submittedAt, payload: row.payload, consentedAt: row.consentedAt, consentVersion: row.consentVersion,
      photoUrl: row.photoFile ? `/api/spotlight-submissions/${row.id}/images/photo` : null,
      logoUrl: row.logoFile ? `/api/spotlight-submissions/${row.id}/images/logo` : null,
    };
  });
}

export async function getSpotlightSubmissionImage(db: Db, bucket: MediaBucket, user: AuthUser, id: string, kind: string) {
  assertRole(user, "staff");
  const row = await findSubmission(db, id);
  const file = kind === "photo" ? row.photoFile : kind === "logo" ? row.logoFile : null;
  if (row.status !== "pending" || !file) throw new SpotlightSubmissionError(404, "not_found", "画像が見つかりません");
  const object = await bucket.get(file.r2Key);
  if (!object || object.size === 0 || object.size !== file.size) throw new SpotlightSubmissionError(404, "not_found", "画像が見つかりません");
  return { file, object };
}

function validateRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 0) throw new SpotlightSubmissionError(400, "invalid_input", "申請の版が正しくありません");
}

async function withWriteRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      let cause: unknown = error;
      let busy = false;
      while (cause instanceof Error) {
        if ("code" in cause && cause.code === "SQLITE_BUSY") { busy = true; break; }
        cause = cause.cause;
      }
      if (!busy) throw error;
      if (attempt >= 3) throw unavailable();
      // 同時審査の書き込みロックが解放された後に、状態を再照合する。
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export async function approveSpotlightSubmission(db: Db, bucket: MediaBucket, user: AuthUser, id: string, revision: number): Promise<SpotlightSubmissionApproval> {
  assertRole(user, "staff");
  validateRevision(revision);
  const before = await findSubmission(db, id);
  if (before.status === "approved") return { spotlightId: before.approvedSpotlightId };
  if (before.status !== "pending" || before.revision !== revision) throw conflict();
  for (const file of [before.photoFile, before.logoFile]) {
    if (!file) continue;
    try {
      const object = await bucket.head(file.r2Key);
      if (!object || object.size === 0 || object.size !== file.size) throw unavailable();
    } catch { throw unavailable(); }
  }
  // libSQLのwriteトランザクションで状態確定と関連行作成を一括rollback可能にする。
  return withWriteRetry(() => db.transaction(async (tx) => {
    const [row] = await tx.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id));
    if (!row) throw new SpotlightSubmissionError(404, "not_found", "申請が見つかりません");
    if (row.status === "approved") return { spotlightId: row.approvedSpotlightId };
    if (row.status !== "pending" || row.revision !== revision) throw conflict();
    if (!row.payload) throw unavailable();
    const now = nowSeconds();
    const changed = await tx.update(memberSpotlightSubmissions).set({ status: "approved", revision: sql`${memberSpotlightSubmissions.revision} + 1`, reviewedAt: now, reviewedBy: user.id, updatedAt: now })
      .where(and(eq(memberSpotlightSubmissions.id, id), eq(memberSpotlightSubmissions.status, "pending"), eq(memberSpotlightSubmissions.revision, revision))).returning();
    if (changed.length === 0) throw conflict();
    const imageIds: Partial<Record<SpotlightSubmissionImageKind, string>> = {};
    for (const kind of SPOTLIGHT_SUBMISSION_IMAGE_KINDS) {
      const file = kind === "photo" ? row.photoFile : row.logoFile;
      if (!file) continue;
      const [image] = await tx.insert(media).values({ name: `${row.payload.personName} ${kind === "photo" ? "写真" : "ロゴ"}`, type: "image", r2Key: file.r2Key, mimeType: file.mimeType, fileSize: file.size, sha256: file.sha256 }).returning({ id: media.id });
      imageIds[kind] = image.id;
    }
    const [spotlight] = await tx.insert(memberSpotlights).values({ ...row.payload, photoMediaId: imageIds.photo ?? null, logoMediaId: imageIds.logo ?? null, enabled: true }).returning({ id: memberSpotlights.id });
    await tx.update(memberSpotlightSubmissions).set({ approvedSpotlightId: spotlight.id }).where(eq(memberSpotlightSubmissions.id, id));
    return { spotlightId: spotlight.id };
  }, { behavior: "immediate" }));
}

export async function rejectSpotlightSubmission(db: Db, user: AuthUser, id: string, revision: number): Promise<null> {
  assertRole(user, "staff");
  validateRevision(revision);
  const now = nowSeconds();
  const changed = await withWriteRetry(() => db.update(memberSpotlightSubmissions).set({ status: "rejected", revision: sql`${memberSpotlightSubmissions.revision} + 1`, reviewedAt: now, reviewedBy: user.id, updatedAt: now, cleanupNextAt: now })
    .where(and(eq(memberSpotlightSubmissions.id, id), eq(memberSpotlightSubmissions.status, "pending"), eq(memberSpotlightSubmissions.revision, revision))).returning({ id: memberSpotlightSubmissions.id }).execute());
  if (changed.length > 0) return null;
  if ((await findSubmission(db, id)).status === "rejected") return null;
  throw conflict();
}

/** 一実行の期限切れ確定・回収をそれぞれ50件に制限し、回収完了済みにはアクセスしない。 */
export async function cleanupSpotlightSubmissions(db: Db, bucket: MediaBucket, now: number): Promise<{ expired: number; completed: number; failed: number }> {
  const result = { expired: 0, completed: 0, failed: 0 };
  const stale = await db.select().from(memberSpotlightSubmissions)
    .where(and(eq(memberSpotlightSubmissions.status, "receiving"), lte(memberSpotlightSubmissions.updatedAt, now - SPOTLIGHT_SUBMISSION_EXPIRY_SECONDS)))
    .orderBy(asc(memberSpotlightSubmissions.updatedAt), asc(memberSpotlightSubmissions.id)).limit(SPOTLIGHT_SUBMISSION_CLEANUP_BATCH_SIZE);
  for (const row of stale) {
    const expired = await db.update(memberSpotlightSubmissions)
      .set({ status: "expired", revision: sql`${memberSpotlightSubmissions.revision} + 1`, updatedAt: now, cleanupNextAt: now })
      .where(and(eq(memberSpotlightSubmissions.id, row.id), eq(memberSpotlightSubmissions.status, "receiving"), eq(memberSpotlightSubmissions.updatedAt, row.updatedAt))).returning({ id: memberSpotlightSubmissions.id });
    result.expired += expired.length;
  }
  // 部分索引のWHEREと一致する固定条件。パラメーター化するとSQLiteが索引を選べない。
  const due = await db.select().from(memberSpotlightSubmissions)
    .where(and(sql`${memberSpotlightSubmissions.status} IN ('rejected', 'expired')`, isNull(memberSpotlightSubmissions.cleanupCompletedAt), lte(memberSpotlightSubmissions.cleanupNextAt, now)))
    .orderBy(asc(memberSpotlightSubmissions.cleanupNextAt), asc(memberSpotlightSubmissions.id)).limit(SPOTLIGHT_SUBMISSION_CLEANUP_BATCH_SIZE);
  for (const row of due) {
    try {
      const keys = [row.photoFile?.r2Key, row.logoFile?.r2Key].filter((key): key is string => key !== undefined);
      if (keys.length > 0) {
        const owned = await db.select({ id: media.id }).from(media).where(inArray(media.r2Key, keys)).limit(1);
        if (owned.length > 0) throw new Error("Submission key belongs to media");
        for (const key of keys) await putSpotlightSubmissionMarker(bucket, key);
      }
      const completed = await db.update(memberSpotlightSubmissions).set({ payload: null, cleanupNextAt: null, cleanupCompletedAt: now })
        .where(and(eq(memberSpotlightSubmissions.id, row.id), inArray(memberSpotlightSubmissions.status, ["rejected", "expired"]), isNull(memberSpotlightSubmissions.cleanupCompletedAt))).returning({ id: memberSpotlightSubmissions.id });
      result.completed += completed.length;
    } catch {
      result.failed++;
      // 次回へ送って未処理の後続を優先する。DB自体が使えない場合はここで失敗として終了する。
      await db.update(memberSpotlightSubmissions).set({ cleanupNextAt: now + SPOTLIGHT_SUBMISSION_EXPIRY_SECONDS })
        .where(and(eq(memberSpotlightSubmissions.id, row.id), isNull(memberSpotlightSubmissions.cleanupCompletedAt)));
    }
  }
  return result;
}
