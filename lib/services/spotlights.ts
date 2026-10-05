/**
 * メンバー紹介（サイネージの MEMBER SPOTLIGHT。2026-09-26 ユーザー指示）のサービス
 * （lib/validators.ts の spotlightInputSchema / spotlightUpdateSchema で検証）。
 *
 * - 権限は Staff 以上（お知らせと同じ）。
 * - 更新は revision による条件付き更新。不一致は conflict エラー（409）。
 * - 写真・ロゴは media が state=active かつ type=image のものだけ許す。
 * - 並びは登録順（古いものから）。サイネージには enabled のものだけを出す（lib/config-builder.ts）。
 * - ふりがな（任意）は管理画面の一覧の絞り込みと名前順にだけ使い、サイネージの config には入れない。
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/index";
import { memberSpotlights, nowSeconds } from "../../db/schema";
import type { AuthUser } from "../auth";
import { spotlightInputSchema, spotlightUpdateSchema, type SpotlightInput, type SpotlightUpdate } from "../validators";
import { ServiceError, assertActiveImage, assertRole, parseInput } from "./notices";
import { enqueueSpotlightResearch, enqueueSpotlightResearchDeletion } from "./company-research-outbox";

export type SpotlightRow = typeof memberSpotlights.$inferSelect;

export async function listSpotlights(db: Db): Promise<SpotlightRow[]> {
  return db.select().from(memberSpotlights).orderBy(asc(memberSpotlights.createdAt), asc(memberSpotlights.id));
}

export async function getSpotlight(db: Db, id: string): Promise<SpotlightRow> {
  const [row] = await db.select().from(memberSpotlights).where(eq(memberSpotlights.id, id));
  if (!row) throw new ServiceError(404, "not_found", "メンバー紹介が見つかりません");
  return row;
}

function toColumns(data: Omit<SpotlightInput, "websiteUrl2"> & { websiteUrl2?: string | null }) {
  return {
    companyName: data.companyName,
    personName: data.personName,
    personNameKana: data.personNameKana,
    role: data.role,
    quote: data.quote,
    bio: data.bio,
    tags: data.tags,
    contactEmail: data.contactEmail,
    websiteUrl: data.websiteUrl,
    ...(data.websiteUrl2 === undefined ? {} : { websiteUrl2: data.websiteUrl2 }),
    floor: data.floor,
    photoMediaId: data.photoMediaId,
    logoMediaId: data.logoMediaId,
    enabled: data.enabled,
  };
}

export async function createSpotlight(db: Db, user: AuthUser, input: unknown): Promise<SpotlightRow> {
  assertRole(user, "staff");
  const data: SpotlightInput = parseInput(spotlightInputSchema, input);
  await assertActiveImage(db, data.photoMediaId);
  await assertActiveImage(db, data.logoMediaId);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(memberSpotlights).values(toColumns(data)).returning();
    await enqueueSpotlightResearch(tx, row);
    return row;
  }, { behavior: "immediate" });
}

export async function updateSpotlight(db: Db, user: AuthUser, id: string, input: unknown): Promise<SpotlightRow> {
  assertRole(user, "staff");
  const { revision, ...data }: SpotlightUpdate = parseInput(spotlightUpdateSchema, input);
  await assertActiveImage(db, data.photoMediaId);
  await assertActiveImage(db, data.logoMediaId);

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(memberSpotlights).where(eq(memberSpotlights.id, id));
    if (!before) throw new ServiceError(404, "not_found", "メンバー紹介が見つかりません");
    const [updated] = await tx.update(memberSpotlights)
      .set({ ...toColumns(data), revision: sql`${memberSpotlights.revision} + 1`, updatedAt: nowSeconds() })
      .where(and(eq(memberSpotlights.id, id), eq(memberSpotlights.revision, revision))).returning();
    if (!updated) throw new ServiceError(409, "conflict", "他の人が先に更新しました");
    // old client が websiteUrl2 を省略した場合も保存後の値から作る。
    await enqueueSpotlightResearch(tx, updated, before);
    return updated;
  }, { behavior: "immediate" });
}

export async function deleteSpotlight(db: Db, user: AuthUser, id: string): Promise<void> {
  assertRole(user, "staff");
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(memberSpotlights).where(eq(memberSpotlights.id, id));
    if (!row) throw new ServiceError(404, "not_found", "メンバー紹介が見つかりません");
    await enqueueSpotlightResearchDeletion(tx, row);
    await tx.delete(memberSpotlights).where(eq(memberSpotlights.id, id));
  }, { behavior: "immediate" });
}
