/**
 * 動画設定とプレイリストのサービスと Server Actions。DB は一時 libSQL ファイル。
 * Server Actions は lib/runtime の getDb と、権限確認のセッション取得だけを差し替える
 * （DB の is_active・role・session_version との照合は本物の lib/auth を通す）。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { devices, media, playlistItems, playlists, users, videoPlaybackSettings } from "../../db/schema";
import {
  addPlaylistItem,
  getDevicePlaybackSettings,
  getPlaylistItems,
  PlaybackServiceError,
  removePlaylistItem,
  reorderPlaylistItems,
  requestTestPlay,
  saveDevicePlayback,
  updateDevicePlaybackSettings,
} from "../../lib/services/playback";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));

vi.mock("../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth")>();
  const deps = () => ({ db: state.db as Db, getSession: async () => state.session });
  return {
    ...actual,
    requireRole: ((role) => actual.requireRole(role, deps())) as typeof actual.requireRole,
  };
});

const actions = await import("../../app/admin/_actions/playback");

let db: Db;
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
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

async function addMedia(overrides: Partial<typeof media.$inferInsert> = {}) {
  const [row] = await db
    .insert(media)
    .values({ name: "clip.mp4", type: "video", r2Key: `media/${crypto.randomUUID()}`, playable: true, ...overrides })
    .returning({ id: media.id });
  return row.id;
}

async function addPlaylist(id = "pl1") {
  await db.insert(playlists).values({ id, name: "定期動画" });
  return id;
}

async function addDevice(id = "d1", overrides: Partial<typeof devices.$inferInsert> = {}) {
  await db.insert(devices).values({ id, name: "エントランス", tokenHash: `hash-${id}`, ...overrides });
  return id;
}

async function addSettings(deviceId: string, overrides: Partial<typeof videoPlaybackSettings.$inferInsert> = {}) {
  await db.insert(videoPlaybackSettings).values({ deviceId, ...overrides });
}

async function expectServiceError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PlaybackServiceError);
  expect((error as PlaybackServiceError).code).toBe(code);
  expect((error as PlaybackServiceError).status).toBe(status);
  return error as PlaybackServiceError;
}

describe("プレイリスト: 追加", () => {
  it("末尾に追加され、position は 0 から、revision が 1 増える", async () => {
    await addPlaylist("pl1");
    const v1 = await addMedia();
    const v2 = await addMedia();

    const first = await addPlaylistItem(db, "pl1", { revision: 0, mediaId: v1 });
    expect(first.playlist.revision).toBe(1);
    expect(first.items.map((i) => [i.mediaId, i.position])).toEqual([[v1, 0]]);

    const second = await addPlaylistItem(db, "pl1", { revision: 1, mediaId: v2 });
    expect(second.playlist.revision).toBe(2);
    expect(second.items.map((i) => [i.mediaId, i.position])).toEqual([
      [v1, 0],
      [v2, 1],
    ]);
    expect(second.items[0].media.id).toBe(v1);
  });

  it("30 秒を超える動画は再生リストに入れられない（2026-09-26 に 20 秒から 30 秒へ）", async () => {
    await addPlaylist("pl1");
    const long = await addMedia({ durationSeconds: 31 });
    const error = await expectServiceError(addPlaylistItem(db, "pl1", { revision: 0, mediaId: long }), "invalid_media", 400);
    expect(error.message).toBe("この動画は 30 秒を超えているため再生リストに入れられません");
    const thirty = await addMedia({ durationSeconds: 30 });
    await expect(addPlaylistItem(db, "pl1", { revision: 0, mediaId: thirty })).resolves.toBeTruthy();
  });

  it("playable=false・state=deleting・type≠video は追加できない（利用者向けの理由）", async () => {
    await addPlaylist("pl1");
    const notPlayable = await addMedia({ playable: false });
    const deleting = await addMedia({ state: "deleting", deleteAfter: 1 });
    const image = await addMedia({ type: "image", playable: false });

    const e1 = await expectServiceError(
      addPlaylistItem(db, "pl1", { revision: 0, mediaId: notPlayable }),
      "invalid_media",
      400,
    );
    expect(e1.message).toBe("この動画はサイネージで再生できない形式です");

    const e2 = await expectServiceError(
      addPlaylistItem(db, "pl1", { revision: 0, mediaId: deleting }),
      "invalid_media",
      400,
    );
    expect(e2.message).toBe("この動画は削除予定のため追加できません");

    const e3 = await expectServiceError(addPlaylistItem(db, "pl1", { revision: 0, mediaId: image }), "invalid_media", 400);
    expect(e3.message).toBe("この動画はサイネージで再生できない形式です");

    expect(await getPlaylistItems(db, "pl1")).toHaveLength(0);
  });

  it("存在しない動画は 400、存在しないプレイリストは 404", async () => {
    await addPlaylist("pl1");
    await expectServiceError(addPlaylistItem(db, "pl1", { revision: 0, mediaId: "none" }), "invalid_media", 400);
    await expectServiceError(addPlaylistItem(db, "none", { revision: 0, mediaId: "none" }), "not_found", 404);
  });

  it("revision 不一致は 409 で、追加されない", async () => {
    await addPlaylist("pl1");
    const v1 = await addMedia();
    const error = await expectServiceError(addPlaylistItem(db, "pl1", { revision: 1, mediaId: v1 }), "conflict", 409);
    expect(error.message).toBe("他の人が先に更新しました");
    expect(await getPlaylistItems(db, "pl1")).toHaveLength(0);
  });

  it("入力の誤りは 400", async () => {
    await addPlaylist("pl1");
    await expectServiceError(addPlaylistItem(db, "pl1", { revision: 0 }), "invalid_input", 400);
  });
});

describe("プレイリスト: 削除", () => {
  async function fixture() {
    await addPlaylist("pl1");
    const v1 = await addMedia({ name: "v1.mp4" });
    const v2 = await addMedia({ name: "v2.mp4" });
    const v3 = await addMedia({ name: "v3.mp4" });
    const a = await addPlaylistItem(db, "pl1", { revision: 0, mediaId: v1 });
    const b = await addPlaylistItem(db, "pl1", { revision: a.playlist.revision, mediaId: v2 });
    const c = await addPlaylistItem(db, "pl1", { revision: b.playlist.revision, mediaId: v3 });
    return { items: c.items, revision: c.playlist.revision };
  }

  it("削除すると position が 0..n-1 に詰め直され、revision が増える", async () => {
    const { items, revision } = await fixture();
    const removedId = items[0].id;
    const result = await removePlaylistItem(db, "pl1", { revision, itemId: removedId });
    expect(result.playlist.revision).toBe(revision + 1);
    expect(result.items.map((i) => i.position)).toEqual([0, 1]);
    expect(result.items.find((i) => i.id === removedId)).toBeUndefined();
  });

  it("存在しない項目は 404、revision 不一致は 409", async () => {
    const { items, revision } = await fixture();
    await expectServiceError(removePlaylistItem(db, "pl1", { revision, itemId: "none" }), "not_found", 404);
    await expectServiceError(
      removePlaylistItem(db, "pl1", { revision: revision + 1, itemId: items[0].id }),
      "conflict",
      409,
    );
  });
});

describe("プレイリスト: 並べ替え", () => {
  async function fixture() {
    await addPlaylist("pl1");
    const v1 = await addMedia({ name: "v1.mp4" });
    const v2 = await addMedia({ name: "v2.mp4" });
    const v3 = await addMedia({ name: "v3.mp4" });
    const a = await addPlaylistItem(db, "pl1", { revision: 0, mediaId: v1 });
    const b = await addPlaylistItem(db, "pl1", { revision: a.playlist.revision, mediaId: v2 });
    const c = await addPlaylistItem(db, "pl1", { revision: b.playlist.revision, mediaId: v3 });
    return { items: c.items, revision: c.playlist.revision };
  }

  it("position の重複を起こさずに並べ替えられる", async () => {
    const { items, revision } = await fixture();
    const [first, second, third] = items;
    const newOrder = [third.id, first.id, second.id];

    const result = await reorderPlaylistItems(db, "pl1", { revision, itemIds: newOrder });
    expect(result.playlist.revision).toBe(revision + 1);
    expect(result.items.map((i) => i.id)).toEqual(newOrder);

    const positions = result.items.map((i) => i.position);
    expect(positions).toEqual([0, 1, 2]);
    expect(new Set(positions).size).toBe(positions.length);

    // DB 上でも重複しない
    const rows = await db.select().from(playlistItems).where(eq(playlistItems.playlistId, "pl1"));
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
  });

  it("項目の集合が異なる並べ替えは 400", async () => {
    const { items, revision } = await fixture();
    await expectServiceError(
      reorderPlaylistItems(db, "pl1", { revision, itemIds: [items[0].id, items[1].id] }),
      "invalid_input",
      400,
    );
    await expectServiceError(
      reorderPlaylistItems(db, "pl1", { revision, itemIds: [items[0].id, items[1].id, "none"] }),
      "invalid_input",
      400,
    );
  });

  it("revision 不一致は 409", async () => {
    const { items, revision } = await fixture();
    await expectServiceError(
      reorderPlaylistItems(db, "pl1", { revision: revision + 1, itemIds: items.map((i) => i.id) }),
      "conflict",
      409,
    );
  });
});

describe("端末ごとの再生設定", () => {
  it("取得: 音量は devices、それ以外は video_playback_settings から合成される", async () => {
    await addDevice("d1", { volume: 42 });
    await addSettings("d1", { enabled: false, intervalMinutes: 30, playbackMode: "random" });

    const settings = await getDevicePlaybackSettings(db, "d1");
    expect(settings).toMatchObject({ enabled: false, intervalMinutes: 30, playbackMode: "random", volume: 42, revision: 0 });
  });

  it("端末が無ければ 404、設定行が無ければ 404", async () => {
    await expectServiceError(getDevicePlaybackSettings(db, "none"), "not_found", 404);
    await addDevice("d1");
    await expectServiceError(getDevicePlaybackSettings(db, "d1"), "not_found", 404);
  });

  it("更新: ON/OFF・間隔・順番・音量が保存され revision が増える", async () => {
    await addDevice("d1");
    await addSettings("d1");

    const updated = await updateDevicePlaybackSettings(db, "d1", {
      revision: 0,
      enabled: false,
      intervalMinutes: 20,
      mode: "random",
      volume: 80,
    });
    expect(updated).toMatchObject({ enabled: false, intervalMinutes: 20, playbackMode: "random", volume: 80, revision: 1 });

    const [device] = await db.select().from(devices).where(eq(devices.id, "d1"));
    expect(device.volume).toBe(80);
  });

  it("間隔は5/10/15/20/30/60分以外は400、音量は0〜100の範囲外は400", async () => {
    await addDevice("d1");
    await addSettings("d1");
    const base = { revision: 0, enabled: true, mode: "sequence" as const };

    await expectServiceError(
      updateDevicePlaybackSettings(db, "d1", { ...base, intervalMinutes: 7, volume: 0 }),
      "invalid_input",
      400,
    );
    await expectServiceError(
      updateDevicePlaybackSettings(db, "d1", { ...base, intervalMinutes: 10, volume: -1 }),
      "invalid_input",
      400,
    );
    await expectServiceError(
      updateDevicePlaybackSettings(db, "d1", { ...base, intervalMinutes: 10, volume: 101 }),
      "invalid_input",
      400,
    );
  });

  it("revision 不一致は 409 で、何も変わらない", async () => {
    await addDevice("d1");
    await addSettings("d1");
    const error = await expectServiceError(
      updateDevicePlaybackSettings(db, "d1", { revision: 1, enabled: true, intervalMinutes: 10, mode: "sequence", volume: 50 }),
      "conflict",
      409,
    );
    expect(error.message).toBe("他の人が先に更新しました");
    const settings = await getDevicePlaybackSettings(db, "d1");
    expect(settings.revision).toBe(0);
    expect(settings.volume).toBe(0);
  });
});

describe("プレイリストと再生設定をまとめて保存", () => {
  async function fixture() {
    await addPlaylist("pl1");
    await addDevice("d1", { volume: 30 });
    await addSettings("d1", { playlistId: "pl1" });
    const v1 = await addMedia({ name: "v1.mp4" });
    const v2 = await addMedia({ name: "v2.mp4" });
    const v3 = await addMedia({ name: "v3.mp4" });
    const a = await addPlaylistItem(db, "pl1", { revision: 0, mediaId: v1 });
    const b = await addPlaylistItem(db, "pl1", { revision: a.playlist.revision, mediaId: v2 });
    return { v1, v2, v3, playlistRevision: b.playlist.revision };
  }

  const settingsInput = { revision: 0, enabled: false, intervalMinutes: 30, mode: "random" as const, volume: 70 };

  async function snapshot() {
    return {
      items: (await getPlaylistItems(db, "pl1")).map((i) => [i.mediaId, i.position]),
      playlistRevision: (await db.select().from(playlists).where(eq(playlists.id, "pl1")))[0].revision,
      settings: await getDevicePlaybackSettings(db, "d1"),
    };
  }

  it("再生する動画は 3 本まで。4 本にする保存は入力不正で、何も書かない", async () => {
    const { v1, v2, v3, playlistRevision } = await fixture();
    const v4 = await addMedia({ name: "v4.mp4" });
    const before = await snapshot();
    const error = await expectServiceError(
      saveDevicePlayback(db, "d1", { settings: settingsInput, playlist: { revision: playlistRevision, mediaIds: [v1, v2, v3, v4] } }),
      "invalid_input",
      400,
    );
    expect(error.message).toBe("再生する動画は 3 本までです");
    expect(await snapshot()).toEqual(before);
    await expect(
      saveDevicePlayback(db, "d1", { settings: settingsInput, playlist: { revision: playlistRevision, mediaIds: [v1, v2, v3] } }),
    ).resolves.toBeTruthy();
  });

  it("1 本ずつの追加も 3 本まで", async () => {
    const { v3, playlistRevision } = await fixture();
    const third = await addPlaylistItem(db, "pl1", { revision: playlistRevision, mediaId: v3 });
    const v4 = await addMedia({ name: "v4.mp4" });
    const error = await expectServiceError(
      addPlaylistItem(db, "pl1", { revision: third.playlist.revision, mediaId: v4 }),
      "invalid_input",
      400,
    );
    expect(error.message).toBe("再生する動画は 3 本までです");
  });

  it("外す・追加・並べ替え・再生設定を 1 回で丸ごと保存する", async () => {
    const { v1, v3, playlistRevision } = await fixture();

    const result = await saveDevicePlayback(db, "d1", {
      settings: settingsInput,
      playlist: { revision: playlistRevision, mediaIds: [v3, v1] },
    });
    expect(result.playlist?.playlist.revision).toBe(playlistRevision + 1);
    expect(result.playlist?.items.map((i) => [i.mediaId, i.position])).toEqual([
      [v3, 0],
      [v1, 1],
    ]);
    expect(result.settings).toMatchObject({ enabled: false, intervalMinutes: 30, playbackMode: "random", volume: 70, revision: 1 });

    const after = await snapshot();
    expect(after.items).toEqual([
      [v3, 0],
      [v1, 1],
    ]);
    expect(after.settings).toMatchObject({ enabled: false, intervalMinutes: 30, playbackMode: "random", volume: 70, revision: 1 });
  });

  it("途中に再生できない動画があれば 400 で、プレイリストも再生設定も何も書かれない", async () => {
    const { v1, v3, playlistRevision } = await fixture();
    const notPlayable = await addMedia({ playable: false });
    const deleting = await addMedia({ state: "deleting", deleteAfter: 1 });
    const image = await addMedia({ type: "image", playable: false });
    const before = await snapshot();

    for (const bad of [notPlayable, deleting, image, "none"]) {
      await expectServiceError(
        saveDevicePlayback(db, "d1", {
          settings: settingsInput,
          playlist: { revision: playlistRevision, mediaIds: [v3, bad, v1] },
        }),
        "invalid_media",
        400,
      );
    }
    expect(await snapshot()).toEqual(before);
  });

  it("間隔・音量の不正は 400 で何も書かれない", async () => {
    const { v1, playlistRevision } = await fixture();
    const before = await snapshot();
    for (const patch of [{ intervalMinutes: 7 }, { volume: -1 }, { volume: 101 }]) {
      await expectServiceError(
        saveDevicePlayback(db, "d1", {
          settings: { ...settingsInput, ...patch },
          playlist: { revision: playlistRevision, mediaIds: [v1] },
        }),
        "invalid_input",
        400,
      );
    }
    expect(await snapshot()).toEqual(before);
  });

  it("プレイリストか再生設定の revision が古ければ 409 で、何も書かれない", async () => {
    const { v1, v3, playlistRevision } = await fixture();
    const before = await snapshot();

    await expectServiceError(
      saveDevicePlayback(db, "d1", {
        settings: settingsInput,
        playlist: { revision: playlistRevision - 1, mediaIds: [v3, v1] },
      }),
      "conflict",
      409,
    );
    await expectServiceError(
      saveDevicePlayback(db, "d1", {
        settings: { ...settingsInput, revision: 5 },
        playlist: { revision: playlistRevision, mediaIds: [v3, v1] },
      }),
      "conflict",
      409,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("Server Action から Staff が保存でき、未ログインは何も書かれない", async () => {
    const { v2, playlistRevision } = await fixture();
    const input = { settings: settingsInput, playlist: { revision: playlistRevision, mediaIds: [v2] } };

    expect(await actions.saveDevicePlaybackAction("d1", input)).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "ログインしてください" },
    });
    await login("staff");
    const saved = await actions.saveDevicePlaybackAction("d1", input);
    expect(saved.ok && saved.data.playlist?.items.map((i) => i.mediaId)).toEqual([v2]);
  });
});

describe("テスト表示", () => {
  it("test_play_requested_at に現在時刻を入れる", async () => {
    await addDevice("d1");
    const before = Math.floor(Date.now() / 1000);
    const result = await requestTestPlay(db, "d1");
    expect(result.testPlayRequestedAt).toBeGreaterThanOrEqual(before);

    const [device] = await db.select().from(devices).where(eq(devices.id, "d1"));
    expect(device.testPlayRequestedAt).toBe(result.testPlayRequestedAt);
  });

  it("存在しない端末は 404", async () => {
    await expectServiceError(requestTestPlay(db, "none"), "not_found", 404);
  });

  it("動画を選んだときは、その端末の再生リストにある動画だけを指定できる", async () => {
    await addPlaylist("pl1");
    await addDevice("d1");
    await addSettings("d1", { playlistId: "pl1" });
    const inList = await addMedia({ name: "in.mp4" });
    const notInList = await addMedia({ name: "out.mp4" });
    await addPlaylistItem(db, "pl1", { revision: 0, mediaId: inList });

    const result = await requestTestPlay(db, "d1", inList);
    expect(result.testPlayMediaId).toBe(inList);
    const [device] = await db.select().from(devices).where(eq(devices.id, "d1"));
    expect(device.testPlayMediaId).toBe(inList);

    const error = await expectServiceError(requestTestPlay(db, "d1", notInList), "invalid_media", 400);
    expect(error.message).toContain("再生リストにありません");

    // 動画を選ばない「テスト表示」は、前に選んだ動画を消して次の 1 本にする
    expect((await requestTestPlay(db, "d1")).testPlayMediaId).toBeNull();
  });
});

describe("Server Actions", () => {
  it("未ログインは unauthorized を返し、何も変わらない", async () => {
    await addPlaylist("pl1");
    await addDevice("d1");
    await addSettings("d1");

    expect(await actions.getPlaylistItemsAction("pl1")).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "ログインしてください" },
    });
    expect(await actions.requestTestPlayAction("d1")).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "ログインしてください" },
    });
    const [device] = await db.select().from(devices).where(eq(devices.id, "d1"));
    expect(device.testPlayRequestedAt).toBeNull();
  });

  it("Staff はプレイリスト操作・設定更新・テスト表示ができる", async () => {
    await login("staff");
    await addPlaylist("pl1");
    await addDevice("d1");
    await addSettings("d1");
    const mediaId = await addMedia();

    const added = await actions.addPlaylistItemAction("pl1", { revision: 0, mediaId });
    if (!added.ok) throw new Error(added.error.message);
    expect(added.data.items).toHaveLength(1);

    const reordered = await actions.reorderPlaylistItemsAction("pl1", {
      revision: added.data.playlist.revision,
      itemIds: added.data.items.map((i) => i.id),
    });
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) throw new Error(reordered.error.message);

    const removed = await actions.removePlaylistItemAction("pl1", {
      revision: reordered.data.playlist.revision,
      itemId: added.data.items[0].id,
    });
    expect(removed.ok && removed.data.items).toEqual([]);

    const settings = await actions.getDevicePlaybackSettingsAction("d1");
    expect(settings.ok && settings.data.revision).toBe(0);

    const updated = await actions.updateDevicePlaybackSettingsAction("d1", {
      revision: 0,
      enabled: true,
      intervalMinutes: 15,
      mode: "random",
      volume: 60,
    });
    expect(updated.ok && updated.data).toMatchObject({ intervalMinutes: 15, playbackMode: "random", volume: 60 });

    const tested = await actions.requestTestPlayAction("d1");
    expect(tested.ok).toBe(true);
  });

  it("Administrator も使える", async () => {
    await login("administrator");
    await addDevice("d1");
    await addSettings("d1");
    expect((await actions.requestTestPlayAction("d1")).ok).toBe(true);
  });
});
