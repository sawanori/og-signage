/**
 * ダッシュボード本体（image/dashboard.png の配置）。/admin と /dev/dashboard が同じ部品で描く。
 */
import type { Orientation, ResolveMediaUrl } from "@/components/signage/model";
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
  previewOrientation,
  resolveMediaUrl,
}: {
  data: DashboardData;
  /** 端末の config。まだ用意できなければ null（プレビューは空状態） */
  previewConfig: SignageConfig | null;
  /** プレビューの向き（管理画面で選んだもの。未選択なら端末の向き） */
  previewOrientation: Orientation;
  resolveMediaUrl: ResolveMediaUrl;
}) {
  const preview = (
    <PreviewCard
      device={data.device}
      config={previewConfig}
      now={data.now}
      resolveMediaUrl={resolveMediaUrl}
      orientation={previewOrientation}
    />
  );

  if (previewOrientation === "landscape") {
    // 横長のプレビューは右の列の上に置き、空いた下へ「今日のイベント」と「お知らせ表示」を移す。
    // 左の列はカレンダー・イベント一覧・定期動画の設定を列の幅いっぱいに並べる（イベント一覧の幅は縦のときと同じ）
    return (
      <div className={styles.grid} data-preview="landscape">
        <div className={styles.leftColumn}>
          <WeekCalendar events={data.events} now={data.now} />
          <EventListCard events={data.events} now={data.now} />
          <VideoSettingsCard video={data.video} />
        </div>
        <div className={styles.rightColumn}>
          {preview}
          <TodayEventCard events={data.events} now={data.now} />
          <NoticeCard notice={data.notice} />
        </div>
      </div>
    );
  }

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
      {preview}
    </div>
  );
}
