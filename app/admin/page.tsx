/**
 * ダッシュボード（/admin、Staff 以上）。
 * プレビューは先頭の端末の config（lib/config-builder.ts）で描く。端末が無い・表示の設定がそろっていない場合は空状態。
 * プレビューの向きは管理画面で選んだもの（cookie）。選んでいなければ端末の向き。
 */
import { cookies } from "next/headers";
import { nowSeconds } from "@/db/schema";
import { Dashboard } from "@/components/admin/dashboard";
import { PREVIEW_ORIENTATION_COOKIE, parsePreviewOrientation } from "@/components/admin/preview-orientation";
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
  const chosen = parsePreviewOrientation((await cookies()).get(PREVIEW_ORIENTATION_COOKIE)?.value);
  const previewOrientation = chosen ?? previewConfig?.device.orientation ?? "portrait";
  return (
    <Dashboard
      data={data}
      previewConfig={previewConfig}
      previewOrientation={previewOrientation}
      resolveMediaUrl={resolveMediaUrl}
    />
  );
}
