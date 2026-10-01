"use client";

/** ヘッダーの通知ベル。端末の不調やメンバー紹介の確認待ちなどの知らせがあれば赤い点を出す */
import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import styles from "./admin.module.css";
import type { ShellAlert } from "./dashboard-types";
import { useDismiss } from "./use-dismiss";

export function NotificationBell({ alerts }: { alerts: ShellAlert[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className={styles.userMenu}>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={alerts.length > 0 ? `お知らせ ${alerts.length} 件` : "お知らせ"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={25} strokeWidth={1.7} aria-hidden />
        {alerts.length > 0 ? <span className={styles.bellDot} /> : null}
      </button>
      {open ? (
        <div className={styles.popover} role="dialog" aria-label="お知らせ">
          {alerts.length === 0 ? (
            <p className={styles.popoverNote}>新しいお知らせはありません</p>
          ) : (
            alerts.map((a) =>
              a.href ? (
                <Link
                  key={a.id}
                  href={a.href}
                  className={styles.popoverNote}
                  style={{ display: "block", color: "var(--ink)", textDecoration: "underline" }}
                  onClick={close}
                >
                  {a.message}
                </Link>
              ) : (
                <p key={a.id} className={styles.popoverNote} style={{ color: "var(--ink)" }}>
                  {a.message}
                </p>
              ),
            )
          )}
        </div>
      ) : null}
    </div>
  );
}
