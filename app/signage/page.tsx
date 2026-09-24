/**
 * Web 公開のサイネージ（/signage。ログイン不要）。Pi と同じ表示部品を画面いっぱいに描く。
 *
 * - ?device=<id> で端末を選ぶ（省略時は最初に登録した端末。lib/public-signage.ts）。
 * - ?layout=portrait|landscape で縦横を固定する（省略時は見ている画面の向きに合わせる）。
 * - 動画の定期再生は Pi だけの機能で、ここでは行わない。
 */
import { nowSeconds } from "@/db/schema";
import { ConfigUnavailableError } from "@/lib/config-builder";
import { buildPublicSignageConfig, resolvePublicDeviceId } from "@/lib/public-signage";
import { getDb } from "@/lib/runtime";
import { PublicSignage } from "./public-signage";

export const dynamic = "force-dynamic";

export const metadata = { title: "デジタルサイネージ", robots: { index: false, follow: false } };

type SearchParams = Promise<{ device?: string | string[]; layout?: string | string[] }>;

export default async function PublicSignagePage({ searchParams }: { searchParams: SearchParams }) {
  const { device, layout } = await searchParams;
  const db = getDb();
  const now = nowSeconds();
  const deviceId = await resolvePublicDeviceId(db, typeof device === "string" ? device : null);
  const config = deviceId ? await loadConfig(db, deviceId, now) : null;
  if (!deviceId || !config) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black text-white">
        <p>表示できるサイネージがまだありません。</p>
      </main>
    );
  }
  return (
    <PublicSignage
      deviceId={deviceId}
      initialConfig={config}
      initialNow={now}
      layout={layout === "portrait" || layout === "landscape" ? layout : null}
    />
  );
}

/** 表示の準備ができていない（表示バンドル未公開など）ときは null */
async function loadConfig(db: ReturnType<typeof getDb>, deviceId: string, now: number) {
  try {
    return await buildPublicSignageConfig(db, deviceId, now);
  } catch (e) {
    if (e instanceof ConfigUnavailableError) return null;
    throw e;
  }
}
