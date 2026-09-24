/**
 * ダッシュボード本体（image/dashboard.png の配置）。/admin と /dev/dashboard が同じ部品で描く。
 */
import type { ResolveMediaUrl } from "@/components/signage/model";
import type { SignageConfig } from "@/lib/config-schema";
import styles from "./admin.module.css";
import type { DashboardData } from "./dashboard-types";
import { EventListCard } from "./event-list-card";
import { NoticeCard } from "./notice-card";
import { PreviewCard } from "./preview-card";
import { TodayEventCard } from "./today-event-card";
import { VideoSettingsCard } from "./video-settings-card";
import { WeekCalendar } from "./week-calendar";

export function Dashboard({
  data,
  previewConfig,
  resolveMediaUrl,
}: {
  data: DashboardData;
  /** 端末の config。まだ用意できなければ null（プレビューは空状態） */
  previewConfig: SignageConfig | null;
  resolveMediaUrl: ResolveMediaUrl;
}) {
  return (
    <div className={styles.grid}>
      <div className={styles.leftColumn}>
        <div className={styles.topRow}>
          <WeekCalendar events={data.events} now={data.now} />
          <TodayEventCard events={data.events} now={data.now} />
        </div>
        <EventListCard events={data.events} now={data.now} />
        <div className={styles.bottomRow}>
          <VideoSettingsCard video={data.video} />
          <NoticeCard notice={data.notice} />
        </div>
      </div>
      <PreviewCard device={data.device} config={previewConfig} now={data.now} resolveMediaUrl={resolveMediaUrl} />
    </div>
  );
}
