/**
 * イベントのサービス・Route Handler・Server Actions。DB は一時 libSQL ファイル。
 * Route Handler と Server Actions は lib/runtime の getDb と、権限確認のセッション取得だけを差し替える
 * （DB の is_active・role・session_version との照合は本物の lib/auth を通す）。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { events, media, users } from "../../db/schema";
import { seed } from "../../db/seed";
import { tokyoDateTime } from "../../lib/dates";
import {
  countActiveEvents,
  createEvent,
  deleteEvent,
  EventServiceError,
  getEvent,
  listEvents,
  MAX_ACTIVE_EVENTS,
  updateEvent,
} from "../../lib/services/events";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));

vi.mock("../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth")>();
  const deps = () => ({ db: state.db as Db, getSession: async () => state.session });
  return {
    ...actual,
    withRole: ((role, handler) => actual.withRole(role, handler, deps)) as typeof actual.withRole,
    requireRole: ((role) => actual.requireRole(role, deps())) as typeof actual.requireRole,
  };
});

const collection = await import("../../app/api/events/route");
const item = await import("../../app/api/events/[id]/route");
const actions = await import("../../app/admin/_actions/events");

const ORIGIN = "https://signage.example";

let db: Db;
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await seed(db);
  state.db = db;
  state.session = null;
});

afterEach(() => close());

async function login(role: "staff" | "administrator" = "staff") {
  const [user] = await db
    .insert(users)
    .values({ email: `${role}@example.com`, role })
    .returning({ id: users.id, sessionVersion: users.sessionVersion });
  state.session = { userId: user.id, sessionVersion: user.sessionVersion };
  return user.id;
}

async function addMedia(values: Partial<typeof media.$inferInsert> = {}) {
  const [row] = await db
    .insert(media)
    .values({ name: "photo.jpg", type: "image", r2Key: `media/${crypto.randomUUID()}`, ...values })
    .returning({ id: media.id });
  return row.id;
}

const BASE = tokyoDateTime(2025, 9, 24, 19, 0);

function input(overrides: Record<string, unknown> = {}) {
  return { title: "ピザナイト", startAt: BASE, participation: "free", status: "published", ...overrides };
}

async function expectServiceError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EventServiceError);
  expect((error as EventServiceError).code).toBe(code);
  expect((error as EventServiceError).status).toBe(status);
  return error as EventServiceError;
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("サービス: 作成・取得・削除", () => {
  it("イベント名と開始日時だけで作成でき、既定値が入る", async () => {
    const created = await createEvent(db, input());
    expect(created).toMatchObject({
      title: "ピザナイト",
      startAt: BASE,
      endAt: null,
      description: null,
      categoryId: null,
      imageMediaId: null,
      participation: "free",
      status: "published",
      revision: 0,
    });
    expect(await getEvent(db, created.id)).toEqual(created);
  });

  it("定員なし（free）のときは定員を保存しない", async () => {
    const created = await createEvent(db, input({ participation: "free", capacity: 10 }));
    expect(created.capacity).toBeNull();
    const limited = await createEvent(db, input({ participation: "limited", capacity: 10 }));
    expect(limited.capacity).toBe(10);
  });

  it("入力の誤りは 400（利用者向けの日本語）", async () => {
    const error = await expectServiceError(createEvent(db, input({ title: "  " })), "invalid_input", 400);
    expect(error.message).toBe("イベント名を入力してください");
    await expectServiceError(createEvent(db, input({ endAt: BASE - 60 })), "invalid_input", 400);
  });

  it("存在しないカテゴリは 400、既存のカテゴリは使える", async () => {
    await expectServiceError(createEvent(db, input({ categoryId: "cat_none" })), "invalid_category", 400);
    expect((await createEvent(db, input({ categoryId: "cat_social" }))).categoryId).toBe("cat_social");
  });

  it("画像は active な image だけ。deleting・動画・存在しないものは 400", async () => {
    const active = await addMedia();
    const deleting = await addMedia({ state: "deleting", deleteAfter: BASE });
    const video = await addMedia({ type: "video", name: "clip.mp4" });

    expect((await createEvent(db, input({ imageMediaId: active }))).imageMediaId).toBe(active);
    for (const id of [deleting, video, "media_none"]) {
      const error = await expectServiceError(createEvent(db, input({ imageMediaId: id })), "invalid_image", 400);
      expect(error.message).toBe("選んだ画像は使えません。別の画像を選んでください");
    }
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it("取得・削除で無ければ 404", async () => {
    await expectServiceError(getEvent(db, "none"), "not_found", 404);
    await expectServiceError(deleteEvent(db, "none"), "not_found", 404);
    const created = await createEvent(db, input());
    await deleteEvent(db, created.id);
    await expectServiceError(getEvent(db, created.id), "not_found", 404);
  });
});

describe("サービス: 更新（revision）", () => {
  it("revision が一致すれば更新して 1 増やす。古い revision は 409", async () => {
    const created = await createEvent(db, input());
    const first = await updateEvent(db, created.id, input({ title: "映画ナイト", revision: 0 }));
    expect(first).toMatchObject({ title: "映画ナイト", revision: 1 });

    // 同じ版を開いていた別の人の保存
    const error = await expectServiceError(
      updateEvent(db, created.id, input({ title: "BBQ", revision: 0 })),
      "conflict",
      409,
    );
    expect(error.message).toBe("他の人が先に更新しました");
    expect((await getEvent(db, created.id)).title).toBe("映画ナイト");
  });

  it("revision なしは 400、存在しないイベントは 404", async () => {
    const created = await createEvent(db, input());
    await expectServiceError(updateEvent(db, created.id, input()), "invalid_input", 400);
    await expectServiceError(updateEvent(db, "none", input({ revision: 0 })), "not_found", 404);
  });

  it("更新で deleting の画像に差し替えると 400 で、元のまま", async () => {
    const active = await addMedia();
    const created = await createEvent(db, input({ imageMediaId: active }));
    await db.update(media).set({ state: "deleting", deleteAfter: BASE }).where(eq(media.id, active));

    await expectServiceError(
      updateEvent(db, created.id, input({ imageMediaId: active, revision: 0 })),
      "invalid_image",
      400,
    );
    expect((await getEvent(db, created.id)).revision).toBe(0);
    // 画像を外す更新はできる
    expect((await updateEvent(db, created.id, input({ imageMediaId: null, revision: 0 }))).imageMediaId).toBeNull();
  });
});

describe("サービス: 一覧", () => {
  // 2025-09-24(水) 19:00 を「今」とする
  const now = BASE;

  async function fixture() {
    const ended = await createEvent(db, input({ title: "朝ヨガ", startAt: BASE - 12 * 3600, endAt: BASE - 11 * 3600 }));
    const ongoing = await createEvent(db, input({ title: "ピザナイト", startAt: BASE - 600, location: "ラウンジ" }));
    const soon = await createEvent(db, input({ title: "映画鑑賞会", startAt: BASE + 900, status: "draft" }));
    const tomorrow = await createEvent(
      db,
      input({ title: "BBQ 100%", startAt: BASE + 86400, description: "屋上で", hostName: "たなか" }),
    );
    return { ended, ongoing, soon, tomorrow };
  }

  it("開始順に全件。状態（開催前・開催中・終了）は display-rules で判定する", async () => {
    const { ended, ongoing, soon, tomorrow } = await fixture();
    const list = await listEvents(db, {}, now);
    expect(list.map((e) => [e.id, e.phase])).toEqual([
      [ended.id, "ended"],
      [ongoing.id, "ongoing"],
      [soon.id, "before"],
      [tomorrow.id, "before"],
    ]);
  });

  it("状態・公開状態で絞り込む", async () => {
    const { ended, ongoing, soon, tomorrow } = await fixture();
    expect((await listEvents(db, { phase: "before" }, now)).map((e) => e.id)).toEqual([soon.id, tomorrow.id]);
    expect((await listEvents(db, { phase: "ongoing" }, now)).map((e) => e.id)).toEqual([ongoing.id]);
    expect((await listEvents(db, { phase: "ended" }, now)).map((e) => e.id)).toEqual([ended.id]);
    expect((await listEvents(db, { status: "draft" }, now)).map((e) => e.id)).toEqual([soon.id]);
    expect((await listEvents(db, { status: "published" }, now)).map((e) => e.id)).not.toContain(soon.id);
  });

  it("期間は重なるものを返す（終了なしはその日の終わりまで）", async () => {
    const { ongoing, soon, tomorrow } = await fixture();
    // 今日 22:00〜23:00 には、終了なしの今日のイベントが重なる
    const list = await listEvents(db, { from: String(BASE + 3 * 3600), to: String(BASE + 4 * 3600) }, now);
    expect(list.map((e) => e.id)).toEqual([ongoing.id, soon.id]);
    expect((await listEvents(db, { from: BASE + 86400 }, now)).map((e) => e.id)).toEqual([tomorrow.id]);
  });

  it("検索はイベント名・説明・場所・主催者名。% や _ は文字として扱う", async () => {
    const { ongoing, tomorrow } = await fixture();
    expect((await listEvents(db, { q: "ラウンジ" }, now)).map((e) => e.id)).toEqual([ongoing.id]);
    expect((await listEvents(db, { q: "屋上" }, now)).map((e) => e.id)).toEqual([tomorrow.id]);
    expect((await listEvents(db, { q: "たなか" }, now)).map((e) => e.id)).toEqual([tomorrow.id]);
    expect((await listEvents(db, { q: "100%" }, now)).map((e) => e.id)).toEqual([tomorrow.id]);
    expect(await listEvents(db, { q: "%" }, now)).toHaveLength(1);
    expect(await listEvents(db, { q: "_" }, now)).toHaveLength(0);
  });

  it("絞り込みの指定の誤りは 400", async () => {
    await expectServiceError(listEvents(db, { phase: "soon" }), "invalid_input", 400);
    await expectServiceError(listEvents(db, { from: "abc" }), "invalid_input", 400);
    await expectServiceError(listEvents(db, { from: "200", to: "100" }), "invalid_input", 400);
  });
});

describe("API: /api/events", () => {
  it("未ログインは 401（一覧・作成・取得・更新・削除）", async () => {
    const created = await createEvent(db, input());
    const responses = [
      await collection.GET(request("GET", "/api/events"), {}),
      await collection.POST(request("POST", "/api/events", input()), {}),
      await item.GET(request("GET", `/api/events/${created.id}`), ctx(created.id)),
      await item.PUT(request("PUT", `/api/events/${created.id}`, input({ revision: 0 })), ctx(created.id)),
      await item.DELETE(request("DELETE", `/api/events/${created.id}`), ctx(created.id)),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "ログインしてください" } });
    }
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it("無効化したユーザーのセッションは 401", async () => {
    const id = await login("staff");
    await db.update(users).set({ isActive: false }).where(eq(users.id, id));
    expect((await collection.GET(request("GET", "/api/events"), {})).status).toBe(401);
  });

  it("Staff は作成・一覧・取得・更新・削除ができる", async () => {
    await login("staff");
    const post = await collection.POST(request("POST", "/api/events", input({ categoryId: "cat_movie" })), {});
    expect(post.status).toBe(201);
    const { event } = (await post.json()) as { event: { id: string; revision: number } };

    const list = await collection.GET(request("GET", "/api/events?status=published&q=%E3%83%94%E3%82%B6"), {});
    expect(list.status).toBe(200);
    expect(((await list.json()) as { events: { id: string }[] }).events.map((e) => e.id)).toEqual([event.id]);

    const got = await item.GET(request("GET", `/api/events/${event.id}`), ctx(event.id));
    expect(((await got.json()) as { event: { title: string } }).event.title).toBe("ピザナイト");

    const put = await item.PUT(
      request("PUT", `/api/events/${event.id}`, input({ title: "映画ナイト", revision: 0 })),
      ctx(event.id),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { event: { revision: number } }).event.revision).toBe(1);

    const del = await item.DELETE(request("DELETE", `/api/events/${event.id}`), ctx(event.id));
    expect(del.status).toBe(204);
  });

  it("Administrator も使える", async () => {
    await login("administrator");
    expect((await collection.POST(request("POST", "/api/events", input()), {})).status).toBe(201);
  });

  it("入力の誤り・壊れた JSON・絞り込みの誤り・deleting の画像は 400", async () => {
    await login();
    const deleting = await addMedia({ state: "deleting", deleteAfter: BASE });

    const bad = await collection.POST(request("POST", "/api/events", input({ title: "" })), {});
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "invalid_input", message: "イベント名を入力してください" } });

    const broken = await collection.POST(request("POST", "/api/events", "{"), {});
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: { code: "invalid_input", message: "入力内容を確認してください" } });

    expect((await collection.GET(request("GET", "/api/events?phase=x"), {})).status).toBe(400);

    const image = await collection.POST(request("POST", "/api/events", input({ imageMediaId: deleting })), {});
    expect(image.status).toBe(400);
    expect(await image.json()).toEqual({
      error: { code: "invalid_image", message: "選んだ画像は使えません。別の画像を選んでください" },
    });
  });

  it("存在しないイベントは 404", async () => {
    await login();
    for (const res of [
      await item.GET(request("GET", "/api/events/none"), ctx("none")),
      await item.PUT(request("PUT", "/api/events/none", input({ revision: 0 })), ctx("none")),
      await item.DELETE(request("DELETE", "/api/events/none"), ctx("none")),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "not_found", message: "イベントが見つかりません。削除された可能性があります" },
      });
    }
  });

  it("revision 不一致は 409", async () => {
    await login();
    const created = await createEvent(db, input());
    await updateEvent(db, created.id, input({ title: "先の保存", revision: 0 }));

    const res = await item.PUT(
      request("PUT", `/api/events/${created.id}`, input({ title: "後の保存", revision: 0 })),
      ctx(created.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", message: "他の人が先に更新しました" } });
    expect((await getEvent(db, created.id)).title).toBe("先の保存");
  });
});

describe("サービス: 終わっていないイベントは 6 件まで（2026-09-25 ユーザー指示。Upcoming に全部出せる数）", () => {
  const now = BASE;
  const DAY = 86400;
  /** 明日から 1 日ずつ先の、終わっていないイベントを count 件 */
  async function fill(count: number, overrides: Record<string, unknown> = {}) {
    const rows = [];
    for (let i = 1; i <= count; i++) rows.push(await createEvent(db, input({ title: `イベント${i}`, startAt: BASE + i * DAY, ...overrides }), now));
    return rows;
  }

  it("6 件あると 7 件目は登録できず（409 limit）、削除すれば登録できる", async () => {
    expect(MAX_ACTIVE_EVENTS).toBe(6);
    const rows = await fill(6);
    const error = await expectServiceError(createEvent(db, input({ startAt: BASE + 10 * DAY }), now), "limit", 409);
    expect(error.message).toContain("削除してください");
    expect(await countActiveEvents(db, now)).toBe(6);

    await deleteEvent(db, rows[0].id);
    expect((await createEvent(db, input({ title: "新しいイベント", startAt: BASE + 10 * DAY }), now)).title).toBe("新しいイベント");
  });

  it("下書きも数える。終わったイベントは数えず、終わったイベントの登録（記録）は止めない", async () => {
    await fill(5);
    await createEvent(db, input({ title: "下書き", status: "draft", startAt: BASE + 20 * DAY }), now);
    await expectServiceError(createEvent(db, input({ startAt: BASE + 30 * DAY }), now), "limit", 409);
    // 昨日終わったイベントは数に入らず、上限でも登録できる
    const past = await createEvent(db, input({ title: "昨日の会", startAt: BASE - DAY, endAt: BASE - DAY + 3600 }), now);
    expect(past.title).toBe("昨日の会");
    expect(await countActiveEvents(db, now)).toBe(6);
  });

  it("終了なしのイベントは開始日の終わりまで数える", async () => {
    await createEvent(db, input({ title: "今朝の会", startAt: BASE - 10 * 3600 }), now);
    expect(await countActiveEvents(db, now)).toBe(1);
    expect(await countActiveEvents(db, tokyoDateTime(2025, 9, 25, 0, 0))).toBe(0);
  });

  it("上限でも、今あるイベントの手直しはできる。終わったイベントを先の日時に直すのは止める", async () => {
    const past = await createEvent(db, input({ title: "昨日の会", startAt: BASE - DAY, endAt: BASE - DAY + 3600 }), now);
    const [first] = await fill(6);
    const edited = await updateEvent(db, first.id, input({ title: "イベント1（変更）", startAt: first.startAt, revision: 0 }), now);
    expect(edited.title).toBe("イベント1（変更）");
    await expectServiceError(
      updateEvent(db, past.id, input({ title: "昨日の会", startAt: BASE + 40 * DAY, revision: 0 }), now),
      "limit",
      409,
    );
    expect((await getEvent(db, past.id)).startAt).toBe(BASE - DAY);
  });
});

