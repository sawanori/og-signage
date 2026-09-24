/**
 * サイネージの表示画面。縦型（1080×1920）・横型（1920×1080）の固定キャンバスに描き、
 * 画面の大きさに合わせて拡大縮小する。
 *
 * 受け取るのは config・現在時刻・画像 URL の解決関数だけ。config の取得や時計の更新は呼び出し側が行う。
 */
import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import "@fontsource/kalam/300.css";
import "@fontsource/kalam/400.css";
import type { SignageConfig } from "@/lib/config-schema";
import { COPY } from "./copy";
import { LandscapeLayout } from "./LandscapeLayout";
import { buildView, type Orientation, type ResolveMediaUrl } from "./model";
import { UnsyncedMark } from "./parts";
import { PortraitLayout } from "./PortraitLayout";
import { ScaledCanvas } from "./ScaledCanvas";
import styles from "./signage.module.css";

export const CANVAS_SIZE: Record<Orientation, { width: number; height: number }> = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

export type SignageScreenProps = {
  config: SignageConfig;
  /** 現在時刻（UNIX 秒） */
  now: number;
  resolveMediaUrl: ResolveMediaUrl;
  /** 省略時は config.device.orientation */
  orientation?: Orientation;
  /** 時刻が同期済みか。false なら画面隅に印を出し、天気欄を隠し、表示スケジュールによる消灯をしない */
  timeSynced?: boolean;
  /** 動画へ切り替える前後のフェード中なら true（黒へ溶ける） */
  fading?: boolean;
  /** true（既定）で画面いっぱいに拡大縮小。false はキャンバス原寸（テスト・プレビュー用） */
  fit?: boolean;
};

export function SignageScreen({
  config,
  now,
  resolveMediaUrl,
  orientation = config.device.orientation,
  timeSynced = true,
  fading = false,
  fit = true,
}: SignageScreenProps) {
  const view = buildView(config, now, timeSynced);
  const size = CANVAS_SIZE[orientation];

  const content = view.visible ? (
    <div
      className={styles.canvas}
      style={{ width: size.width, height: size.height }}
      data-orientation={orientation}
      data-testid="signage-canvas"
    >
      {orientation === "portrait" ? (
        <PortraitLayout config={config} view={view} resolveMediaUrl={resolveMediaUrl} />
      ) : (
        <LandscapeLayout config={config} view={view} resolveMediaUrl={resolveMediaUrl} />
      )}
      {timeSynced ? null : <UnsyncedMark />}
      <div className={styles.fade} data-active={fading ? "true" : "false"} data-testid="fade" />
    </div>
  ) : (
    // 表示時間外。HDMI 出力を切れない端末ではこの黒画面が見える
    <div
      className={styles.off}
      style={{ width: size.width, height: size.height }}
      data-orientation={orientation}
      data-testid="signage-off"
      aria-label={COPY.offHours}
    />
  );

  return fit ? (
    <ScaledCanvas width={size.width} height={size.height}>
      {content}
    </ScaledCanvas>
  ) : (
    content
  );
}
