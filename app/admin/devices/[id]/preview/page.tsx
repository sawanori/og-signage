/**
 * 端末プレビュー（/admin/devices/[id]/preview。Staff 以上。計画 8.2 節）。
 *
 * 管理セッションで認証し、その端末の config を lib/config-builder.ts で組み立てて、
 * 端末の向きで表示部品（components/signage）を描く。画像は管理用素材 API（/api/media/<id>/file）で読む。
 */
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { devices, nowSeconds } from "@/db/schema";
import { AuthzError, requireRole } from "@/lib/auth";
import { ConfigUnavailableError, buildDeviceConfig } from "@/lib/config-builder";
import type { SignageConfig } from "@/lib/config-schema";
import { getDb } from "@/lib/runtime";
import { PreviewScreen } from "./preview-screen";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `端末プレビュー | ${ADMIN_TITLE}` };

const ORIENTATION_LABEL = { portrait: "縦型", landscape: "横型" } as const;

export default async function DevicePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireRole("staff");
  } catch (e) {
    if (e instanceof AuthzError) redirect(`/login?callbackUrl=${encodeURIComponent(`/admin/devices/${id}/preview`)}`);
    throw e;
  }

  const db = getDb();
  const [device] = await db.select({ name: devices.name }).from(devices).where(eq(devices.id, id));
  if (!device) notFound();

  const now = nowSeconds();
  let config: SignageConfig;
  try {
    config = await buildDeviceConfig(db, id, now);
  } catch (e) {
    if (e instanceof ConfigUnavailableError) {
      if (e.code === "device_not_found") notFound();
      return (
        <main className="p-8">
          <h1 className="mb-4 text-xl font-bold">{device.name} のプレビュー</h1>
          <p>表示の設定がまだそろっていないため、プレビューを表示できません。</p>
        </main>
      );
    }
    throw e;
  }

  return (
    <main className="p-8">
      <h1 className="mb-4 text-xl font-bold">
        {device.name} のプレビュー（{ORIENTATION_LABEL[config.device.orientation]}）
      </h1>
      <p className="mb-4 text-sm">
        この表示はログインなしで Web に公開しています:{" "}
        <a href={`/signage?device=${id}`} target="_blank" rel="noreferrer" className="text-[#3794ff] underline">
          /signage?device={id}
        </a>
      </p>
      <PreviewScreen config={config} initialNow={now} />
    </main>
  );
}
