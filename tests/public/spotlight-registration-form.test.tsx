// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightRegistrationForm } from "@/components/members/spotlight-registration-form";
import { submitSpotlight, type SpotlightSubmissionResult } from "@/lib/client/submit-spotlight";
import { prepareSpotlightImage } from "@/lib/client/prepare-spotlight-image";

vi.mock("@/lib/client/submit-spotlight", () => ({ submitSpotlight: vi.fn() }));
vi.mock("@/lib/client/prepare-spotlight-image", () => ({ prepareSpotlightImage: vi.fn() }));
vi.mock("@/components/members/spotlight-preview", () => ({ SpotlightPreview: ({ payload }: { payload: { personName: string } }) => <div data-testid="preview">{payload.personName}</div> }));

const submit = vi.mocked(submitSpotlight);
const prepare = vi.mocked(prepareSpotlightImage);
const rejected = (status: number): SpotlightSubmissionResult => ({ kind: "rejected", status, message: "再度確認してください", retryAfterSeconds: status === 429 ? 1 : 0 });
const input = () => {
  fireEvent.change(screen.getByLabelText("会社名・所属"), { target: { value: " 株式会社サンプル " } });
  fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "山田 太郎" } });
  fireEvent.click(screen.getByRole("checkbox"));
};
const send = () => fireEvent.click(screen.getByRole("button", { name: "紹介を送信" }));

beforeEach(() => {
  submit.mockResolvedValue({ kind: "accepted" });
  prepare.mockResolvedValue({ blob: new Blob(["photo"], { type: "image/webp" }), width: 800, height: 1200 });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => `blob:test-${Math.random()}`); static revokeObjectURL = vi.fn(); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("本人登録フォーム", () => {
  it("必須2項目と同意だけで正規化済み内容を送り、完了後は再登録させない", async () => {
    render(<SpotlightRegistrationForm />);
    expect(screen.getByText(/ログイン不要のWebサイネージ/)).toBeTruthy();
    input(); send();
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    expect(submit.mock.calls[0][0].data).toMatchObject({ companyName: "株式会社サンプル", personName: "山田 太郎", tags: [], consent: true });
    expect(screen.queryByRole("button", { name: "紹介を送信" })).toBeNull();
    expect(screen.getByText(/修正が必要な場合はスタッフへ/)).toBeTruthy();
  });

  it("未同意や不正ふりがなは送らず欄のエラーを表示する", async () => {
    render(<SpotlightRegistrationForm />);
    send();
    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByText("掲載先を確認して同意してください")).toBeTruthy();
    input();
    fireEvent.change(screen.getByLabelText("ふりがな（任意）"), { target: { value: "山田" } });
    send();
    expect(await screen.findByText("ふりがなはひらがなかカタカナで入力してください")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("写真処理中は送信を止め、ローカルプレビューと画像解放を行う", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof prepareSpotlightImage>>) => void;
    prepare.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { unmount } = render(<SpotlightRegistrationForm />);
    input();
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File(["image"], "photo.jpg", { type: "image/jpeg" })] } });
    expect((screen.getByRole("button", { name: "紹介を送信" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ blob: new Blob(["ready"], { type: "image/jpeg" }), width: 500, height: 800 }));
    expect(screen.getByAltText("選択した写真")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "掲載イメージを確認" }));
    expect(screen.getByTestId("preview").textContent).toBe("山田 太郎");
    fireEvent.click(screen.getByRole("button", { name: "写真を取り消す" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each([400, 429])("最初の保存前%sでは入力を修正できる", async (status) => {
    submit.mockResolvedValueOnce(rejected(status));
    render(<SpotlightRegistrationForm />);
    input(); send();
    await screen.findByText(/再度確認してください/);
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "山田 花子" } });
    expect((screen.getByLabelText("お名前") as HTMLInputElement).value).toBe("山田 花子");
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(false);
  });

  it.each([400, 429])("結果不明後の%sでも入力を固定し、同じkey・本文・Blobでのみ確認する", async (status) => {
    submit.mockResolvedValueOnce({ kind: "uncertain", message: "送信できたか確認できません。画面を閉じずに送信結果を確認してください。" }).mockResolvedValueOnce(rejected(status));
    render(<SpotlightRegistrationForm />);
    input();
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File(["image"], "photo.jpg")] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "紹介を送信" }) as HTMLButtonElement).disabled).toBe(false));
    send();
    await screen.findByRole("button", { name: "送信結果を確認" });
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "変更" } });
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File(["other"], "other.jpg")] } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByLabelText("お名前") as HTMLInputElement).value).toBe("山田 太郎");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "送信結果を確認" }));
    await screen.findByText(/再度確認してください/);
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(true);
    expect(submit.mock.calls[1][0]).toBe(submit.mock.calls[0][0]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "紹介を送信" })).toBeNull();
  });

  it("結果不明から202なら完了し、410なら入力を保持して新しいkeyで送り直せる", async () => {
    submit.mockResolvedValueOnce({ kind: "uncertain", message: "結果不明" }).mockResolvedValueOnce({ kind: "expired", message: "期限切れです。もう一度送信してください。" });
    render(<SpotlightRegistrationForm />); input(); send();
    fireEvent.click(await screen.findByRole("button", { name: "送信結果を確認" }));
    await screen.findByText(/期限切れです/);
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(false);
    send();
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    expect(submit.mock.calls[2][0].data.requestKey).not.toBe(submit.mock.calls[0][0].data.requestKey);
    expect(submit.mock.calls[2][0].data.personName).toBe("山田 太郎");
  });
});
