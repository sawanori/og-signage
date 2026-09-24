/**
 * サイドバーの選択中表示。/admin/videos（定期動画の設定）でも「動画・メディア」を選択中にする。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarNav } from "@/components/admin/sidebar-nav";

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

  it("ダッシュボードは /admin のときだけ選択中", () => {
    expect(currentLabels("/admin")).toEqual(["ダッシュボード"]);
    expect(currentLabels("/admin/notices")).toEqual(["お知らせ"]);
  });
});
