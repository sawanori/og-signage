/**
 * ダッシュボード（/admin、Staff 以上）。
 * プレビューは先頭の端末の config（lib/config-builder.ts）で描く。端末が無い・表示の設定がそろっていない場合は空状態。
 */
import { nowSeconds } from "@/db/schema";
import { Dashboard } from "@/components/admin/dashboard";
import { ConfigUnavailableError, buildDeviceConfig } from "@/lib/config-builder";
import type { MediaRef, SignageConfig } from "@/lib/config-schema";
import { getDb } from "@/lib/runtime";
import { currentSiteUrl } from "@/lib/site-url";
import { requirePageUser } from "./_components/current-user";
import { loadDashboard } from "./_components/load-dashboard";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `ダッシュボード | ${ADMIN_TITLE}` };

/** クラウドでの画像 URL（管理用素材 API） */
const resolveMediaUrl = (ref: MediaRef) => `/api/media/${encodeURIComponent(ref.mediaId)}/file`;

export default async function AdminDashboardPage() {
  await requirePageUser();
  const db = getDb();
  const now = nowSeconds();
  const data = await loadDashboard(db, now);
  let previewConfig: SignageConfig | null = null;
  if (data.device) {
    try {
      previewConfig = await buildDeviceConfig(db, data.device.id, now, await currentSiteUrl());
    } catch (e) {
      if (!(e instanceof ConfigUnavailableError)) throw e;
    }
  }
  return <Dashboard data={data} previewConfig={previewConfig} resolveMediaUrl={resolveMediaUrl} />;
}
