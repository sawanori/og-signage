/**
 * 表示スケジュール（/admin/schedule、Administrator）。曜日ごとの表示時間帯（計画 6 節の権限表）。
 */
import { ForbiddenNotice } from "@/components/admin/forbidden-notice";
import { ScheduleView } from "@/components/admin/schedule-view";
import { getDb } from "@/lib/runtime";
import { getDisplaySchedule } from "@/lib/services/schedule";
import { requirePageRole } from "../_components/require-page-role";

export const dynamic = "force-dynamic";

export const metadata = { title: "表示スケジュール | サイネージ管理" };

export default async function SchedulePage() {
  const user = await requirePageRole("administrator");
  if (!user) return <ForbiddenNotice />;

  const entries = await getDisplaySchedule(getDb());
  return <ScheduleView entries={entries} />;
}
