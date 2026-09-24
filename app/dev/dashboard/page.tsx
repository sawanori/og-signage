/**
 * ダッシュボードの確認用ページ（固定データのみ。認証なし）。/admin と同じ部品で描く。
 *   /dev/dashboard?role=staff|administrator&state=default|empty|no-videos|no-preview
 * 既定はモック（image/dashboard.png）と同じ内容。視覚比較は tests/visual/dashboard.spec.ts。
 */
import { mockConfig, mockMediaResolver } from "@/app/dev/signage/mock-fixture";
import { AdminShell } from "@/components/admin/admin-shell";
import { Dashboard } from "@/components/admin/dashboard";
import type { DashboardData } from "@/components/admin/dashboard-types";
import { emptyDashboard, fixtureDashboard, fixtureShell } from "./fixture";

export const metadata = { title: "ダッシュボード確認（固定データ）" };

export default async function DevDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const role = params.role === "administrator" ? "administrator" : "staff";
  const state = typeof params.state === "string" ? params.state : "default";

  let data: DashboardData = fixtureDashboard;
  if (state === "empty") data = emptyDashboard;
  if (state === "no-videos" && fixtureDashboard.video) {
    data = { ...fixtureDashboard, video: { ...fixtureDashboard.video, videos: [] } };
  }
  const previewConfig = state === "empty" || state === "no-preview" ? null : mockConfig("portrait");

  return (
    <AdminShell shell={fixtureShell(role)} currentPath="/admin">
      <Dashboard data={data} previewConfig={previewConfig} resolveMediaUrl={mockMediaResolver("portrait")} />
    </AdminShell>
  );
}
