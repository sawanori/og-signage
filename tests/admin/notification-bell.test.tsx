// @vitest-environment jsdom
/**
 * ヘッダーの通知ベル（components/admin/notification-bell.tsx）。
 * メンバー紹介の確認待ち（2026-10-01）は「確認待ち」タブへのリンクにし、端末の知らせは今までどおり文だけを出す。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationBell } from "@/components/admin/notification-bell";

afterEach(cleanup);

describe("NotificationBell", () => {
  it("href のある知らせはリンクにし、押したら一覧を閉じる", () => {
    render(
      <NotificationBell
        alerts={[
          { id: "spotlight-submissions", message: "メンバー紹介の確認待ちが 2 件あります", href: "/admin/spotlights?tab=pending" },
          { id: "dev_1", message: "端末「受付」と通信できていません" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "お知らせ 2 件" }));
    const link = screen.getByRole("link", { name: "メンバー紹介の確認待ちが 2 件あります" });
    expect(link.getAttribute("href")).toBe("/admin/spotlights?tab=pending");
    expect(screen.getByText("端末「受付」と通信できていません").tagName).toBe("P");

    // jsdom は別ページへの移動を実装していないので、移動そのものは止めて閉じることだけを確かめる
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByRole("dialog", { name: "お知らせ" })).toBeNull();
  });
});
