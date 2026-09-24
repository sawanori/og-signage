/**
 * デザイン設定（/admin/design、Administrator）。ハウス名・ロゴ・キャッチコピー・フッター画像・フッターの QR・
 * 天気地域・カテゴリ色を設定する（計画 6 節の権限表）。メンバー情報は /admin/member-info。
 */
import { DesignSettingsView } from "@/components/admin/design-settings-view";
import { ForbiddenNotice } from "@/components/admin/forbidden-notice";
import { getDb } from "@/lib/runtime";
import { getDesignSettings } from "@/lib/services/house";
import { requirePageRole } from "../_components/require-page-role";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `デザイン設定 | ${ADMIN_TITLE}` };

export default async function DesignSettingsPage() {
  const user = await requirePageRole("administrator");
  if (!user) return <ForbiddenNotice />;

  const db = getDb();
  const { settings, categories } = await getDesignSettings(db);
  return <DesignSettingsView settings={settings} categories={categories} />;
}
