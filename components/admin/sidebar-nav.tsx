"use client";

/**
 * サイドバーの項目。Administrator 専用の画面（計画 6 節の権限表）は Staff には出さない。
 */
import { BookOpen, Bell, Building2, CalendarDays, House, Palette, Sparkles, SquarePlay, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/auth";
import styles from "./admin.module.css";
import { HomeFillIcon } from "./icons";

/** alsoCurrentFor: href 以外で選択中にするパス（その下の階層も含む） */
/** companyResearchOnly: 「企業データ」を見られるアカウント（COMPANY_RESEARCH_VIEWER_EMAILS）にだけ出す */
type NavItem = { href: string; label: string; icon: LucideIcon; adminOnly?: boolean; companyResearchOnly?: boolean; alsoCurrentFor?: readonly string[] };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/admin", label: "ダッシュボード", icon: House },
  { href: "/admin/events", label: "イベント管理", icon: CalendarDays },
  { href: "/admin/media", label: "動画・メディア", icon: SquarePlay, alsoCurrentFor: ["/admin/videos"] },
  // サイネージ端末（/admin/devices）は一旦メニューから外す（2026-09-27 ユーザー指示「一旦不要なので非表示に」）。画面は残してある
  { href: "/admin/design", label: "デザイン設定", icon: Palette, adminOnly: true },
  { href: "/admin/notices", label: "お知らせ", icon: Bell },
  // サイネージの「MEMBER SPOTLIGHT」の欄（2026-09-26 ユーザー指示）。Staff も使う
  { href: "/admin/spotlights", label: "メンバー紹介", icon: Sparkles },
  // メンバーのホームページから集めた企業データ（非公開。2026-10-02 ユーザー指示で snp.inc.info のアカウントだけ）
  { href: "/admin/company-research", label: "企業データ", icon: Building2, companyResearchOnly: true },
  { href: "/admin/guide", label: "利用ガイド", icon: BookOpen },
];

export function visibleNavItems(role: Role, canViewCompanyResearch = false): NavItem[] {
  return NAV_ITEMS.filter((item) => (!item.adminOnly || role === "administrator") && (!item.companyResearchOnly || canViewCompanyResearch));
}

function isCurrent({ href, alsoCurrentFor = [] }: NavItem, path: string): boolean {
  if (href === "/admin") return path === "/admin";
  return [href, ...alsoCurrentFor].some((base) => path === base || path.startsWith(`${base}/`));
}

export function SidebarNav({ role, canViewCompanyResearch = false, currentPath }: { role: Role; canViewCompanyResearch?: boolean; currentPath?: string }) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  return (
    <nav className={styles.nav} aria-label="メニュー">
      {visibleNavItems(role, canViewCompanyResearch).map((item) => {
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