describe("Server Actions", () => {
  it("未ログインは unauthorized を返し、何も作らない", async () => {
    expect(await actions.createEventAction(input())).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "ログインしてください" },
    });
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("終わっていないイベントが 6 件あると、作成は limit のメッセージを返す", async () => {
    await login();
    const soon = Math.floor(Date.now() / 1000) + 86400;
    for (let i = 0; i < 6; i++) expect((await actions.createEventAction(input({ startAt: soon + i * 86400 }))).ok).toBe(true);
    const result = await actions.createEventAction(input({ startAt: soon + 10 * 86400 }));
    expect(result).toEqual({ ok: false, error: { code: "limit", message: expect.stringContaining("6 件まで") } });
    expect(await db.select().from(events)).toHaveLength(6);
  });

  it("サービスと同じ規則（作成・一覧・取得・409・deleting 画像・削除・404）", async () => {
    await login();
    const created = await actions.createEventAction(input());
    if (!created.ok) throw new Error(created.error.message);

    const list = await actions.listEventsAction({ status: "published" });
    expect(list.ok && list.data.map((e) => e.id)).toEqual([created.data.id]);
    expect((await actions.getEventAction(created.data.id)).ok).toBe(true);

    expect((await actions.updateEventAction(created.data.id, input({ revision: 0 }))).ok).toBe(true);
    expect(await actions.updateEventAction(created.data.id, input({ revision: 0 }))).toEqual({
      ok: false,
      error: { code: "conflict", message: "他の人が先に更新しました" },
    });

    const deleting = await addMedia({ state: "deleting", deleteAfter: BASE });
    const image = await actions.updateEventAction(created.data.id, input({ imageMediaId: deleting, revision: 1 }));
    expect(!image.ok && image.error.code).toBe("invalid_image");

    expect(await actions.deleteEventAction(created.data.id)).toEqual({ ok: true, data: null });
    const missing = await actions.getEventAction(created.data.id);
    expect(!missing.ok && missing.error.code).toBe("not_found");
  });
});
