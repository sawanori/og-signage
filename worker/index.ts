/**
 * Worker の入口（wrangler.jsonc の main）。
 *
 * 大きな本文を返す経路だけ vinext より前に処理し、R2 の本文をそのまま返す。
 * vinext の Route Handler を通すと本文が JS で包み直され、500MB で CPU 17〜20 秒を使うため
 * （docs/spikes/workers.md 5 節。独自エントリでは CPU 0〜1ms）。それ以外はすべて vinext に渡す。
 *
 * 追記する場所:
 * - task_012: 端末向けの中継（/api/device/media/[mediaId]、/api/device/bundles/[bundleId]）を
 *   fetch の「大きな本文の中継」の並びに足す。
 * - task_013: Cron Trigger（天気・掃除）。scheduled の本体は worker/scheduled.ts。
 * - Web 公開のサイネージ（/signage）の画像の中継（/api/signage/media/[mediaId]、worker/public-signage-relay.ts）。
 */
import handler from "vinext/server/fetch-handler";
import { getToken } from "next-auth/jwt";
import { loadSessionUser } from "../lib/auth";
import { getMediaBucket, serveObject } from "../lib/r2";
import { getDb } from "../lib/runtime";
import { getActiveMedia } from "../lib/services/media";
import { handleDeviceRelay } from "./device-relay";
import { handlePublicSignageMedia } from "./public-signage-relay";
import { scheduled } from "./scheduled";

type Env = { AUTH_SECRET: string };
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };
type ScheduledController = { cron: string };

const ADMIN_MEDIA_PATH = /^\/api\/media\/([^/]+)\/(file|thumbnail)$/;

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * GET/HEAD /api/media/[id]/file・/thumbnail（管理画面向け。Staff 以上）。
 * セッションは proxy.ts と同じ方法で JWT を読み、lib/auth の loadSessionUser で DB と照合する。
 * 画像のサムネイルが無いときは本体を返す。
 */
async function serveAdminMedia(request: Request, env: Env, id: string, variant: "file" | "thumbnail"): Promise<Response> {
  const secureCookie = new URL(process.env.AUTH_URL ?? request.url).protocol === "https:";
  const token = await getToken({ req: request, secret: env.AUTH_SECRET, secureCookie });
  const db = getDb();
  if (!(await loadSessionUser(db, token))) return jsonError(401, "unauthorized", "ログインしてください");

  const row = await getActiveMedia(db, id);
  if (!row || !row.mimeType || row.fileSize === null) return jsonError(404, "not_found", "メディアが見つかりません");

  const bucket = getMediaBucket();
  if (variant === "thumbnail" && row.thumbnailR2Key) {
    const head = await bucket.head(row.thumbnailR2Key);
    if (!head) return jsonError(404, "not_found", "サムネイルが見つかりません");
    return serveObject(bucket, request, { key: row.thumbnailR2Key, size: head.size, contentType: "image/webp" });
  }
  if (variant === "thumbnail" && row.type !== "image") return jsonError(404, "not_found", "サムネイルがありません");
  return serveObject(bucket, request, { key: row.r2Key, size: row.fileSize, contentType: row.mimeType });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // ---- 大きな本文の中継（vinext より前）
    if (request.method === "GET" || request.method === "HEAD") {
      const adminMedia = ADMIN_MEDIA_PATH.exec(pathname);
      if (adminMedia) return serveAdminMedia(request, env, decodeURIComponent(adminMedia[1]), adminMedia[2] as "file" | "thumbnail");
      // task_012: 端末向けの中継（worker/device-relay.ts）
      if (pathname.startsWith("/api/device/")) {
        const deviceRelay = await handleDeviceRelay(request, pathname, { db: getDb(), bucket: getMediaBucket() });
        if (deviceRelay) return deviceRelay;
      }
      // Web 公開のサイネージの画像（ログイン不要。公開中の config が参照している画像だけ）
      if (pathname.startsWith("/api/signage/media/")) {
        const publicMedia = await handlePublicSignageMedia(request, pathname, { db: getDb(), bucket: getMediaBucket() });
        if (publicMedia) return publicMedia;
      }
    }

    return handler.fetch(request, env, ctx);
  },
  // Cron Trigger（worker/scheduled.ts）。scheduled は早く戻る必要があるため、本体は ctx.waitUntil で待つ
  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduled(controller.cron));
  },
};

export default worker;
