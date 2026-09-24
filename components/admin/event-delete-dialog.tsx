"use client";

/** イベント削除の確認ダイアログ。Esc と背景のクリックで閉じる（削除中は閉じない） */
import { useEffect, useRef } from "react";
import styles from "./events.module.css";

export function EventDeleteDialog({
  title,
  pending,
  onConfirm,
  onCancel,
}: {
  /** 削除するイベントの名前 */
  title: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  return (
    <div
      className={styles.overlay}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="event-delete-title"
        aria-describedby="event-delete-message"
      >
        <h2 id="event-delete-title" className={styles.dialogTitle}>
          イベントを削除しますか？
        </h2>
        <p id="event-delete-message" className={styles.dialogMessage}>
          「{title}」を削除します。削除すると元に戻せません。
        </p>
        <div className={styles.dialogActions}>
          <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={onCancel} disabled={pending}>
            やめる
          </button>
          <button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={pending}>
            {pending ? "削除しています…" : "削除する"}
          </button>
        </div>
      </div>
    </div>
  );
}
