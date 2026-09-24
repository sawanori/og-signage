/**
 * お知らせ（/admin/notices、Staff 以上）。一覧・追加・編集・削除。
 */
import { NoticesView } from "@/components/admin/notices-view";
import { getDb } from "@/lib/runtime";
import { listNotices } from "@/lib/services/notices";
import { requirePageUser } from "../_components/current-user";

export const dynamic = "force-dynamic";

export const metadata = { title: "お知らせ | サイネージ管理" };

export default async function NoticesPage() {
  await requirePageUser();
  const notices = await listNotices(getDb());
  return <NoticesView notices={notices} />;
}
