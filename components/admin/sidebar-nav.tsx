"use client";

/**
 * サイドバーの項目。Administrator 専用の画面（計画 6 節の権限表）は Staff には出さない。
 */
import { BookOpen, Bell, CalendarDays, House, Monitor, Palette, Sparkles, SquarePlay, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/auth";
import styles from "./admin.module.css";
import { HomeFillIcon } from "./icons";

/** alsoCurrentFor: href 以外で選択中にするパス（その下の階層も含む） */
type NavItem = { href: string; label: string; icon: LucideIcon; adminOnly?: boolean; alsoCurrentFor?: readonly string[] };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/admin", label: "ダッシュボード", icon: House },
  { href: "/admin/events", label: "イベント管理", icon: CalendarDays },
  { href: "/admin/media", label: "動画・メディア", icon: SquarePlay, alsoCurrentFor: ["/admin/videos"] },
  { href: "/admin/devices", label: "サイネージ端末", icon: Monitor, adminOnly: true },
  { href: "/admin/design", label: "デザイン設定", icon: Palette, adminOnly: true },
  { href: "/admin/notices", label: "お知らせ", icon: Bell },
  // サイネージの「MEMBER SPOTLIGHT」の欄（2026-09-26 ユーザー指示）。Staff も使う
  { href: "/admin/spotlights", label: "メンバー紹介", icon: Sparkles },
  // サイネージの「MEMBER INFO / メンバー情報」の欄（2026-09-25 ユーザー指示でデザイン設定から独立）
  { href: "/admin/member-info", label: "メンバー情報", icon: Users, adminOnly: true },
  { href: "/admin/guide", label: "利用ガイド", icon: BookOpen },
];

export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === "administrator");
}

function isCurrent({ href, alsoCurrentFor = [] }: NavItem, path: string): boolean {
  if (href === "/admin") return path === "/admin";
  return [href, ...alsoCurrentFor].some((base) => path === base || path.startsWith(`${base}/`));
}

export function SidebarNav({ role, currentPath }: { role: Role; currentPath?: string }) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  return (
    <nav className={styles.nav} aria-label="メニュー">
      {visibleNavItems(role).map((item) => {
        const { href, label, icon: Icon } = item;
        const current = isCurrent(item, path);
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
