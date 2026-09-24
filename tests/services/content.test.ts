/**
 * お知らせ・デザイン設定・ハウスルール・カテゴリ・表示スケジュールのサービス（task_009）。
 * DB は一時 libSQL ファイル（tests/helpers/temp-db.ts）。AuthUser は直接組み立てる（セッションは介さない）。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/index";
import { eventCategories, houseSettings, media } from "../../db/schema";
import { AuthzError, type AuthUser } from "../../lib/auth";
import * as houseService from "../../lib/services/house";
import * as noticesService from "../../lib/services/notices";
import { ServiceError } from "../../lib/services/notices";
import * as scheduleService from "../../lib/services/schedule";
import { openTempDb } from "../helpers/temp-db";

let db: Db;
let close: () => void;

const staff: AuthUser = { id: "u_staff", email: "staff@example.com", name: "Staff", role: "staff" };
const admin: AuthUser = { id: "u_admin", email: "admin@example.com", name: "Admin", role: "administrator" };

type NoticeFormInput = {
  title: string;
  body: string | null;
  imageMediaId: string | null;
  enabled: boolean;
  displayMode: "always" | "timeRange";
  displayStartTime: string | null;
  displayEndTime: string | null;
};

function noticeInput(overrides: Partial<NoticeFormInput> = {}): NoticeFormInput {
  return {
    title: "お知らせ",
    body: null,
    imageMediaId: null,
    enabled: true,
    displayMode: "always",
    displayStartTime: null,
    displayEndTime: null,
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

async function expectForbidden(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthzError);
  expect((error as AuthzError).status).toBe(403);
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
});

afterEach(() => close());

describe("notices（Staff 以上）", () => {
  it("作成できる（revision は 0 から始まる）", async () => {
    const row = await noticesService.createNotice(db, staff, noticeInput({ title: "新しいお知らせ", body: "本文です" }));
    expect(row.title).toBe("新しいお知らせ");
    expect(row.revision).toBe(0);
  });

  it("見出しが空なら入力不正", async () => {
    await expectServiceError(noticesService.createNotice(db, staff, noticeInput({ title: "" })), 400, "invalid_input");
  });

  it("表示時間帯モードなのに時刻がなければ入力不正", async () => {
    await expectServiceError(
      noticesService.createNotice(db, staff, noticeInput({ displayMode: "timeRange" })),
      400,
      "invalid_input",
    );
  });

  it("active な image は使えるが、deleting の画像は拒否される", async () => {
    await insertMedia("img_active");
    await insertMedia("img_deleting", { state: "deleting" });

    const ok = await noticesService.createNotice(db, staff, noticeInput({ imageMediaId: "img_active" }));
    expect(ok.imageMediaId).toBe("img_active");

    await expectServiceError(
      noticesService.createNotice(db, staff, noticeInput({ imageMediaId: "img_deleting" })),
      400,
      "invalid_media",
    );
  });

  it("video の media は画像として使えない", async () => {
    await insertMedia("vid1", { type: "video" });
    await expectServiceError(noticesService.createNotice(db, staff, noticeInput({ imageMediaId: "vid1" })), 400, "invalid_media");
  });

  it("revision が一致すれば更新でき、revision が1増える", async () => {
    const created = await noticesService.createNotice(db, staff, noticeInput({ title: "元の見出し" }));
    const updated = await noticesService.updateNotice(db, staff, created.id, {
      ...noticeInput({ title: "更新後の見出し" }),
      revision: created.revision,
    });
    expect(updated.title).toBe("更新後の見出し");
    expect(updated.revision).toBe(created.revision + 1);
  });

  it("revision が一致しなければ conflict（他の人が先に更新しました）", async () => {
    const created = await noticesService.createNotice(db, staff, noticeInput({ title: "元" }));
    await noticesService.updateNotice(db, staff, created.id, { ...noticeInput({ title: "先に保存" }), revision: created.revision });

    const error = await expectServiceError(
      noticesService.updateNotice(db, staff, created.id, { ...noticeInput({ title: "後から保存" }), revision: created.revision }),
      409,
      "conflict",
    );
    expect(error.message).toBe("他の人が先に更新しました");
  });

  it("存在しない id の更新は not_found", async () => {
    await expectServiceError(
      noticesService.updateNotice(db, staff, "no-such-id", { ...noticeInput(), revision: 0 }),
      404,
      "not_found",
    );
  });

  it("削除できる", async () => {
    const created = await noticesService.createNotice(db, staff, noticeInput({ title: "消す" }));
    await noticesService.deleteNotice(db, staff, created.id);
    await expectServiceError(noticesService.getNotice(db, created.id), 404, "not_found");
  });
});

describe("house（デザイン設定・ハウスルール・カテゴリ、Administrator 限定）", () => {
  beforeEach(async () => {
    await db.insert(houseSettings).values({ id: "hs_1", houseName: "テストハウス" });
    await db.insert(eventCategories).values([
      { id: "cat_movie", name: "映画", color: "#111111", position: 0 },
      { id: "cat_social", name: "交流", color: "#222222", position: 1 },
    ]);
  });

  function designInput(overrides: Record<string, unknown> = {}) {
    return {
      houseName: "新しいハウス名",
      headerCopy: null,
      footerCopy: null,
      logoMediaId: null,
      footerImageMediaId: null,
      weatherLocationName: null,
      weatherLatitude: null,
      weatherLongitude: null,
      categories: [{ id: "cat_movie", color: "#abcdef" }],
      revision: 0,
      ...overrides,
    };
  }

  it("Administrator は更新でき、revision が1増え、カテゴリの色が変わる", async () => {
    const updated = await houseService.updateDesignSettings(db, admin, designInput());
    expect(updated.houseName).toBe("新しいハウス名");
    expect(updated.revision).toBe(1);
    expect(updated.footerQrUrl).toBeNull();

    const [cat] = await db.select().from(eventCategories).where(eq(eventCategories.id, "cat_movie"));
    expect(cat.color).toBe("#abcdef");
  });

  it("フッターの QR の URL を保存でき、空欄にすると消える", async () => {
    const saved = await houseService.updateDesignSettings(db, admin, designInput({ footerQrUrl: "https://example.com/rooms" }));
    expect(saved.footerQrUrl).toBe("https://example.com/rooms");
    const cleared = await houseService.updateDesignSettings(db, admin, designInput({ footerQrUrl: "", revision: saved.revision }));
    expect(cleared.footerQrUrl).toBeNull();
  });

  it("Staff は権限違反で拒否される", async () => {
    await expectForbidden(houseService.updateDesignSettings(db, staff, designInput()));
  });

  it("ハウス名が空なら入力不正", async () => {
    await expectServiceError(houseService.updateDesignSettings(db, admin, designInput({ houseName: "" })), 400, "invalid_input");
  });

  it("revision が一致しなければ conflict", async () => {
    await houseService.updateDesignSettings(db, admin, designInput());
    const error = await expectServiceError(houseService.updateDesignSettings(db, admin, designInput()), 409, "conflict");
    expect(error.message).toBe("他の人が先に更新しました");
  });

  it("deleting のロゴ画像は拒否される", async () => {
    await insertMedia("logo_deleting", { state: "deleting" });
    await expectServiceError(
      houseService.updateDesignSettings(db, admin, designInput({ logoMediaId: "logo_deleting" })),
      400,
      "invalid_media",
    );
  });

  it("メンバー情報（旧ハウスルール）は保存のたびに全件を置き換え、最大3件まで。見出しは任意", async () => {
    const rules = await houseService.replaceHouseRules(db, admin, {
      rules: [
        { title: "受付", text: "お困りのことはスタッフまで" },
        { title: "", text: "ゴミ分別" },
      ],
    });
    expect(rules.map((r) => r.position)).toEqual([0, 1]);
    expect(rules.map((r) => r.title)).toEqual(["受付", null]);
    expect(rules.map((r) => r.text)).toEqual(["お困りのことはスタッフまで", "ゴミ分別"]);
    // アイコンは表示に使わないが、古い表示バンドルのために埋めておく
    expect(rules.map((r) => r.icon)).toEqual(["info", "info"]);

    await expectServiceError(
      houseService.replaceHouseRules(db, admin, {
        rules: [
          { icon: "a", text: "1" },
          { icon: "b", text: "2" },
          { icon: "c", text: "3" },
          { icon: "d", text: "4" },
        ],
      }),
      400,
      "invalid_input",
    );
  });

  it("ハウスルールは Staff だと権限違反", async () => {
    await expectForbidden(houseService.replaceHouseRules(db, staff, { rules: [] }));
  });

  it("カテゴリの名前と色を更新できる", async () => {
    const updated = await houseService.updateEventCategories(db, admin, {
      categories: [{ id: "cat_movie", name: "映画会", color: "#333333" }],
    });
    expect(updated.find((c) => c.id === "cat_movie")).toMatchObject({ name: "映画会", color: "#333333" });
  });

  it("存在しないカテゴリ id は入力不正", async () => {
    await expectServiceError(
      houseService.updateEventCategories(db, admin, { categories: [{ id: "no-such-cat", name: "x", color: "#000000" }] }),
      400,
      "invalid_input",
    );
  });

  it("カテゴリ更新は Staff だと権限違反", async () => {
    await expectForbidden(
      houseService.updateEventCategories(db, staff, { categories: [{ id: "cat_movie", name: "x", color: "#000000" }] }),
    );
  });
});

describe("schedule（表示スケジュール、Administrator 限定）", () => {
  it("曜日ごとに1枠を保存でき、日またぎ（start > end）を許す", async () => {
    const rows = await scheduleService.replaceDisplaySchedule(db, admin, {
      entries: [
        { weekday: 1, startTime: "08:00", endTime: "22:00", enabled: true },
        { weekday: 2, startTime: "22:00", endTime: "06:00", enabled: true },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.weekday === 2)).toMatchObject({ startTime: "22:00", endTime: "06:00" });
  });

  it("start と end が同じ時刻は拒否される", async () => {
    await expectServiceError(
      scheduleService.replaceDisplaySchedule(db, admin, {
        entries: [{ weekday: 0, startTime: "09:00", endTime: "09:00", enabled: true }],
      }),
      400,
      "invalid_input",
    );
  });

  it("同じ曜日が重複していれば拒否される", async () => {
    await expectServiceError(
      scheduleService.replaceDisplaySchedule(db, admin, {
        entries: [
          { weekday: 3, startTime: "08:00", endTime: "20:00", enabled: true },
          { weekday: 3, startTime: "09:00", endTime: "21:00", enabled: true },
        ],
      }),
      400,
      "invalid_input",
    );
  });

  it("Staff は権限違反で拒否される", async () => {
    await expectForbidden(scheduleService.replaceDisplaySchedule(db, staff, { entries: [] }));
  });

  it("含まれない曜日は保存のたびに消え、終日表示（行なし）に戻る", async () => {
    await scheduleService.replaceDisplaySchedule(db, admin, {
      entries: [{ weekday: 1, startTime: "08:00", endTime: "22:00", enabled: true }],
    });
    const rows = await scheduleService.replaceDisplaySchedule(db, admin, {
      entries: [{ weekday: 2, startTime: "08:00", endTime: "22:00", enabled: true }],
    });
    expect(rows.map((r) => r.weekday)).toEqual([2]);
  });
});
