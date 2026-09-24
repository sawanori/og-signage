/**
 * サイドバーの選択中表示。/admin/videos（定期動画の設定）でも「動画・メディア」を選択中にする。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarNav, visibleNavItems } from "@/components/admin/sidebar-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));

function currentLabels(path: string): string[] {
  const html = renderToStaticMarkup(<SidebarNav role="administrator" currentPath={path} />);
  return [...html.matchAll(/aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)</g)].map((m) => m[1]);
}

describe("SidebarNav", () => {
  it("/admin/media と /admin/videos の両方で「動画・メディア」だけが選択中になる", () => {
    expect(currentLabels("/admin/media")).toEqual(["動画・メディア"]);
    expect(currentLabels("/admin/videos")).toEqual(["動画・メディア"]);
    expect(currentLabels("/admin/videos/d1")).toEqual(["動画・メディア"]);
  });

  it("メンバー情報は Administrator のメニューにだけあり、その画面で選択中になる", () => {
    expect(visibleNavItems("administrator").map((i) => i.label)).toContain("メンバー情報");
    expect(visibleNavItems("staff").map((i) => i.label)).not.toContain("メンバー情報");
    expect(currentLabels("/admin/member-info")).toEqual(["メンバー情報"]);
  });

  it("ダッシュボードは /admin のときだけ選択中", () => {
    expect(currentLabels("/admin")).toEqual(["ダッシュボード"]);
    expect(currentLabels("/admin/notices")).toEqual(["お知らせ"]);
  });
});
