/**
 * デザイン設定（house_settings）・ハウスルール（house_rules）・イベントカテゴリ（event_categories）のサービス。
 *
 * - 権限はすべて Administrator（計画 6 節の権限表）。
 * - house_settings は1行だけ。更新は revision による条件付き更新で、不一致は conflict エラー（409）。
 * - house_rules（最大3件）は id を持たない入力（並び順で保存）なので、保存のたびに全件を置き換える。
 * - event_categories は id 指定で名前と色だけを更新する（行の追加・削除はしない）。
 * - ロゴ・フッター画像は media が state=active かつ type=image のものだけ許す。
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import { eventCategories, houseRules, houseSettings } from "../../db/schema";
import type { AuthUser } from "../auth";
import { designSettingsSchema, houseRulesSchema, type DesignSettingsInput, type HouseRulesInput } from "../validators";
import { assertActiveImage, assertRole, parseInput, ServiceError } from "./notices";

export type HouseSettingsRow = typeof houseSettings.$inferSelect;
export type HouseRuleRow = typeof houseRules.$inferSelect;
export type EventCategoryRow = typeof eventCategories.$inferSelect;

/** Db とトランザクション内の tx はどちらも select() を持つが、tx は Db 全体とは型が異なる（batch を持たない）ため構造的な型で受ける */
async function currentHouseSettings(db: Pick<Db, "select">): Promise<HouseSettingsRow> {
  const [row] = await db.select().from(houseSettings).limit(1);
  if (!row) throw new Error("house_settings が初期化されていません（db/seed.ts を実行してください）");
  return row;
}

export async function getDesignSettings(
  db: Db,
): Promise<{ settings: HouseSettingsRow; categories: EventCategoryRow[] }> {
  const settings = await currentHouseSettings(db);
  const categories = await listEventCategories(db);
  return { settings, categories };
}

export async function updateDesignSettings(db: Db, user: AuthUser, input: unknown): Promise<HouseSettingsRow> {
  assertRole(user, "administrator");
  const data: DesignSettingsInput = parseInput(designSettingsSchema, input);
  await assertActiveImage(db, data.logoMediaId);
  await assertActiveImage(db, data.footerImageMediaId);

  return db.transaction(async (tx) => {
    const current = await currentHouseSettings(tx);

    const updated = await tx
      .update(houseSettings)
      .set({
        houseName: data.houseName,
        headerCopy: data.headerCopy,
        footerCopy: data.footerCopy,
        logoMediaId: data.logoMediaId,
        footerImageMediaId: data.footerImageMediaId,
        weatherLocationName: data.weatherLocationName,
        weatherLatitude: data.weatherLatitude,
        weatherLongitude: data.weatherLongitude,
        revision: current.revision + 1,
      })
      .where(and(eq(houseSettings.id, current.id), eq(houseSettings.revision, data.revision)))
      .returning();

    if (updated.length === 0) throw new ServiceError(409, "conflict", "他の人が先に更新しました");

    for (const category of data.categories) {
      const result = await tx
        .update(eventCategories)
        .set({ color: category.color })
        .where(eq(eventCategories.id, category.id))
        .returning({ id: eventCategories.id });
      if (result.length === 0) throw new ServiceError(400, "invalid_input", "存在しないカテゴリが含まれています");
    }

    return updated[0];
  });
}

// ---------------------------------------------------------------- ハウスルール

export async function listHouseRules(db: Db): Promise<HouseRuleRow[]> {
  return db.select().from(houseRules).orderBy(asc(houseRules.position));
}

/** 最大3件。id を持たない入力なので全件を置き換える（並べ替えは配列の順番で表す） */
export async function replaceHouseRules(db: Db, user: AuthUser, input: unknown): Promise<HouseRuleRow[]> {
  assertRole(user, "administrator");
  const data: HouseRulesInput = parseInput(houseRulesSchema, input);

  return db.transaction(async (tx) => {
    await tx.delete(houseRules);
    if (data.rules.length === 0) return [];
    await tx.insert(houseRules).values(data.rules.map((rule, index) => ({ icon: rule.icon, text: rule.text, position: index })));
    return tx.select().from(houseRules).orderBy(asc(houseRules.position));
  });
}

// ---------------------------------------------------------------- イベントカテゴリ

const eventCategoryUpdateSchema = z.object({
  categories: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z
          .string()
          .trim()
          .min(1, "カテゴリ名を入力してください")
          .refine((v) => [...v].length <= 20, "カテゴリ名は20文字以内で入力してください"),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "色は #RRGGBB の形式で入力してください"),
      }),
    )
    .min(1, "カテゴリを1件以上指定してください")
    .max(20),
});

export type EventCategoryUpdateInput = z.infer<typeof eventCategoryUpdateSchema>;

export async function listEventCategories(db: Db): Promise<EventCategoryRow[]> {
  return db.select().from(eventCategories).orderBy(asc(eventCategories.position));
}

/** 行の追加・削除はしない。id が一致する既存カテゴリの名前と色だけを更新する */
export async function updateEventCategories(db: Db, user: AuthUser, input: unknown): Promise<EventCategoryRow[]> {
  assertRole(user, "administrator");
  const data = parseInput(eventCategoryUpdateSchema, input);

  return db.transaction(async (tx) => {
    for (const category of data.categories) {
      const result = await tx
        .update(eventCategories)
        .set({ name: category.name, color: category.color })
        .where(eq(eventCategories.id, category.id))
        .returning({ id: eventCategories.id });
      if (result.length === 0) throw new ServiceError(400, "invalid_input", "存在しないカテゴリが含まれています");
    }
    return tx.select().from(eventCategories).orderBy(asc(eventCategories.position));
  });
}
