"use client";

/**
 * メディア一覧。種類で絞り込み、再生できるか・端末で失敗した記録を出し、削除する。
 * 使用中（イベント・お知らせ・デザイン設定・再生リストから参照）のものは削除できず、理由を出す。
 */
import { CircleAlert, Film, Image as ImageIcon, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import admin from "./admin.module.css";
import { formatDuration, formatHm, formatMonthDay } from "./format";
import { UNPLAYABLE_MESSAGE, type MediaFailureView, type MediaListItem } from "./media-types";
import styles from "./media.module.css";

type Filter = "all" | "video" | "image";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "video", label: "動画" },
  { value: "image", label: "画像" },
];

const FAILURE_LABELS: Record<MediaFailureView["reason"], string> = {
  download_failed: "端末に取り込めませんでした",
  hash_mismatch: "端末に正しく取り込めませんでした",
  playback_failed: "端末で再生できませんでした",
};

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function failureText(f: MediaFailureView): string {
  const when = `${formatMonthDay(f.lastAt)} ${formatHm(f.lastAt)}`;
  const stopped = f.quarantined ? "。この端末では使うのを止めています" : "";
  return `${f.deviceName}：${FAILURE_LABELS[f.reason]}（${f.count} 回・最後は ${when}）${stopped}`;
}

export function MediaLibrary({ items }: { items: MediaListItem[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = filter === "all" ? items : items.filter((item) => item.type === filter);

  return (
    <section className={`${admin.card} ${admin.listCard} ${styles.libraryCard}`} aria-label="メディア一覧">
      <div className={admin.listHead}>
        <h2 className={admin.listTitle}>メディア一覧</h2>
        <span className={styles.count}>{shown.length} 件</span>
        <div className={admin.chips} role="group" aria-label="種類で絞り込む">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={admin.chip}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className={`${admin.empty} ${styles.libraryEmpty}`}>
          <p>{items.length === 0 ? "まだ画像や動画がありません。上の欄からアップロードしてください。" : "該当するものがありません"}</p>
        </div>
      ) : (
        <ul className={styles.mediaRows}>
          {shown.map((item) => (
            <MediaRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MediaRow({ item }: { item: MediaListItem }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isVideo = item.type === "video";

  const remove = () => {
    if (!window.confirm(`「${item.name}」を削除しますか？`)) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/media/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        if (res.ok) {
          setError(null);
          router.refresh();
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "削除できませんでした。時間をおいて、もう一度お試しください");
      } catch {
        setError("削除できませんでした。通信状態を確かめて、もう一度お試しください");
      }
    });
  };

  const meta = [
    formatFileSize(item.fileSize),
    isVideo ? formatDuration(item.durationSeconds) : null,
    item.width && item.height ? `${item.width}×${item.height}` : null,
    `${formatMonthDay(item.createdAt)}に追加`,
  ].filter((v): v is string => v !== null);

  const notes: { text: string; alert: boolean }[] = [];
  if (isVideo && !item.playable) notes.push({ text: UNPLAYABLE_MESSAGE, alert: false });
  for (const f of item.failures) notes.push({ text: failureText(f), alert: false });
  if (error) notes.push({ text: error, alert: true });

  return (
    <li className={styles.mediaRow}>
      <div className={styles.mediaThumb} data-kind={item.type}>
        {item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnailUrl} alt="" loading="lazy" />
        ) : isVideo ? (
          <Film size={24} strokeWidth={1.6} aria-hidden />
        ) : (
          <ImageIcon size={24} strokeWidth={1.6} aria-hidden />
        )}
        {isVideo && item.thumbnailUrl ? (
          <span className={admin.playMark} aria-hidden>
            <Play size={11} fill="currentColor" strokeWidth={0} />
          </span>
        ) : null}
      </div>
      <div className={styles.mediaMain}>
        <span className={`${admin.tag} ${styles.kindTag}`} data-kind={item.type}>
          {isVideo ? "動画" : "画像"}
        </span>
        <p className={styles.mediaName} title={item.name}>
          {item.name}
        </p>
        <p className={styles.mediaMeta}>{meta.join("　・　")}</p>
      </div>
      <div className={styles.mediaState}>
        {isVideo ? (
          <span className={styles.playState} data-ok={item.playable ? "true" : "false"}>
            <span className={styles.playDot} aria-hidden />
            {item.playable ? "サイネージで再生できます" : "再生できない形式"}
          </span>
        ) : null}
        {item.failures.length > 0 ? (
          <span className={styles.failState}>
            <CircleAlert size={14} strokeWidth={2.2} aria-hidden />
            端末で失敗した記録あり
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={`${admin.outlineButton} ${styles.deleteButton}`}
        disabled={pending}
        onClick={remove}
      >
        {pending ? "削除中…" : "削除"}
      </button>
      {notes.length > 0 ? (
        <ul className={styles.mediaNotes}>
          {notes.map((note) => (
            <li key={note.text} className={styles.mediaNote} role={note.alert ? "alert" : undefined}>
              <CircleAlert size={13} strokeWidth={2.2} aria-hidden />
              {note.text}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
