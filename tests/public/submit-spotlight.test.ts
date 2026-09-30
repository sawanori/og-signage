import { afterEach, describe, expect, it, vi } from "vitest";
import { submitSpotlight, type SpotlightSubmissionSnapshot } from "@/lib/client/submit-spotlight";

const snapshot: SpotlightSubmissionSnapshot = {
  data: { requestKey: "9b1dc7e1-5bdf-4cf0-91a9-f995b712a2be", companyName: "会社", personName: "名前", personNameKana: null, role: null, quote: null, bio: null, tags: [], consent: true },
  photo: new Blob(["same bytes"], { type: "image/jpeg" }), logo: null,
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("本人登録の送信結果", () => {
  it("202の受付確認と同じ本文・画像の再送", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ data: { accepted: true } }, { status: 202 }));
    vi.stubGlobal("fetch", send);
    expect(await submitSpotlight(snapshot)).toEqual({ kind: "accepted" });
    send.mockResolvedValueOnce(Response.json({ data: { accepted: true } }, { status: 202 }));
    await submitSpotlight(snapshot);
    for (const call of send.mock.calls) {
      expect(call[0]).toBe("/api/spotlight-submissions");
      const body = call[1].body as FormData;
      expect(JSON.parse(String(body.get("data")))).toEqual(snapshot.data);
      expect(await (body.get("photo") as Blob).text()).toBe("same bytes");
      expect(body.has("logo")).toBe(false);
    }
  });

  it.each([400, 403, 413, 415, 429])("保存前の%sを区別して返す", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "rejected", message: "受け付けできません" } }, { status, headers: { "Retry-After": "60" } })));
    expect(await submitSpotlight(snapshot)).toMatchObject({ kind: "rejected", status, message: "受け付けできません" });
  });

  it("410だけは期限切れと確定できる", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "expired", message: "期限切れです" } }, { status: 410 })));
    expect(await submitSpotlight(snapshot)).toMatchObject({ kind: "expired" });
  });

  it.each([503, 409, 200, 202])("%sだけで受付成功を推測しない", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ unexpected: true }, { status })));
    expect(await submitSpotlight(snapshot)).toMatchObject({ kind: "uncertain" });
  });

  it("通信切断は結果不明として返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    expect(await submitSpotlight(snapshot)).toMatchObject({ kind: "uncertain" });
  });
});
