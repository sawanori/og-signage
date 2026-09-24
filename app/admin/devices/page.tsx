/**
 * 端末（/admin/devices。Administrator のみ。計画 6 節の権限表・8.2 節）。
 * 画面に渡すのは components/admin/devices-types.ts の項目だけで、トークンもそのハッシュも含めない。
 */
import { nowSeconds } from "@/db/schema";
import { DevicesScreen } from "@/components/admin/devices-screen";
import { getDb } from "@/lib/runtime";
import { loadDevices } from "../_components/load-devices";
import { requireAdminPage } from "../_components/require-admin";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `サイネージ端末 | ${ADMIN_TITLE}` };

export default async function DevicesPage() {
  await requireAdminPage();
  const devices = await loadDevices(getDb(), nowSeconds());
  return <DevicesScreen devices={devices} />;
}
