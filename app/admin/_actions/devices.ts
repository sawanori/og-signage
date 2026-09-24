"use server";

/**
 * 端末の Server Actions（Administrator のみ。計画 6 節の権限表）。
 *
 * 登録・再発行は Pi 用設定ファイルの中身を戻り値で 1 回だけ返す。サーバー側には平文を残さない。
 * apiBaseUrl は要求の Origin（Server Action は vinext が同一 Origin を確認済み）。
 */
import { headers } from "next/headers";
import { z } from "zod";
import { AuthzError, requireRole } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import {
  deleteDevice,
  deviceInputSchema,
  DeviceNotFoundError,
  registerDevice,
  regenerateDeviceToken,
  type IssuedConfig,
} from "../../../lib/services/devices";

export type DeviceActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function apiBaseUrl(): Promise<string> {
  const origin = (await headers()).get("origin");
  if (!origin) throw new Error("origin header is missing");
  return origin;
}

function failure(e: unknown): { ok: false; error: string } {
  if (e instanceof AuthzError) {
    return { ok: false, error: e.status === 401 ? "ログインしてください" : "この操作を行う権限がありません" };
  }
  if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "入力内容を確かめてください" };
  if (e instanceof DeviceNotFoundError) return { ok: false, error: "端末が見つかりません。画面を読み込み直してください" };
  throw e;
}

function fromForm(formData: FormData) {
  return deviceInputSchema.parse({
    name: formData.get("name"),
    orientation: formData.get("orientation"),
    resolutionWidth: formData.get("resolutionWidth"),
    resolutionHeight: formData.get("resolutionHeight"),
  });
}

export async function registerDeviceAction(formData: FormData): Promise<DeviceActionResult<IssuedConfig>> {
  try {
    await requireRole("administrator");
    return { ok: true, data: await registerDevice(getDb(), fromForm(formData), await apiBaseUrl()) };
  } catch (e) {
    return failure(e);
  }
}

export async function regenerateDeviceTokenAction(deviceId: string): Promise<DeviceActionResult<IssuedConfig>> {
  try {
    await requireRole("administrator");
    return { ok: true, data: await regenerateDeviceToken(getDb(), deviceId, await apiBaseUrl()) };
  } catch (e) {
    return failure(e);
  }
}

export async function deleteDeviceAction(deviceId: string): Promise<DeviceActionResult<null>> {
  try {
    await requireRole("administrator");
    await deleteDevice(getDb(), deviceId);
    return { ok: true, data: null };
  } catch (e) {
    return failure(e);
  }
}
