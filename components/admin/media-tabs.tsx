/** 動画・メディア画面の上のタブ（メディア一覧 / 定期動画の設定） */
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./media.module.css";

const TABS = [
  { href: "/admin/media", label: "メディア一覧" },
  { href: "/admin/videos", label: "定期動画の設定" },
] as const;

export function MediaTabs({ current, children }: { current: (typeof TABS)[number]["href"]; children?: ReactNode }) {
  return (
    <div className={styles.tabsRow}>
      <nav className={styles.tabs} aria-label="動画・メディア">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={styles.tab}
            aria-current={tab.href === current ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
