"use client";

/**
 * イベント画像の選択とアップロード（lib/client/upload.ts）。進捗を出し、終わったら画像の ID を返す。
 * アップロード済みの画像から選ぶこともできる（media-picker.tsx。2026-09-25 ユーザー指示）。
 */
import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { UploadError, uploadMedia, type UploadProgress } from "@/lib/client/upload";
import { mediaThumbnailUrl } from "./event-types";
import { MediaPickerButton } from "./media-picker";
import styles from "./events.module.css";

const ACCEPT = "image/jpeg,image/png,image/webp";

function progressLabel(p: UploadProgress): string {
  if (p.phase === "preparing") return "画像を準備しています…";
  if (p.phase === "completing") return "仕上げています…";
  const percent = p.totalBytes > 0 ? Math.floor((p.sentBytes / p.totalBytes) * 100) : 0;
  return `アップロードしています… ${percent}%`;
}

function progressPercent(p: UploadProgress): number {
  if (p.phase === "preparing") return 3;
  if (p.phase === "completing") return 100;
  return p.totalBytes > 0 ? Math.max(3, Math.floor((p.sentBytes / p.totalBytes) * 100)) : 3;
}

export function EventImageField({
  previewUrl,
  onUploaded,
  onRemove,
  onBusyChange,
}: {
  /** 今の画像。無ければ null */
  previewUrl: string | null;
  onUploaded: (mediaId: string, previewUrl: string) => void;
  onRemove: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const upload = async (file: File) => {
    setError(null);
    if (!ACCEPT.split(",").includes(file.type)) {
      setError("画像は JPEG・PNG・WebP のファイルを選んでください");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    onBusyChange(true);
    setProgress({ phase: "preparing", sentBytes: 0, totalBytes: file.size });
    try {
      const media = await uploadMedia(file, { onProgress: setProgress, signal: controller.signal });
      if (media.type !== "image") throw new UploadError("画像のファイルを選んでください");
      onUploaded(media.id, mediaThumbnailUrl(media.id));
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof UploadError ? e.message : "画像をアップロードできませんでした。通信の状態を確認して、もう一度お試しください");
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      onBusyChange(false);
    }
  };

  const busy = progress !== null;

  return (
    <div>
      <div className={styles.imageBox}>
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.imagePreview} src={previewUrl} alt="イベント画像" />
        ) : (
          <div className={styles.imageEmpty}>
            <ImagePlus size={30} strokeWidth={1.6} aria-hidden />
            <span>画像はまだありません</span>
          </div>
        )}
        {busy ? (
          <div className={styles.imageProgress} role="status">
            <span>{progressLabel(progress)}</span>
            <span className={styles.progressTrack}>
              <span className={styles.progressBar} style={{ width: `${progressPercent(progress)}%` }} />
            </span>
          </div>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label="画像ファイル"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
      <div className={styles.imageActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => inputRef.current?.click()}>
          新しくアップロード
        </button>
        <MediaPickerButton
          className={styles.secondaryButton}
          disabled={busy}
          onPick={(mediaId, url) => {
            setError(null);
            onUploaded(mediaId, url);
          }}
        />
        {previewUrl ? (
          <button type="button" className={styles.textButton} disabled={busy} onClick={onRemove}>
            画像を外す
          </button>
        ) : null}
      </div>
      <p className={styles.hint}>JPEG・PNG・WebP（20MB まで）。画像がないときはカテゴリの色で表示されます。</p>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
