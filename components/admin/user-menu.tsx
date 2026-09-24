"use client";

/** ヘッダー右端のユーザー名・役割と、ログアウトを含むメニュー */
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import styles from "./admin.module.css";
import { ROLE_LABELS, type ShellUser } from "./dashboard-types";
import { LogoutButton } from "./logout-button";
import { useDismiss } from "./use-dismiss";

export function UserMenu({ user }: { user: ShellUser }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className={styles.userMenu}>
      <button
        type="button"
        className={styles.userButton}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.avatar} src={user.avatarUrl} alt="" />
        ) : (
          <span className={styles.avatar} aria-hidden>
            {[...user.name][0] ?? "?"}
          </span>
        )}
        <span className={styles.userText}>
          <span className={styles.userName} style={{ display: "block" }}>
            {user.name}
          </span>
          <span className={styles.userRole} style={{ display: "block" }}>
            {ROLE_LABELS[user.role]}
          </span>
        </span>
        <ChevronDown className={styles.chevron} aria-hidden />
      </button>
      {open ? (
        <div className={styles.popover} role="menu">
          {user.role === "administrator" ? (
            <Link href="/admin/settings" className={styles.popoverItem} role="menuitem">
              システム設定
            </Link>
          ) : null}
          <LogoutButton className={styles.popoverItem} />
        </div>
      ) : null}
    </div>
  );
}
