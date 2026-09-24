"use client";

/**
 * 定期動画の設定（ルーティン再生）。ON/OFF・間隔・順番再生を端末の動画設定として保存する。
 * 次回の予定は端末（Heartbeat）が報告した値で、報告を受けた時刻を添える。
 */
import { Check, CircleHelp, Play, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateDevicePlaybackSettingsAction } from "@/app/admin/_actions/playback";
import { VIDEO_INTERVAL_MINUTES } from "@/lib/config-schema";
import styles from "./admin.module.css";
import type { DashboardVideoSettings } from "./dashboard-types";
import { formatDuration, formatHm } from "./format";

const HELP =
  "イベント表示の合間に、設定した間隔で動画を 1 本ずつ全画面で再生します。間隔は前の動画が終わってから次の動画が始まるまでの時間です。";

export function VideoSettingsCard({ video }: { video: DashboardVideoSettings | null }) {
  return (
    <section className={`${styles.card} ${styles.videoCard}`} aria-label="定期動画の設定">
      {video ? (
        <VideoSettingsForm video={video} />
      ) : (
        <>
          <div className={styles.cardHeadRow}>
            <h2 className={styles.cardTitleSmall}>定期動画の設定（ルーティン再生）</h2>
          </div>
          <div className={`${styles.empty} ${styles.cardEmptyBody}`}>
            <p>サイネージ端末が登録されていません。端末を登録すると、動画の設定ができます。</p>
          </div>
        </>
      )}
    </section>
  );
}

function nextVideoText(video: DashboardVideoSettings): string {
  if (!video.enabled) return "";
  if (video.nextVideoAt === null || video.observedAt === null) return "次回の予定はまだ届いていません";
  return `次回 ${formatHm(video.nextVideoAt)} ごろ（${formatHm(video.observedAt)} 時点）`;
}

function VideoSettingsForm({ video }: { video: DashboardVideoSettings }) {
  const [settings, setSettings] = useState(video);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = (patch: Partial<Pick<DashboardVideoSettings, "enabled" | "intervalMinutes" | "mode">>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    startTransition(async () => {
      const result = await updateDevicePlaybackSettingsAction(next.deviceId, {
        revision: next.revision,
        enabled: next.enabled,
        intervalMinutes: next.intervalMinutes,
        mode: next.mode,
        volume: next.volume,
      });
      if (result.ok) {
        setError(null);
        setSettings((s) => ({ ...s, revision: result.data.revision }));
      } else {
        setSettings(settings);
        setError(result.error.message);
        if (result.error.code === "conflict") router.refresh();
      }
    });
  };

  return (
    <>
      <div className={styles.cardHeadRow}>
        <h2 className={styles.cardTitleSmall}>定期動画の設定（ルーティン再生）</h2>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-label="定期動画"
          className={styles.toggle}
          disabled={pending}
          onClick={() => save({ enabled: !settings.enabled })}
        >
          {settings.enabled ? "ON" : "OFF"}
        </button>
        <span title={HELP} aria-label={HELP} role="img" style={{ display: "inline-flex" }}>
          <CircleHelp className={styles.helpIcon} strokeWidth={2} aria-hidden />
        </span>
      </div>
      <p className={styles.cardSub}>
        <span>設定した間隔で、イベントの合間に動画を再生します。</span>
        <span className={styles.nextVideo}>{nextVideoText(settings)}</span>
      </p>
      <div className={styles.videoLabelRow}>
        <p className={styles.fieldLabel}>
          再生する動画<span className={styles.fieldHint}>（{settings.mode === "sequence" ? "順番に再生されます" : "ランダムに再生されます"}）</span>
        </p>
        <select
          className={`${styles.select} ${styles.intervalSelect}`}
          aria-label="動画の間隔"
          value={settings.intervalMinutes}
          disabled={pending}
          onChange={(e) => save({ intervalMinutes: Number(e.target.value) })}
        >
          {VIDEO_INTERVAL_MINUTES.map((m) => (
            <option key={m} value={m}>
              {m}分ごと
            </option>
          ))}
        </select>
      </div>
      <div className={styles.videoStrip}>
        {settings.videos.length === 0 ? (
          <p className={styles.videoEmpty}>動画が登録されていません</p>
        ) : (
          settings.videos.slice(0, 3).map((v) => (
            <div key={v.mediaId} className={styles.videoItem}>
              <div className={styles.videoThumb}>
                {v.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumbnailUrl} alt="" />
                ) : null}
                <span className={styles.playMark} aria-hidden>
                  <Play size={11} fill="currentColor" strokeWidth={0} />
                </span>
              </div>
              <p className={styles.videoName} title={v.name}>
                {v.name}
              </p>
              <p className={styles.videoDuration}>{formatDuration(v.durationSeconds)}</p>
            </div>
          ))
        )}
        <Link href="/admin/videos" className={styles.addVideo} style={{ gridColumn: 4 }}>
          <Plus size={16} strokeWidth={1.6} color="#8a97aa" aria-hidden />
          動画を追加
        </Link>
      </div>
      <div className={styles.videoFoot}>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={settings.mode === "sequence"}
            disabled={pending}
            onChange={(e) => save({ mode: e.target.checked ? "sequence" : "random" })}
          />
          <span className={styles.checkMark} aria-hidden>
            <Check size={14} strokeWidth={3} />
          </span>
          <span>
            順番に再生する<span className={styles.checkHint}>（最後の動画の後、最初に戻ります）</span>
          </span>
        </label>
        <Link href="/admin/videos" className={styles.textLink}>
          詳細設定を開く
        </Link>
      </div>
      {error ? (
        <p className={styles.cardError} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
