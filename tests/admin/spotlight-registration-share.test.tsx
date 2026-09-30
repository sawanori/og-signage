// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const qr = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock("qrcode", () => ({ default: qr }));
import { SpotlightRegistrationShare } from "@/components/admin/spotlight-registration-share";

const png = "data:image/png;base64,cXItZml4dHVyZQ==";
const copy = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  qr.toDataURL.mockResolvedValue(png);
  copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("登録用URLとQR", () => {
  it("現在のサイトの登録URLをコピーし、同じURLで生成したQRをPNGで保存できる", async () => {
    render(<SpotlightRegistrationShare />);
    fireEvent.click(screen.getByRole("button", { name: "登録用URL・QR" }));
    const url = `${window.location.origin}/members/register`;
    expect((screen.getByLabelText("登録用URL") as HTMLInputElement).value).toBe(url);
    await waitFor(() => expect(qr.toDataURL).toHaveBeenCalledWith(url, { type: "image/png", width: 640, margin: 4 }));
    const image = await screen.findByRole("img", { name: "メンバー紹介の登録用QRコード" });
    const download = screen.getByRole("link", { name: "QRをPNGで保存" });
    expect(image.getAttribute("src")).toBe(png);
    expect(download.getAttribute("href")).toBe(png);
    expect(download.getAttribute("download")).toBe("member-registration-qr.png");
    fireEvent.click(screen.getByRole("button", { name: "URLをコピー" }));
    await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(url));
    expect(screen.getByRole("status").textContent).toBe("URLをコピーしました。");
  });

  it("コピーが使えないときは手動コピーを案内し、URLを読み取り専用で残す", async () => {
    copy.mockRejectedValue(new Error("denied"));
    render(<SpotlightRegistrationShare />);
    fireEvent.click(screen.getByRole("button", { name: "登録用URL・QR" }));
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "URLをコピー" }));
    expect((await screen.findByRole("alert")).textContent).toContain("下のURLを選択してコピー");
    expect((screen.getByLabelText("登録用URL") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
