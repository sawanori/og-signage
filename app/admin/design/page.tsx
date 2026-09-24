/**
 * デザイン設定（/admin/design、Administrator）。ハウス名・ロゴ・キャッチコピー・フッター画像・
 * ハウスルール・天気地域・カテゴリ色を設定する（計画 6 節の権限表）。
 */
import { DesignSettingsView } from "@/components/admin/design-settings-view";
import { ForbiddenNotice } from "@/components/admin/forbidden-notice";
import { getDb } from "@/lib/runtime";
import { getDesignSettings, listHouseRules } from "@/lib/services/house";
import { requirePageRole } from "../_components/require-page-role";

export const dynamic = "force-dynamic";

export const metadata = { title: "デザイン設定 | サイネージ管理" };

export default async function DesignSettingsPage() {
  const user = await requirePageRole("administrator");
  if (!user) return <ForbiddenNotice />;

  const db = getDb();
  const [{ settings, categories }, rules] = await Promise.all([getDesignSettings(db), listHouseRules(db)]);
  return <DesignSettingsView settings={settings} categories={categories} rules={rules} />;
}
