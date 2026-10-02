/**
 * 企業データの入口（2026-10-02 ユーザー指示「左カラムの企業データという入口も見せてはダメ」）。
 * 見られないアカウントの管理画面には、メニューの項目も行き先も出さない。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminShell } from "@/components/admin/admin-shell";
import type { ShellData } from "@/components/admin/dashboard-types";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const shell = (canViewCompanyResearch: boolean): ShellData => ({
  user: { name: "管理者", role: "administrator", avatarUrl: null, canViewCompanyResearch },
  alerts: [],
});

describe("管理画面の枠の企業データの入口", () => {
  it("見られないアカウントには、メニューの名前も行き先も出さない", () => {
    const html = renderToStaticMarkup(<AdminShell shell={shell(false)} currentPath="/admin">本文</AdminShell>);
    expect(html).not.toContain("企業データ");
    expect(html).not.toContain("company-research");
    expect(html).toContain("メンバー紹介");
  });
  it("見られるアカウントにだけ出す", () => {
    const html = renderToStaticMarkup(<AdminShell shell={shell(true)} currentPath="/admin">本文</AdminShell>);
    expect(html).toContain("企業データ");
    expect(html).toContain('href="/admin/company-research"');
  });
});
