"use client";

/**
 * アップロード欄。ドラッグ＆ドロップかファイル選択で受け取り、1 件ずつ順に送る（lib/client/upload.ts）。
 * 送信中は進捗を出し、「中断」で止められる。終わるたびに一覧を読み直す。
 */
import { CircleAlert, CircleCheck, CloudUpload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { UploadError, uploadMedia, type UploadProgress } from "@/lib/client/upload";
import admin from "./admin.module.css";
import { UNPLAYABLE_MESSAGE } from "./media-types";
import styles from "./media.module.css";

const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4";

type Status = "waiting" | "uploading" | "done" | "error" | "aborted";

type QueueItem = {
  id: string;
  name: string;
  status: Status;
  phase: UploadProgress["phase"];
  sentBytes: number;
  totalBytes: number;
  /** 完了・失敗時の文言 */
  message: string | null;
  /** 完了したが、サイネージで再生できない形式の動画 */
  unplayable: boolean;
};

type Job = { id: string; file: File; controller: AbortController };

function percent(item: QueueItem): number {
  if (item.status === "done" || item.phase === "completing") return 100;
  if (item.totalBytes === 0) return 0;
  return Math.floor((item.sentBytes / item.totalBytes) * 100);
}

function statusText(item: QueueItem): string {
  switch (item.status) {
    case "waiting":
      return "順番待ち";
    case "aborted":
      return "中断しました";
    case "error":
    case "done":
      return item.message ?? "";
    case "uploading":
      if (item.phase === "preparing") return "準備しています…";
      if (item.phase === "completing") return "仕上げています…";
      return `${percent(item)}%`;
  }
}

export function UploadDropzone() {
  const router = useRouter();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queue = useRef<Job[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(false);

  const update = (id: string, patch: Partial<QueueItem>) =>
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const run = async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length > 0) {
      const job = queue.current.shift()!;
      if (job.controller.signal.aborted) continue;
      update(job.id, { status: "uploading", phase: "preparing" });
      try {
        const media = await uploadMedia(job.file, {
          signal: job.controller.signal,
          onProgress: (p) => update(job.id, { phase: p.phase, sentBytes: p.sentBytes, totalBytes: p.totalBytes }),
        });
        const unplayable = media.type === "video" && !media.playable;
        update(job.id, {
          status: "done",
          unplayable,
          message: unplayable ? UNPLAYABLE_MESSAGE : "アップロードしました",
        });
        router.refresh();
      } catch (e) {
        if (job.controller.signal.aborted) {
          update(job.id, { status: "aborted" });
        } else {
          update(job.id, {
            status: "error",
            message:
              e instanceof UploadError
                ? e.message
                : "アップロードできませんでした。通信状態を確かめて、もう一度お試しください",
          });
        }
      } finally {
        controllers.current.delete(job.id);
      }
    }
    running.current = false;
  };

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: QueueItem[] = [];
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      queue.current.push({ id, file, controller });
      added.push({
        id,
        name: file.name,
        status: "waiting",
        phase: "preparing",
        sentBytes: 0,
        totalBytes: file.size,
        message: null,
        unplayable: false,
      });
    }
    setItems((prev) => [...prev, ...added]);
    void run();
  };

  const abort = (item: QueueItem) => {
    controllers.current.get(item.id)?.abort();
    if (item.status === "waiting") update(item.id, { status: "aborted" });
  };

  const dismiss = (id: string) => setItems((prev) => prev.filter((item) => item.id !== id));

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <section className={`${admin.card} ${styles.uploadCard}`} aria-label="アップロード">
      <h2 className={admin.cardTitleSmall}>アップロード</h2>
      <div
        className={styles.dropzone}
        data-over={dragOver ? "true" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <CloudUpload className={styles.dropIcon} strokeWidth={1.6} aria-hidden />
        <p className={styles.dropText}>ここに画像や動画をドラッグ＆ドロップ</p>
        <button type="button" className={`${admin.outlineButton} ${styles.pickButton}`} onClick={() => inputRef.current?.click()}>
          ファイルを選ぶ
        </button>
        <p className={styles.dropHint}>画像は JPEG・PNG・WebP（20MB まで）、動画は MP4（15 秒・60MB・3 本まで）</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 ? (
        <ul className={styles.queue} aria-label="アップロードの状況">
          {items.map((item) => {
            const active = item.status === "waiting" || item.status === "uploading";
            const tone = item.status === "error" || item.unplayable ? "error" : item.status === "done" ? "done" : undefined;
            return (
              <li key={item.id} className={styles.queueItem}>
                <div className={styles.queueHead}>
                  {tone === "error" ? (
                    <CircleAlert className={styles.queueIcon} data-tone="error" aria-hidden />
                  ) : tone === "done" ? (
                    <CircleCheck className={styles.queueIcon} data-tone="done" aria-hidden />
                  ) : null}
                  <p className={styles.queueName} title={item.name}>
                    {item.name}
                  </p>
                  {active ? (
                    <button type="button" className={styles.queueAction} onClick={() => abort(item)}>
                      中断
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.queueClose}
                      aria-label="表示を消す"
                      onClick={() => dismiss(item.id)}
                    >
                      <X size={14} strokeWidth={2.2} aria-hidden />
                    </button>
                  )}
                </div>
                {item.status === "uploading" ? (
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-label={`${item.name} の進み具合`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent(item)}
                    data-indeterminate={item.phase === "preparing" ? "true" : undefined}
                  >
                    <span style={{ width: `${percent(item)}%` }} />
                  </div>
                ) : null}
                <p className={styles.queueStatus} data-tone={tone} role={tone === "error" ? "alert" : undefined}>
                  {statusText(item)}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
