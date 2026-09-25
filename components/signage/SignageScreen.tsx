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

/** fillWindow のとき横型を縦に伸ばす上限（4:3 まで）。それより縦長のウィンドウでは上下に帯が残る */
const LANDSCAPE_MAX_HEIGHT = 1440;
/**
 * fillWindow のとき横型を横に伸ばす上限（21:9 まで）。それより横長のウィンドウでは左右に帯が残る。
 * 16:9 の画面でブラウザを最大化すると、タブやアドレスバーのぶん表示領域は 2:1 ほどの横長になる（2026-09-25 ユーザー指示）
 */
const LANDSCAPE_MAX_WIDTH = 2520;

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
  /**
   * true なら、横型をウィンドウの形に合わせて伸ばし、黒い帯を出さない。16:9 より縦長なら縦に伸ばして大きな枠に回し、
   * 横長なら横に伸ばして大きな枠と下段の 3 つの欄に回す（右の列・右上の箱・フッターの右側は右端に付いたまま動く）。
   * Web 公開のサイネージ用。端末（Pi）と管理画面のプレビューは端末の画面どおり 16:9 のまま
   */
  fillWindow?: boolean;
};

export function SignageScreen({
  config,
  now,
  resolveMediaUrl,
  orientation = config.device.orientation,
  timeSynced = true,
  fading = false,
  fit = true,
  fillWindow = false,
}: SignageScreenProps) {
  const view = buildView(config, now, timeSynced);
  const size = CANVAS_SIZE[orientation];
  // ScaledCanvas が伸ばした分（縦 --canvas-extra・横 --canvas-extra-x）だけ大きくする。伸ばさないときは 0
  const canvasWidth = `calc(${size.width}px + var(--canvas-extra-x, 0px))`;
  const canvasHeight = `calc(${size.height}px + var(--canvas-extra, 0px))`;

  const content = view.visible ? (
    <div
      className={styles.canvas}
      style={{ width: canvasWidth, height: canvasHeight }}
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
      style={{ width: canvasWidth, height: canvasHeight }}
      data-orientation={orientation}
      data-testid="signage-off"
      aria-label={COPY.offHours}
    />
  );

  return fit ? (
    <ScaledCanvas
      width={size.width}
      height={size.height}
      maxWidth={fillWindow && orientation === "landscape" ? LANDSCAPE_MAX_WIDTH : size.width}
      maxHeight={fillWindow && orientation === "landscape" ? LANDSCAPE_MAX_HEIGHT : size.height}
    >
      {content}
    </ScaledCanvas>
  ) : (
    content
  );
}
