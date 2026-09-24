/**
 * Web で公開するサイネージ（/signage。ログイン不要）のデータ。
 *
 * - 表示する端末は ?device=<id>。省略時は最初に登録した端末。
 * - 公開するのは表示に使う項目だけ。動画の一覧（playlist）とテスト表示の要求（commands）は外す。
 *   動画の定期再生は Pi だけの機能で、Web 版では行わない。
 * - 画像は、公開中の config が参照している画像だけを /api/signage/media/<mediaId> で返す
 *   （worker/public-signage-relay.ts）。管理画面にアップロードしただけの画像は外から見えない。
 */
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { devices } from "../db/schema";
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
export async function buildPublicSignageConfig(db: Db, deviceId: string, now: number): Promise<SignageConfig> {
  const config = await buildDeviceConfig(db, deviceId, now);
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
