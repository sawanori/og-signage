"use client";

/**
 * サイドバーの項目。Administrator 専用の画面（計画 6 節の権限表）は Staff には出さない。
 */
import { BookOpen, Bell, CalendarDays, Clock, House, Monitor, Palette, SquarePlay, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/auth";
import styles from "./admin.module.css";
import { HomeFillIcon } from "./icons";

type NavItem = { href: string; label: string; icon: LucideIcon; adminOnly?: boolean };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/admin", label: "ダッシュボード", icon: House },
  { href: "/admin/events", label: "イベント管理", icon: CalendarDays },
  { href: "/admin/media", label: "動画・メディア", icon: SquarePlay },
  { href: "/admin/schedule", label: "表示スケジュール", icon: Clock, adminOnly: true },
  { href: "/admin/devices", label: "サイネージ端末", icon: Monitor, adminOnly: true },
  { href: "/admin/design", label: "デザイン設定", icon: Palette, adminOnly: true },
  { href: "/admin/notices", label: "お知らせ", icon: Bell },
  { href: "/admin/guide", label: "利用ガイド", icon: BookOpen },
];

export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === "administrator");
}

function isCurrent(href: string, path: string): boolean {
  if (href === "/admin") return path === "/admin";
  return path === href || path.startsWith(`${href}/`);
}

export function SidebarNav({ role, currentPath }: { role: Role; currentPath?: string }) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  return (
    <nav className={styles.nav} aria-label="メニュー">
      {visibleNavItems(role).map(({ href, label, icon: Icon }) => {
        const current = isCurrent(href, path);
        return (
          <Link key={href} href={href} className={styles.navItem} aria-current={current ? "page" : undefined}>
            {current && href === "/admin" ? (
              <HomeFillIcon className={styles.navIcon} />
            ) : (
              <Icon className={styles.navIcon} aria-hidden />
            )}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
