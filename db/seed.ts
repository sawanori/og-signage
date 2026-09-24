/**
 * 初期データ。何度実行しても同じ結果になる（固定 ID で、既にある行はそのまま）。
 * 実行: npm run db:seed（TURSO_DATABASE_URL が未設定なら file:local.db）
 * 表示スケジュールは入れない（全曜日が終日表示）。
 */
import { createClient } from "@libsql/client";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "./index";
import { eventCategories, houseRules, houseSettings, playlists } from "./schema";

export const SEED_HOUSE_SETTINGS_ID = "house";
export const SEED_PLAYLIST_ID = "playlist_default";

/** 色はモック（image/dashboard.png）のタグ色に近いもの */
export const SEED_CATEGORIES = [
  { id: "cat_movie", name: "映画", color: "#A57BEA", position: 0 },
  { id: "cat_outdoor", name: "アウトドア", color: "#5DBB7A", position: 1 },
  { id: "cat_social", name: "交流", color: "#EF6B73", position: 2 },
  { id: "cat_workshop", name: "ワークショップ", color: "#4F8BF0", position: 3 },
  { id: "cat_other", name: "その他", color: "#9CA3AF", position: 4 },
];

/** 文言はモック（image/UI-V.png）のもの */
export const SEED_HOUSE_RULES = [
  { id: "rule_quiet", icon: "volume-x", text: "22時以降はお静かに", position: 0 },
  { id: "rule_trash", icon: "trash-2", text: "ゴミは分別して捨てましょう", position: 1 },
  { id: "rule_respect", icon: "users", text: "お互いを尊重して気持ちよく", position: 2 },
];

export async function seed(db: Db): Promise<void> {
  await db.insert(eventCategories).values(SEED_CATEGORIES).onConflictDoNothing();
  await db
    .insert(houseSettings)
    .values({
      id: SEED_HOUSE_SETTINGS_ID,
      houseName: "HARMONY HOUSE",
      // 改行位置と「英語 1 行目 + 日本語」の組み方はモック（image/UI-V.png）に合わせる
      headerCopy: "ここで暮らす、\nちょっと特別な毎日を。",
      footerCopy: "Same House, Different Stories.\nいろんな出会いが、\nきっと明日の自分をつくる。",
      weatherLocationName: "横浜市",
      weatherLatitude: 35.4437,
      weatherLongitude: 139.638,
    })
    .onConflictDoNothing();
  await db.insert(houseRules).values(SEED_HOUSE_RULES).onConflictDoNothing();
  await db.insert(playlists).values({ id: SEED_PLAYLIST_ID, name: "定期動画" }).onConflictDoNothing();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { client, db } = createDb(
    createClient,
    process.env.TURSO_DATABASE_URL ?? "file:local.db",
    process.env.TURSO_AUTH_TOKEN,
  );
  await seed(db);
  client.close();
  console.log("初期データを投入しました");
}
