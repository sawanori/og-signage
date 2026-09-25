/**
 * Web で公開するサイネージ（/signage。ログイン不要）のデータ。
 *
 * - 表示する端末は ?device=<id>。省略時は最初に登録した端末。
 * - 端末の config をそのまま返す。Web 版も定期動画を流すため（2026-09-25 から。Pi のブラウザで /signage を開いて使う）、
 *   動画の一覧（playlist）・再生の設定（video）・テスト表示の要求（commands）も含める（app/signage/video-player.tsx）。
 * - 画像・動画は、公開中の config が参照しているもの（プレイリストの動画を含む）と、公開中のイベントの画像
 *   （イベント詳細ページの写真）だけを /api/signage/media/<mediaId> で返す（worker/public-signage-relay.ts）。
 *   アップロードしただけの画像・動画は外から見えない。
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { eventCategories, events, devices, media } from "../db/schema";
import { buildDeviceConfig } from "./config-builder";
import { collectMediaRefs, type SignageConfig } from "./config-schema";

/** 表示する端末の id。?device が無ければ最初に登録した端末。見つからなければ null */
export async function resolvePublicDeviceId(db: Db, requested: string | null): Promise<string | null> {
  if (requested) {
    const [row] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, requested));
    return row?.id ?? null;
  }
  const [first] = await db
    .select({ id: devices.id })
    .from(devices)
    .orderBy(asc(devices.createdAt), asc(devices.id))
    .limit(1);
  return first?.id ?? null;
}

/** 公開用の config（端末の config と同じ。定期動画のプレイリスト・テスト表示の要求も含む） */
export async function buildPublicSignageConfig(
  db: Db,
  deviceId: string,
  now: number,
  siteUrl: string | null = null,
): Promise<SignageConfig> {
  return buildDeviceConfig(db, deviceId, now, siteUrl);
}

/** 公開中の config が参照している画像・動画（プレイリストの動画）の mediaId */
export function publicMediaIds(config: SignageConfig): Set<string> {
  return new Set(collectMediaRefs(config).map((ref) => ref.mediaId));
}

/** イベント詳細ページ（/events/[id]）に出す、公開中のイベント。下書き・存在しないものは null */
export async function getPublicEvent(db: Db, eventId: string) {
  const [row] = await db
    .select({ event: events, category: eventCategories, image: { id: media.id, state: media.state } })
    .from(events)
    .leftJoin(eventCategories, eq(events.categoryId, eventCategories.id))
    .leftJoin(media, eq(events.imageMediaId, media.id))
    .where(and(eq(events.id, eventId), eq(events.status, "published")));
  if (!row) return null;
  return {
    ...row.event,
    category: row.category ? { name: row.category.name, color: row.category.color } : null,
    imageMediaId: row.image && row.image.state === "active" ? row.image.id : null,
  };
}

/** 公開中のイベントの画像か（イベント詳細ページの写真。表示中の config に無い先の日付のイベントも含む） */
export async function isPublishedEventImage(db: Db, mediaId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .innerJoin(media, eq(events.imageMediaId, media.id))
    .where(and(eq(events.imageMediaId, mediaId), eq(events.status, "published"), eq(media.state, "active")))
    .limit(1);
  return Boolean(row);
}
