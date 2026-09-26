/**
 * メンバー紹介（サイネージの MEMBER SPOTLIGHT。2026-09-26 ユーザー指示）のサービス（lib/services/spotlights.ts）。
 * DB は一時 libSQL ファイル（tests/helpers/temp-db.ts）。AuthUser は直接組み立てる（セッションは介さない）。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/index";
import { media, memberSpotlights } from "../../db/schema";
import type { AuthUser } from "../../lib/auth";
import { ServiceError } from "../../lib/services/notices";
import * as spotlightsService from "../../lib/services/spotlights";
import { openTempDb } from "../helpers/temp-db";

let db: Db;
let close: () => void;

const staff: AuthUser = { id: "u_staff", email: "staff@example.com", name: "Staff", role: "staff" };

type SpotlightFormInput = {
  companyName: string;
  personName: string;
  role: string | null;
  quote: string | null;
  bio: string | null;
  tags: string[];
  photoMediaId: string | null;
  logoMediaId: string | null;
  enabled: boolean;
};

function spotlightInput(overrides: Partial<SpotlightFormInput> = {}): SpotlightFormInput {
  return {
    companyName: "株式会社サンプル",
    personName: "山田 太郎",
    role: null,
    quote: null,
    bio: null,
    tags: [],
    photoMediaId: null,
    logoMediaId: null,
    enabled: true,
    ...overrides,
  };
}

async function insertMedia(id: string, overrides: Partial<{ type: "image" | "video"; state: "active" | "deleting" }> = {}) {
  await db.insert(media).values({
    id,
    name: id,
    type: overrides.type ?? "image",
    r2Key: `keys/${id}`,
    state: overrides.state ?? "active",
  });
}

async function expectServiceError(promise: Promise<unknown>, status: 400 | 404 | 409, code?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).status).toBe(status);
  if (code) expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
});

afterEach(() => close());

describe("member spotlights（Staff 以上）", () => {
  it("作成できる（revision は 0 から。任意の欄の空欄は null、前後の空白は除く）", async () => {
    await insertMedia("img_photo");
    await insertMedia("img_logo");
    const row = await spotlightsService.createSpotlight(
      db,
      staff,
      spotlightInput({
        companyName: " 株式会社サンプル ",
        role: "",
        quote: "毎日が実験です",
        bio: "   ",
        tags: ["映像", " デザイン "],
        photoMediaId: "img_photo",
        logoMediaId: "img_logo",
        enabled: false,
      }),
    );
    expect(row).toMatchObject({
      companyName: "株式会社サンプル",
      personName: "山田 太郎",
      role: null,
      quote: "毎日が実験です",
      bio: null,
      tags: ["映像", "デザイン"],
      photoMediaId: "img_photo",
      logoMediaId: "img_logo",
      enabled: false,
      revision: 0,
    });
    expect(await spotlightsService.getSpotlight(db, row.id)).toEqual(row);
  });

  it("一覧は登録順（作成時刻の古いものから）", async () => {
    const first = await spotlightsService.createSpotlight(db, staff, spotlightInput({ personName: "一番目" }));
    const second = await spotlightsService.createSpotlight(db, staff, spotlightInput({ personName: "二番目" }));
    const third = await spotlightsService.createSpotlight(db, staff, spotlightInput({ personName: "三番目" }));
    // 同じ秒に作ると作成時刻がそろい、並びがランダムな id で決まってしまう。作成時刻で並ぶことを確かめるため、作成順とは違う時刻を入れる
    await db.update(memberSpotlights).set({ createdAt: 1_790_000_300 }).where(eq(memberSpotlights.id, first.id));
    await db.update(memberSpotlights).set({ createdAt: 1_790_000_100 }).where(eq(memberSpotlights.id, second.id));
    await db.update(memberSpotlights).set({ createdAt: 1_790_000_200 }).where(eq(memberSpotlights.id, third.id));

    const rows = await spotlightsService.listSpotlights(db);
    expect(rows.map((r) => r.personName)).toEqual(["二番目", "三番目", "一番目"]);
  });

  it("revision が一致すれば更新でき、revision が 1 増える", async () => {
    const created = await spotlightsService.createSpotlight(db, staff, spotlightInput({ role: "デザイナー", tags: ["映像"] }));
    const updated = await spotlightsService.updateSpotlight(db, staff, created.id, {
      ...spotlightInput({ personName: "山田 花子", role: "", tags: ["写真", "Web"], enabled: false }),
      revision: created.revision,
    });
    expect(updated).toMatchObject({ personName: "山田 花子", role: null, tags: ["写真", "Web"], enabled: false });
    expect(updated.revision).toBe(created.revision + 1);
  });

  it("revision が一致しなければ conflict（409・他の人が先に更新しました）", async () => {
    const created = await spotlightsService.createSpotlight(db, staff, spotlightInput());
    await spotlightsService.updateSpotlight(db, staff, created.id, {
      ...spotlightInput({ personName: "先に保存" }),
      revision: created.revision,
    });

    const error = await expectServiceError(
      spotlightsService.updateSpotlight(db, staff, created.id, {
        ...spotlightInput({ personName: "後から保存" }),
        revision: created.revision,
      }),
      409,
      "conflict",
    );
    expect(error.message).toBe("他の人が先に更新しました");
    expect((await spotlightsService.getSpotlight(db, created.id)).personName).toBe("先に保存");
  });

  it("削除できる。存在しない id の取得・更新・削除は not_found（404）", async () => {
    const created = await spotlightsService.createSpotlight(db, staff, spotlightInput());
    await spotlightsService.deleteSpotlight(db, staff, created.id);
    await expectServiceError(spotlightsService.getSpotlight(db, created.id), 404, "not_found");
    await expectServiceError(spotlightsService.deleteSpotlight(db, staff, created.id), 404, "not_found");
    await expectServiceError(
      spotlightsService.updateSpotlight(db, staff, created.id, { ...spotlightInput(), revision: 0 }),
      404,
      "not_found",
    );
  });

  it("写真・ロゴは active な画像だけ。動画・削除中の画像・無い id は invalid_media", async () => {
    await insertMedia("vid1", { type: "video" });
    await insertMedia("img_deleting", { state: "deleting" });
    for (const bad of ["vid1", "img_deleting", "no-such-media"]) {
      await expectServiceError(
        spotlightsService.createSpotlight(db, staff, spotlightInput({ photoMediaId: bad })),
        400,
        "invalid_media",
      );
      await expectServiceError(
        spotlightsService.createSpotlight(db, staff, spotlightInput({ logoMediaId: bad })),
        400,
        "invalid_media",
      );
    }

    const created = await spotlightsService.createSpotlight(db, staff, spotlightInput());
    await expectServiceError(
      spotlightsService.updateSpotlight(db, staff, created.id, { ...spotlightInput({ photoMediaId: "vid1" }), revision: 0 }),
      400,
      "invalid_media",
    );
    expect(await spotlightsService.listSpotlights(db)).toHaveLength(1);
  });

  it("タグは 3 つまで・各 10 文字まで。超えると入力不正", async () => {
    const tooMany = await expectServiceError(
      spotlightsService.createSpotlight(db, staff, spotlightInput({ tags: ["a", "b", "c", "d"] })),
      400,
      "invalid_input",
    );
    expect(tooMany.message).toBe("タグは3つまでです");
    await expectServiceError(
      spotlightsService.createSpotlight(db, staff, spotlightInput({ tags: ["12345678901"] })),
      400,
      "invalid_input",
    );
    const ok = await spotlightsService.createSpotlight(db, staff, spotlightInput({ tags: ["a", "b", "1234567890"] }));
    expect(ok.tags).toEqual(["a", "b", "1234567890"]);
  });

  it("会社名・お名前は必須。ひとことは 30 文字・紹介文は 60 文字まで", async () => {
    await expectServiceError(spotlightsService.createSpotlight(db, staff, spotlightInput({ companyName: " " })), 400, "invalid_input");
    await expectServiceError(spotlightsService.createSpotlight(db, staff, spotlightInput({ personName: "" })), 400, "invalid_input");
    await expectServiceError(
      spotlightsService.createSpotlight(db, staff, spotlightInput({ quote: "あ".repeat(31) })),
      400,
      "invalid_input",
    );
    await expectServiceError(
      spotlightsService.createSpotlight(db, staff, spotlightInput({ bio: "あ".repeat(61) })),
      400,
      "invalid_input",
    );
    const ok = await spotlightsService.createSpotlight(
      db,
      staff,
      spotlightInput({ quote: "あ".repeat(30), bio: "あ".repeat(60) }),
    );
    expect(ok.revision).toBe(0);
  });
});
