"use client";

/**
 * 画像1枚の選択・アップロード（lib/client/upload.ts）。お知らせ画像・ロゴ・フッター画像で共用する。
 * アップロードが終わると mediaId とプレビュー URL（/api/media/[id]/thumbnail）を親に返す。
 * アップロード済みの画像から選ぶこともできる（media-picker.tsx。2026-09-25 ユーザー指示）。
 */
import { ImagePlus } from "lucide-react";
import { useRef, useState } from "react";
import { UploadError, uploadMedia, type UploadProgress } from "@/lib/client/upload";
import { MediaPickerButton } from "./media-picker";
import styles from "./settings.module.css";

const ACCEPT = "image/jpeg,image/png,image/webp";

function progressPercent(p: UploadProgress): number {
  if (p.phase === "preparing") return 4;
  if (p.phase === "completing") return 100;
  return p.totalBytes > 0 ? Math.max(4, Math.floor((p.sentBytes / p.totalBytes) * 100)) : 4;
}

export function mediaThumbnailUrl(mediaId: string): string {
  return `/api/media/${encodeURIComponent(mediaId)}/thumbnail`;
}

export function MediaUploadField({
  label,
  hint,
  previewUrl,
  selectedId,
  disabled,
  onBusyChange,
  onChange,
}: {
  label: string;
  hint?: string;
  /** 今の画像。無ければ null */
  previewUrl: string | null;
  /** 今の画像の mediaId（メディア一覧で印を付ける） */
  selectedId?: string | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onChange: (mediaId: string | null, previewUrl: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  const upload = async (file: File) => {
    setError(null);
    if (!ACCEPT.split(",").includes(file.type)) {
      setError("画像は JPEG・PNG・WebP のファイルを選んでください");
      return;
    }
    onBusyChange?.(true);
    setProgress({ phase: "preparing", sentBytes: 0, totalBytes: file.size });
    try {
      const uploaded = await uploadMedia(file, { onProgress: setProgress });
      if (uploaded.type !== "image") throw new UploadError("画像のファイルを選んでください");
      onChange(uploaded.id, mediaThumbnailUrl(uploaded.id));
    } catch (e) {
      setError(e instanceof UploadError ? e.message : "アップロードできませんでした。通信の状態を確認して、もう一度お試しください");
    } finally {
      setProgress(null);
      onBusyChange?.(false);
    }
  };

  return (
    <div className={styles.field}>
      <p className={styles.label}>{label}</p>
      <div className={styles.imageField}>
        <div className={styles.imagePreviewBox}>
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="" />
          ) : (
            <ImagePlus size={24} strokeWidth={1.6} aria-hidden />
          )}
        </div>
        <div className={styles.imageMeta}>
          <div className={styles.imageActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              新しくアップロード
            </button>
            <MediaPickerButton
              className={styles.secondaryButton}
              disabled={disabled || busy}
              selectedId={selectedId}
              onPick={(mediaId, url) => {
                setError(null);
                onChange(mediaId, url);
              }}
            />
            {previewUrl ? (
              <button type="button" className={styles.textButton} disabled={disabled || busy} onClick={() => onChange(null, null)}>
                画像を外す
              </button>
            ) : null}
          </div>
          {busy ? (
            <div className={styles.progressTrack} role="status" aria-label="アップロード中">
              <div className={styles.progressBar} style={{ width: `${progressPercent(progress)}%` }} />
            </div>
          ) : null}
          {hint ? <p className={styles.hint}>{hint}</p> : null}
          {error ? (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label={label}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
