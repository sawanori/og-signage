/**
 * Web で公開するサイネージ（/signage。ログイン不要）のデータ。
 *
 * - 表示する端末は ?device=<id>。省略時は最初に登録した端末。
 * - 公開するのは表示に使う項目だけ。動画の一覧（playlist）とテスト表示の要求（commands）は外す。
 *   動画の定期再生は Pi だけの機能で、Web 版では行わない。
 * - 画像は、公開中の config が参照している画像と、公開中のイベントの画像（イベント詳細ページの写真）だけを
 *   /api/signage/media/<mediaId> で返す（worker/public-signage-relay.ts）。アップロードしただけの画像は外から見えない。
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

/** 公開用の config。表示に使わない項目（動画の一覧・テスト表示の要求）を外す */
export async function buildPublicSignageConfig(
  db: Db,
  deviceId: string,
  now: number,
  siteUrl: string | null = null,
): Promise<SignageConfig> {
  const config = await buildDeviceConfig(db, deviceId, now, siteUrl);
  return { ...config, playlist: [], commands: { testPlayRequestedAt: null } };
}

/** 公開中の config が参照している画像の mediaId */
export function publicImageIds(config: SignageConfig): Set<string> {
  return new Set(
    collectMediaRefs(config)
      .filter((ref) => ref.kind === "image")
      .map((ref) => ref.mediaId),
  );
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
