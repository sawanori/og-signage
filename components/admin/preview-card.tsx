/**
 * サイネージプレビュー欄と端末の状態（オンライン / オフライン / 表示異常、設置場所名、テスト表示）。
 */
import { Maximize } from "lucide-react";
import Link from "next/link";
import type { Orientation, ResolveMediaUrl } from "@/components/signage/model";
import type { SignageConfig } from "@/lib/config-schema";
import styles from "./admin.module.css";
import type { DashboardDevice } from "./dashboard-types";
import { formatHm, formatMonthDay } from "./format";
import { PreviewOrientationToggle } from "./preview-orientation-toggle";
import { SignagePreview } from "./signage-preview";
import { TestPlayButton } from "./test-play-button";

const STATUS_LABELS = { online: "オンライン", offline: "オフライン", display_error: "表示異常" } as const;

function lastSeenText(device: DashboardDevice, now: number): string {
  if (device.lastSeenAt === null) return "まだ通信がありません";
  const sameDay = formatMonthDay(device.lastSeenAt) === formatMonthDay(now);
  return `最終通信 ${sameDay ? "" : `${formatMonthDay(device.lastSeenAt)} `}${formatHm(device.lastSeenAt)}`;
}

export function PreviewCard({
  device,
  config,
  now,
  resolveMediaUrl,
  orientation,
}: {
  device: DashboardDevice | null;
  config: SignageConfig | null;
  now: number;
  resolveMediaUrl: ResolveMediaUrl;
  /** プレビューの向き（管理画面で選んだもの。未選択なら端末の向き） */
  orientation: Orientation;
}) {
  return (
    <section
      className={`${styles.card} ${styles.previewCard}`}
      aria-label="サイネージプレビュー"
      data-orientation={orientation}
    >
      <div className={styles.previewHead}>
        <h2 className={styles.cardTitleSmall}>サイネージプレビュー</h2>
        {device ? (
          <div className={styles.previewTools}>
            <PreviewOrientationToggle value={orientation} />
            <Link
              href={`/admin/devices/${device.id}/preview?orientation=${orientation}`}
              className={styles.previewExpand}
              aria-label="プレビューを大きく表示"
            >
              <Maximize size={18} strokeWidth={2} aria-hidden />
            </Link>
          </div>
        ) : null}
      </div>
      <div className={styles.previewArea}>
        {device ? (
          <SignagePreview config={config} now={now} resolveMediaUrl={resolveMediaUrl} orientation={orientation} />
        ) : (
          <div className={styles.previewEmpty} data-testid="signage-preview-empty">
            <p>
              サイネージ端末が登録されていません。
              <br />
              端末を登録すると、ここに表示内容が出ます。
            </p>
          </div>
        )}
      </div>
      {device ? (
        <div className={styles.deviceBar} title={lastSeenText(device, now)}>
          <span className={styles.statusDot} data-status={device.status} aria-hidden />
          <span className={styles.statusLabel}>{STATUS_LABELS[device.status]}</span>
          <span className={styles.deviceSep} aria-hidden />
          <span className={styles.deviceName}>
            {device.name}
            {device.status === "online" ? null : `（${lastSeenText(device, now)}）`}
          </span>
          <TestPlayButton deviceId={device.id} />
        </div>
      ) : null}
    </section>
  );
}
