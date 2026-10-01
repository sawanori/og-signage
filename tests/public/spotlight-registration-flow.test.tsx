// @vitest-environment jsdom
/** check_094: 実フォーム・送信クライアント・一時DBの受付サービスをつなぎ、202消失後の二重申請を防ぐ。 */
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpotlightRegistrationForm } from "@/components/members/spotlight-registration-form";
import { media, memberSpotlights, memberSpotlightSubmissions } from "@/db/schema";
import { prepareSpotlightImage } from "@/lib/client/prepare-spotlight-image";
import { submitSpotlightSubmission } from "@/lib/services/spotlight-submissions";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

vi.mock("@/lib/client/prepare-spotlight-image", () => ({ prepareSpotlightImage: vi.fn() }));
vi.mock("@/components/members/spotlight-preview", () => ({ SpotlightPreview: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const NOTIFICATION_FROM = "サイネージ管理 <noreply@non-turn.com>";

const bytesOf = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error);
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.readAsArrayBuffer(blob);
});

it("写真付き受付の202消失と再送429を経ても、元の1件だけを維持して完了する", async () => {
  const { db, close } = await openTempDb();
  const bucket = new SpotlightBucket();
  const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = () => "blob:local-photo"; static revokeObjectURL = vi.fn(); });
  vi.mocked(prepareSpotlightImage).mockResolvedValue({ blob: new Blob([imageBytes], { type: "image/jpeg" }), width: 300, height: 500 });
  let attempt = 0;
  const submitted: string[] = [];
  const fetchStub = vi.fn(async (_url: unknown, options: RequestInit) => {
    attempt += 1;
    const body = options.body as FormData;
    submitted.push(String(body.get("data")));
    if (attempt === 2) return Response.json({ error: { code: "rate_limited", message: "1秒後にもう一度確認してください" } }, { status: 429, headers: { "Retry-After": "1" } });
    const photo = body.get("photo") as Blob;
    const accepted = await submitSpotlightSubmission(db, bucket, JSON.parse(String(body.get("data"))), { photo: { bytes: await bytesOf(photo), mimeType: photo.type } });
    if (attempt === 1) throw new TypeError("202 response lost after persistence");
    return Response.json({ data: accepted }, { status: 202 });
  });
  vi.stubGlobal("fetch", fetchStub);

  try {
    render(<SpotlightRegistrationForm notificationFrom={NOTIFICATION_FROM} />);
    fireEvent.change(screen.getByLabelText("会社名・所属"), { target: { value: "合同会社サンプル" } });
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "山田 太郎" } });
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "member@example.com" } });
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File([imageBytes], "portrait.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "紹介を送信" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "紹介を送信" }));
    await screen.findByRole("button", { name: "送信結果を確認" });
    const [saved] = await db.select().from(memberSpotlightSubmissions);
    expect(saved).toMatchObject({ status: "pending", contactEmail: "member@example.com", payload: { personName: "山田 太郎" } });
    expect(JSON.stringify(saved.payload)).not.toContain("member@example.com");

    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "変更後の名前" } });
    fireEvent.change(screen.getByLabelText("メールアドレス"), { target: { value: "changed@example.com" } });
    fireEvent.change(screen.getByLabelText("写真（任意）"), { target: { files: [new File(["different"], "other.jpg")] } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByLabelText("お名前") as HTMLInputElement).value).toBe("山田 太郎");
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).value).toBe("member@example.com");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "紹介を送信" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "送信結果を確認" }));
    await screen.findByText("1秒後にもう一度確認してください");
    expect((screen.getByLabelText("お名前") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("メールアドレス") as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole("button", { name: "送信結果を確認" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "送信結果を確認" }));
    await screen.findByRole("heading", { name: "送信しました" });

    expect(attempt).toBe(3);
    expect(new Set(submitted).size).toBe(1);
    expect(prepareSpotlightImage).toHaveBeenCalledOnce();
    expect(await db.select().from(memberSpotlightSubmissions)).toHaveLength(1);
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
    expect(await db.select().from(media)).toHaveLength(0);
    expect(bucket.objects.size).toBe(1);
    expect([...bucket.objects.values()][0]).toEqual(imageBytes);
    expect(bucket.putCalls).toHaveLength(1);
  } finally {
    cleanup();
    close();
  }
});
