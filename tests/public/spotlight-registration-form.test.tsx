// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightRegistrationForm } from "@/components/members/spotlight-registration-form";
import { submitSpotlight, type SpotlightSubmissionResult } from "@/lib/client/submit-spotlight";
import { prepareSpotlightImage } from "@/lib/client/prepare-spotlight-image";
import { scanBusinessCard, type BusinessCardScan } from "@/lib/client/scan-business-card";

vi.mock("@/lib/client/submit-spotlight", () => ({ submitSpotlight: vi.fn() }));
vi.mock("@/lib/client/prepare-spotlight-image", () => ({ prepareSpotlightImage: vi.fn() }));
vi.mock("@/lib/client/scan-business-card", () => ({ scanBusinessCard: vi.fn() }));
const preview = vi.hoisted(() => vi.fn());
vi.mock("@/components/members/spotlight-preview", () => ({ SpotlightPreview: ({ payload }: { payload: { personName: string } }) => {
  preview(payload);
  return <div data-testid="preview">{payload.personName}</div>;
} }));

const submit = vi.mocked(submitSpotlight);
const NOTIFICATION_FROM = "サイネージ管理 <noreply@non-turn.com>";
const WEBSITE_LABEL = "ホームページのURL 1（任意）";
const WEBSITE_2_LABEL = "ホームページのURL 2（任意）";
const prepare = vi.mocked(prepareSpotlightImage);
const scan = vi.mocked(scanBusinessCard);
const cardFile = () => new File(["card"], "card.jpg", { type: "image/jpeg" });
const scanned: BusinessCardScan = { kind: "ok", card: { companyName: "株式会社名刺", personName: "名刺 太郎", personNameKana: null, role: "ディレクター", email: "card@example.com", websiteUrl: "https://card.example/" } };
const rejected = (status: number): SpotlightSubmissionResult => ({ kind: "rejected", status, message: "再度確認してください", retryAfterSeconds: status === 429 ? 1 : 0 });
const input = () => {
  fireEvent.change(screen.getByLabelText("会社名・所属"), { target: { value: " 株式会社サンプル " } });
  fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "山田 太郎" } });
  fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: " member@example.com " } });
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
  it("任意のホームページURLを2件送り、http/https 以外は送らずに知らせる。会社のロゴの欄は無い", async () => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    expect(screen.queryByLabelText("会社のロゴ（任意）")).toBeNull();
    const website = screen.getByLabelText(WEBSITE_LABEL) as HTMLInputElement;
    expect(website.type).toBe("url");
    expect(screen.getByText("サイネージのメンバー紹介に、QRコードで表示します。https:// から入力してください。")).toBeTruthy();
    input();
    fireEvent.change(website, { target: { value: "example.com" } });
    send();
    expect(await screen.findByText("URL は http:// か https:// で始まるものを入力してください")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(website, { target: { value: " https://example.com/ " } });
    fireEvent.change(screen.getByLabelText(WEBSITE_2_LABEL), { target: { value: " https://example.com/profile " } });
    send();
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    expect(submit.mock.calls[0][0].data).toMatchObject({ websiteUrl: "https://example.com/", websiteUrl2: "https://example.com/profile" });
  });

  it.each([
    { second: " https://example.com/profile ", expected: "https://example.com/profile" },
    { second: " ", expected: null },
  ])("URL 1が空でもURL 2を任意で送信できる（$expected）", async ({ second, expected }) => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    input();
    fireEvent.change(screen.getByLabelText(WEBSITE_LABEL), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText(WEBSITE_2_LABEL), { target: { value: second } });
    send();
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    expect(submit.mock.calls[0][0].data).toMatchObject({ websiteUrl: null, websiteUrl2: expected });
  });

  it("URL 2が不正ならその入力欄へエラーを表示し、送信しない", () => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    input();
    const second = screen.getByLabelText(WEBSITE_2_LABEL) as HTMLInputElement;
    expect(second.type).toBe("url");
    fireEvent.change(second, { target: { value: "javascript:alert(1)" } });
    send();
    expect(submit).not.toHaveBeenCalled();
    expect(second.getAttribute("aria-invalid")).toBe("true");
    expect(second.getAttribute("aria-describedby")).toBe("websiteUrl2-error");
    expect(screen.getByText("URL は http:// か https:// で始まるものを入力してください").id).toBe("websiteUrl2-error");
  });

  it("必須3項目と同意だけで正規化済み内容を送り、完了後は結果メールを案内する", async () => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    expect(screen.getByText(/ログイン不要のWebサイネージ/)).toBeTruthy();
    input(); send();
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    expect(submit.mock.calls[0][0].data).toMatchObject({ companyName: "株式会社サンプル", personName: "山田 太郎", email: "member@example.com", tags: [], websiteUrl: null, websiteUrl2: null, consent: true });
    expect(screen.queryByRole("button", { name: "紹介を送信" })).toBeNull();
    expect(screen.getByText(/修正が必要な場合はスタッフへ/)).toBeTruthy();
    expect(screen.getByText("<noreply@non-turn.com>")).toBeTruthy();
    expect(screen.getByText(/お知らせは「サイネージ管理/)).toBeTruthy();
    expect(screen.getByText(/見当たらないときは、迷惑メールフォルダーもご確認ください/)).toBeTruthy();
    expect(screen.getByText("掲載の可否は、ご入力のメールアドレスへお知らせします。")).toBeTruthy();
  });

  it("名前の次に必須のメール欄と用途を表示し、文字数を出さず、未入力と不正形式を送らない", () => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    const email = screen.getByLabelText("メールアドレス") as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.autocomplete).toBe("email");
    expect(email.required).toBe(true);
    expect(screen.getByLabelText("お名前").parentElement?.nextElementSibling?.contains(email)).toBe(true);
    expect(email.getAttribute("aria-describedby")).toBe("email-hint");
    expect(email.parentElement?.textContent).not.toContain("文字");
    expect(screen.getByText("掲載の可否をお知らせします。サイネージには表示しません。")).toBeTruthy();
    expect(screen.getByRole("checkbox").parentElement?.textContent).toContain("メールアドレスは掲載結果のお知らせに使い、掲載中は管理のために保管します。サイネージには表示しません。");
    input();
    fireEvent.change(email, { target: { value: "" } });
    send();
    expect(screen.getByText("メールアドレスを入力してください")).toBeTruthy();
    fireEvent.change(email, { target: { value: "invalid" } });
    send();
    expect(screen.getByText("メールアドレスの形式が正しくありません")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([null, "https://example.com/"])("掲載イメージにはURL 1だけを渡し、URL 2やメールを含めない（URL 1: %s）", (first) => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    input();
    if (first) fireEvent.change(screen.getByLabelText(WEBSITE_LABEL), { target: { value: first } });
    fireEvent.change(screen.getByLabelText(WEBSITE_2_LABEL), { target: { value: "https://example.com/profile" } });
    fireEvent.click(screen.getByRole("button", { name: "掲載イメージを確認" }));
    expect(preview).toHaveBeenCalled();
    expect(preview.mock.calls.at(-1)?.[0]).not.toHaveProperty("email");
    expect(preview.mock.calls.at(-1)?.[0]).not.toHaveProperty("websiteUrl2");
    expect(preview.mock.calls.at(-1)?.[0].websiteUrl).toBe(first);
    expect(JSON.stringify(preview.mock.calls.at(-1)?.[0])).not.toContain("member@example.com");
  });

  it("未同意や不正ふりがなは送らず欄のエラーを表示する", async () => {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
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
    const { unmount } = render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
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

  it("名刺から空いている欄だけを埋め、入力済みの欄は変えず、URLを入れたら詳しい情報を開く", async () => {
    scan.mockResolvedValueOnce(scanned);
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "手入力 花子" } });
    fireEvent.change(screen.getByLabelText("画像を選ぶ"), { target: { files: [cardFile()] } });
    expect(await screen.findByText("名刺から「会社名・所属」「肩書き」「メールアドレス」「ホームページのURL 1」を入力しました。内容が正しいか確認してください。")).toBeTruthy();
    expect((screen.getByLabelText("会社名・所属") as HTMLInputElement).value).toBe("株式会社名刺");
    expect((screen.getByLabelText("お名前") as HTMLInputElement).value).toBe("手入力 花子");
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).value).toBe("card@example.com");
    expect((screen.getByLabelText("ふりがな（任意）") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(WEBSITE_LABEL) as HTMLInputElement).value).toBe("https://card.example/");
    expect((screen.getByText("詳しい情報を追加する（任意）").closest("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("「カメラで撮影」はスマホの背面カメラを直接開き、撮った写真も同じように読み取る。「画像を選ぶ」はカメラを強制しない", async () => {
    scan.mockResolvedValueOnce(scanned);
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    const camera = screen.getByLabelText("カメラで撮影") as HTMLInputElement;
    expect(camera.type).toBe("file");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(screen.getByLabelText("画像を選ぶ").hasAttribute("capture")).toBe(false);
    expect(screen.getByRole("group", { name: "名刺から入力（任意）" })).toBeTruthy();
    expect(screen.queryByText(/Gemini/)).toBeNull();
    fireEvent.change(camera, { target: { files: [cardFile()] } });
    expect(await screen.findByText(/名刺から「会社名・所属」/)).toBeTruthy();
    expect(scan).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("会社名・所属") as HTMLInputElement).value).toBe("株式会社名刺");
  });

  it("名刺の読み取り中は送信を止め、読み取れなかったときは理由を出して入力を変えない", async () => {
    let resolve!: (value: BusinessCardScan) => void;
    scan.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    input();
    fireEvent.change(screen.getByLabelText("画像を選ぶ"), { target: { files: [cardFile()] } });
    expect(await screen.findByText("名刺を読み取っています…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "紹介を送信" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("button", { name: "紹介を送信" }).closest("form")!);
    expect(submit).not.toHaveBeenCalled();
    await act(async () => resolve({ kind: "error", message: "名刺を読み取れませんでした。" }));
    expect(screen.getByRole("alert").textContent).toBe("名刺を読み取れませんでした。");
    expect((screen.getByLabelText("会社名・所属") as HTMLInputElement).value).toBe(" 株式会社サンプル ");
    expect((screen.getByRole("button", { name: "紹介を送信" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([400, 429])("最初の保存前%sでは入力を修正できる", async (status) => {
    submit.mockResolvedValueOnce(rejected(status));
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    input(); send();
    await screen.findByText(/再度確認してください/);
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "山田 花子" } });
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "changed@example.com" } });
    expect((screen.getByLabelText("お名前") as HTMLInputElement).value).toBe("山田 花子");
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).value).toBe("changed@example.com");
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).disabled).toBe(false);
  });

  it.each([400, 429])("結果不明後の%sでも入力を固定し、同じkey・本文・Blobでのみ確認する", async (status) => {
    submit.mockResolvedValueOnce({ kind: "uncertain", message: "送信できたか確認できません。画面を閉じずに送信結果を確認してください。" }).mockResolvedValueOnce(rejected(status));
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    input();
    fireEvent.change(screen.getByLabelText(WEBSITE_2_LABEL), { target: { value: "https://example.com/profile" } });
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File(["image"], "photo.jpg")] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "紹介を送信" }) as HTMLButtonElement).disabled).toBe(false));
    send();
    await screen.findByRole("button", { name: "送信結果を確認" });
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "変更" } });
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "changed@example.com" } });
    fireEvent.change(screen.getByLabelText(WEBSITE_2_LABEL), { target: { value: "https://example.com/changed" } });
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File(["other"], "other.jpg")] } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByLabelText("お名前") as HTMLInputElement).value).toBe("山田 太郎");
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).value).toBe("member@example.com");
    expect((screen.getByLabelText(WEBSITE_2_LABEL) as HTMLInputElement).value).toBe("https://example.com/profile");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "送信結果を確認" }));
    await screen.findByText(/再度確認してください/);
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(WEBSITE_2_LABEL) as HTMLInputElement).disabled).toBe(true);
    expect(submit.mock.calls[1][0]).toBe(submit.mock.calls[0][0]);
    expect(submit.mock.calls[1][0].data.email).toBe("member@example.com");
    expect(submit.mock.calls[1][0].data.websiteUrl2).toBe("https://example.com/profile");
    expect(prepare).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "紹介を送信" })).toBeNull();
  });

  it("結果不明から202なら完了し、410なら入力を保持して新しいkeyで送り直せる", async () => {
    submit.mockResolvedValueOnce({ kind: "uncertain", message: "結果不明" }).mockResolvedValueOnce({ kind: "expired", message: "期限切れです。もう一度送信してください。" });
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />); input(); send();
    fireEvent.click(await screen.findByRole("button", { name: "送信結果を確認" }));
    await screen.findByText(/期限切れです/);
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(false);
    send();
    expect(await screen.findByRole("heading", { name: "送信しました" })).toBeTruthy();
    expect(submit.mock.calls[2][0].data.requestKey).not.toBe(submit.mock.calls[0][0].data.requestKey);
    expect(submit.mock.calls[2][0].data.personName).toBe("山田 太郎");
  });
});
