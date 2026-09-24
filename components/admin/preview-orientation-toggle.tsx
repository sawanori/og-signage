"use client";

/**
 * サイネージプレビューの縦 / 横の切り替え。選んだ向きを cookie に保存し、画面を読み直す
 * （プレビューとダッシュボードの並びはサーバーで向きに合わせて描く）。
 */
import { RectangleHorizontal, RectangleVertical } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { Orientation } from "@/components/signage/model";
import styles from "./admin.module.css";
import { PREVIEW_ORIENTATION_COOKIE } from "./preview-orientation";

const OPTIONS = [
  { value: "portrait", label: "縦", Icon: RectangleVertical },
  { value: "landscape", label: "横", Icon: RectangleHorizontal },
] as const;

/** 選んだ向きを 1 年間覚える（/admin と確認用の /dev/dashboard の両方で読むので path=/） */
function rememberOrientation(orientation: Orientation) {
  document.cookie = `${PREVIEW_ORIENTATION_COOKIE}=${orientation}; path=/; max-age=31536000; samesite=lax`;
}

export function PreviewOrientationToggle({ value }: { value: Orientation }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const choose = (next: Orientation) => {
    if (next === value) return;
    rememberOrientation(next);
    startTransition(() => router.refresh());
  };

  return (
    <div
      className={styles.orientationToggle}
      role="group"
      aria-label="プレビューの向き"
      data-pending={pending ? "true" : "false"}
    >
      {OPTIONS.map(({ value: option, label, Icon }) => (
        <button key={option} type="button" aria-pressed={option === value} onClick={() => choose(option)}>
          <Icon size={15} strokeWidth={2} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
