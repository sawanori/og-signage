/**
 * ダッシュボードのサイネージプレビューの向き（縦 / 横。2026-09-25 ユーザー指示）。
 * 管理画面で選んだ向きを cookie に覚える。選んでいなければ端末の向きで描く。
 */
import type { Orientation } from "@/components/signage/model";

export const PREVIEW_ORIENTATION_COOKIE = "og_preview_orientation";

export function parsePreviewOrientation(value: string | null | undefined): Orientation | null {
  return value === "portrait" || value === "landscape" ? value : null;
}
