/**
 * Web 公開のサイネージ（/signage）の画像・動画の中継（GET/HEAD /api/signage/media/[mediaId]?device=<id>。ログイン不要）。
 *
 * worker/index.ts が vinext より前に呼ぶ。公開中のイベントの画像（イベント詳細ページの写真）と、
 * 公開中の config（lib/public-signage.ts）が参照している画像・動画（定期動画のプレイリスト）だけを返し、
 * それ以外（アップロードしただけの画像・プレイリストに無い動画）は 404。動画は Range 付きの取得にも応える（serveObject）。
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { media, nowSeconds } from "../db/schema";
import { ConfigUnavailableError } from "../lib/config-builder";
import { buildPublicSignageConfig, isPublishedEventImage, publicMediaIds, resolvePublicDeviceId } from "../lib/public-signage";
import { serveObject, type MediaBucket } from "../lib/r2";

const PUBLIC_MEDIA_PATH = /^\/api\/signage\/media\/([^/]+)$/;

export type PublicSignageRelayDeps = { db: Db; bucket: MediaBucket; now?: number };

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "ファイルが見つかりません" } }, { status: 404 });
}

/** 公開画像の経路なら応答を、そうでなければ null を返す（GET・HEAD のみ呼ぶ） */
export async function handlePublicSignageMedia(
  request: Request,
  pathname: string,
  deps: PublicSignageRelayDeps,
): Promise<Response | null> {
  const match = PUBLIC_MEDIA_PATH.exec(pathname);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return notFound();
  }

  const { db, bucket } = deps;
  try {
    if (!(await isPublishedEventImage(db, id))) {
      // お知らせ・ロゴ・フッターの画像とプレイリストの動画は、公開中の config が参照しているものだけ
      const deviceId = await resolvePublicDeviceId(db, new URL(request.url).searchParams.get("device"));
      if (!deviceId) return notFound();
      const config = await buildPublicSignageConfig(db, deviceId, deps.now ?? nowSeconds());
      if (!publicMediaIds(config).has(id)) return notFound();
    }
    const [row] = await db.select().from(media).where(eq(media.id, id));
    if (!row || !row.mimeType || row.fileSize === null) return notFound();
    return serveObject(bucket, request, { key: row.r2Key, size: row.fileSize, contentType: row.mimeType });
  } catch (e) {
    if (e instanceof ConfigUnavailableError) return notFound();
    throw e;
  }
}
