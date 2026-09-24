/**
 * お知らせ（/admin/notices、Staff 以上）。一覧・追加・編集・削除。
 */
import { NoticesView } from "@/components/admin/notices-view";
import { getDb } from "@/lib/runtime";
import { listNotices } from "@/lib/services/notices";
import { requirePageUser } from "../_components/current-user";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `お知らせ | ${ADMIN_TITLE}` };

export default async function NoticesPage() {
  await requirePageUser();
  const notices = await listNotices(getDb());
  return <NoticesView notices={notices} />;
}
