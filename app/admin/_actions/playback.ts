"use server";

/**
 * 動画設定とプレイリストの Server Actions（Staff 以上。計画 6 節の権限表）。
 * 失敗は例外にせず { ok: false, error: { code, message } } で返し、画面は入力を保ったまま message を出す。
 */
import { AuthzError, requireRole } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import {
  addPlaylistItem,
  getDevicePlaybackSettings,
  getPlaylistItems,
  PlaybackServiceError,
  removePlaylistItem,
  reorderPlaylistItems,
  requestTestPlay,
  updateDevicePlaybackSettings,
  type DevicePlaybackSettings,
  type PlaylistItemWithMedia,
  type PlaylistMutationResult,
} from "../../../lib/services/playback";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

async function run<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireRole("staff");
    return { ok: true, data: await action() };
  } catch (e) {
    if (e instanceof AuthzError) {
      return e.status === 401
        ? { ok: false, error: { code: "unauthorized", message: "ログインしてください" } }
        : { ok: false, error: { code: "forbidden", message: "この操作を行う権限がありません" } };
    }
    if (e instanceof PlaybackServiceError) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
}

// ---------------------------------------------------------------- プレイリスト

export async function getPlaylistItemsAction(playlistId: string): Promise<ActionResult<PlaylistItemWithMedia[]>> {
  return run(() => getPlaylistItems(getDb(), playlistId));
}

export async function addPlaylistItemAction(playlistId: string, input: unknown): Promise<ActionResult<PlaylistMutationResult>> {
  return run(() => addPlaylistItem(getDb(), playlistId, input));
}

export async function removePlaylistItemAction(
  playlistId: string,
  input: unknown,
): Promise<ActionResult<PlaylistMutationResult>> {
  return run(() => removePlaylistItem(getDb(), playlistId, input));
}

export async function reorderPlaylistItemsAction(
  playlistId: string,
  input: unknown,
): Promise<ActionResult<PlaylistMutationResult>> {
  return run(() => reorderPlaylistItems(getDb(), playlistId, input));
}

// ---------------------------------------------------------------- 端末ごとの再生設定

export async function getDevicePlaybackSettingsAction(deviceId: string): Promise<ActionResult<DevicePlaybackSettings>> {
  return run(() => getDevicePlaybackSettings(getDb(), deviceId));
}

export async function updateDevicePlaybackSettingsAction(
  deviceId: string,
  input: unknown,
): Promise<ActionResult<DevicePlaybackSettings>> {
  return run(() => updateDevicePlaybackSettings(getDb(), deviceId, input));
}

// ---------------------------------------------------------------- テスト表示

export async function requestTestPlayAction(deviceId: string): Promise<ActionResult<{ testPlayRequestedAt: number }>> {
  return run(() => requestTestPlay(getDb(), deviceId));
}
