"use client";

/** 取り消せない操作の前の確認（端末のトークン再発行・削除、ユーザーの無効化・降格） */
import { useEffect, useRef } from "react";
import d from "./devices.module.css";

export type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={d.overlay} onClick={onClose}>
      <div
        className={d.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-title" className={d.dialogTitle}>
          {request.title}
        </h3>
        <p id="confirm-body" className={d.dialogBody}>
          {request.body}
        </p>
        <div className={d.dialogActions}>
          <button ref={cancelRef} type="button" className={d.secondaryButton} onClick={onClose}>
            やめる
          </button>
          <button
            type="button"
            className={`${d.primaryButton} ${request.danger ? d.primaryDanger : ""}`}
            onClick={() => {
              onClose();
              request.onConfirm();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
