/**
 * 端末向けの本文の中継（GET/HEAD /api/device/media/[mediaId]、/api/device/bundles/[bundleId]）。計画 6 節の前提 6、9 節。
 *
 * worker/index.ts が vinext より前に呼ぶ。R2 の本文をそのまま返す（docs/spikes/workers.md 5 節）。
 * - 端末トークンをここで確かめる（失敗は 401。トークンはログに出さない）。
 * - その端末の現行 config（lib/config-builder.ts）に含まれる mediaId・bundleId だけを返し、それ以外は 404。
 * - Range は lib/r2.ts の serveObject が解釈する（範囲外は 416）。
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { displayBundles, media, nowSeconds } from "../db/schema";
import { ConfigUnavailableError, buildDeviceConfig } from "../lib/config-builder";
import { collectMediaRefs } from "../lib/config-schema";
import { DeviceAuthError, authenticateDevice, deviceAuthErrorResponse } from "../lib/device-auth";
import { serveObject, type MediaBucket } from "../lib/r2";

const DEVICE_RELAY_PATH = /^\/api\/device\/(media|bundles)\/([^/]+)$/;

export type DeviceRelayDeps = { db: Db; bucket: MediaBucket; now?: number };

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "ファイルが見つかりません" } }, { status: 404 });
}

/** 端末向けの中継の経路なら応答を、そうでなければ null を返す（GET・HEAD のみ呼ぶ） */
export async function handleDeviceRelay(request: Request, pathname: string, deps: DeviceRelayDeps): Promise<Response | null> {
  const match = DEVICE_RELAY_PATH.exec(pathname);
  if (!match) return null;
  const kind = match[1] as "media" | "bundles";
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return notFound();
  }

  const { db, bucket } = deps;
  try {
    const device = await authenticateDevice(db, request);
    const config = await buildDeviceConfig(db, device.id, deps.now ?? nowSeconds());

    if (kind === "bundles") {
      if (config.displayBundle.id !== id) return notFound();
      const [bundle] = await db.select().from(displayBundles).where(eq(displayBundles.id, id));
      if (!bundle) return notFound();
      return serveObject(bucket, request, { key: bundle.r2Key, size: bundle.size, contentType: "application/zip" });
    }

    if (!collectMediaRefs(config).some((ref) => ref.mediaId === id)) return notFound();
    const [row] = await db.select().from(media).where(eq(media.id, id));
    if (!row || !row.mimeType || row.fileSize === null) return notFound();
    return serveObject(bucket, request, { key: row.r2Key, size: row.fileSize, contentType: row.mimeType });
  } catch (e) {
    if (e instanceof DeviceAuthError) return deviceAuthErrorResponse();
    if (e instanceof ConfigUnavailableError) return notFound();
    throw e;
  }
}
