/**
 * 管理画面の枠（左のサイドバーと上のヘッダー）。/admin の layout と /dev/dashboard が共用する。
 */
import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import { House, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./admin.module.css";
import type { ShellData } from "./dashboard-types";
import { NotificationBell } from "./notification-bell";
import { SidebarNav } from "./sidebar-nav";
import { UserMenu } from "./user-menu";
import { ADMIN_BRAND, ADMIN_PRODUCT } from "./brand";

export function AdminShell({
  shell,
  currentPath,
  children,
}: {
  shell: ShellData;
  /** 現在地の強調に使うパス。省略時は URL から決める（/dev/dashboard は "/admin" を渡す） */
  currentPath?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <House className={styles.brandIcon} strokeWidth={1.9} aria-hidden />
          <div>
            <p className={styles.brandName}>{ADMIN_BRAND}</p>
            <p className={styles.brandSub}>{ADMIN_PRODUCT}</p>
          </div>
        </div>
        <SidebarNav role={shell.user.role} currentPath={currentPath} />
        <div className={styles.sideCard}>
          {shell.sidebarImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.sideCardImage} src={shell.sidebarImageUrl} alt="" />
          ) : null}
        </div>
        <p className={styles.sideFooter}>{ADMIN_BRAND}</p>
      </aside>

      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.greeting}>
            <h1 className={styles.greetingTitle}>
              こんにちは、{shell.user.name}さん
              <span className={styles.emoji} aria-hidden>
                👋
              </span>
            </h1>
            <p className={styles.greetingSub}>今日も素敵な１日になりますように。</p>
          </div>
          <Link href="/admin/events/new" className={styles.createButton}>
            <Plus size={22} strokeWidth={2.4} aria-hidden />
            新しいイベントを作成
          </Link>
          <div className={styles.headerTools}>
            <NotificationBell alerts={shell.alerts} />
            <UserMenu user={shell.user} />
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
