/**
 * サイネージプレビュー。表示ページと同じ部品（SignageScreen）を縮小して描く。
 *
 * config は呼び出し側が渡す（端末ごとの config の組み立ては lib/config-builder.ts、配線は task_014b）。
 * config が無いときは空状態を出す。画像 URL の解決関数を受け取るため、サーバー部品として使う。
 */
import { CANVAS_SIZE, SignageScreen } from "@/components/signage/SignageScreen";
import type { ResolveMediaUrl } from "@/components/signage/model";
import type { SignageConfig } from "@/lib/config-schema";
import styles from "./admin.module.css";
import { ScaleBox } from "./scale-box";

/** モック（1536×1024）でのプレビュー画面の幅 */
const MOCK_SCREEN_WIDTH = 351;

export type SignagePreviewProps = {
  config: SignageConfig | null;
  /** 現在時刻（UNIX 秒） */
  now: number;
  resolveMediaUrl: ResolveMediaUrl;
  /** 空状態の文言 */
  emptyMessage?: string;
};

export function SignagePreview({
  config,
  now,
  resolveMediaUrl,
  emptyMessage = "プレビューはまだ表示できません。",
}: SignagePreviewProps) {
  if (!config) {
    return (
      <div className={styles.previewEmpty} data-testid="signage-preview-empty">
        <p>{emptyMessage}</p>
      </div>
    );
  }
  const size = CANVAS_SIZE[config.device.orientation];
  return (
    <div className={styles.bezel} data-testid="signage-preview">
      <ScaleBox width={size.width} height={size.height} initialWidth={MOCK_SCREEN_WIDTH}>
        <SignageScreen config={config} now={now} resolveMediaUrl={resolveMediaUrl} fit={false} />
      </ScaleBox>
    </div>
  );
}
