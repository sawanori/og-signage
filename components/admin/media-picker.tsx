"use client";

/**
 * アップロード済みの画像から 1 枚を選ぶ（2026-09-25 ユーザー指示「画像をメディア一覧から選べるように」）。
 * 画像欄（イベント画像・ロゴ・フッター画像・お知らせ画像）の「メディア一覧から選ぶ」で開く。
 * 一覧は GET /api/media（Staff 以上）の画像だけ。選ぶと mediaId とプレビュー URL を親に返す。
 */
import { Check, ImageOff, X } from "lucide-react";
import { useRef, useState } from "react";
import styles from "./media-picker.module.css";

type ImageItem = { id: string; name: string; width: number | null; height: number | null };
type ListState = { status: "loading" } | { status: "error" } | { status: "ready"; images: ImageItem[] };

const thumbnailUrl = (mediaId: string) => `/api/media/${encodeURIComponent(mediaId)}/thumbnail`;

export function MediaPickerButton({
  className,
  disabled,
  selectedId,
  onPick,
}: {
  /** 画像欄のほかのボタンと同じ見た目にする */
  className: string;
  disabled?: boolean;
  /** 今の画像（一覧で印を付ける） */
  selectedId?: string | null;
  onPick: (mediaId: string, previewUrl: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<ListState>({ status: "loading" });

  const open = async () => {
    dialogRef.current?.showModal();
    setList({ status: "loading" });
    try {
      const res = await fetch("/api/media", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { media: (ImageItem & { type: string })[] };
      setList({ status: "ready", images: body.media.filter((m) => m.type === "image") });
    } catch {
      setList({ status: "error" });
    }
  };

  const pick = (image: ImageItem) => {
    onPick(image.id, thumbnailUrl(image.id));
    dialogRef.current?.close();
  };

  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => void open()}>
        メディア一覧から選ぶ
      </button>
      <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="media-picker-title">
        <div className={styles.head}>
          <h2 id="media-picker-title" className={styles.title}>
            メディア一覧から画像を選ぶ
          </h2>
          <button type="button" className={styles.close} aria-label="閉じる" onClick={() => dialogRef.current?.close()}>
            <X size={18} strokeWidth={2.2} aria-hidden />
          </button>
        </div>
        {list.status === "loading" ? <p className={styles.message}>読み込んでいます…</p> : null}
        {list.status === "error" ? (
          <p className={styles.message} role="alert">
            一覧を読み込めませんでした。通信の状態を確認して、もう一度お試しください
          </p>
        ) : null}
        {list.status === "ready" && list.images.length === 0 ? (
          <p className={styles.message}>
            <ImageOff size={18} strokeWidth={1.8} aria-hidden />
            画像がまだありません。「動画・メディア」でアップロードするか、この欄の「新しくアップロード」を使ってください
          </p>
        ) : null}
        {list.status === "ready" && list.images.length > 0 ? (
          <ul className={styles.grid}>
            {list.images.map((image) => {
              const selected = image.id === selectedId;
              return (
                <li key={image.id}>
                  <button
                    type="button"
                    className={styles.item}
                    aria-pressed={selected}
                    title={image.name}
                    onClick={() => pick(image)}
                  >
                    <span className={styles.thumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbnailUrl(image.id)} alt="" loading="lazy" />
                      {selected ? (
                        <span className={styles.check} aria-hidden>
                          <Check size={14} strokeWidth={3} />
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.name}>{image.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </dialog>
    </>
  );
}
