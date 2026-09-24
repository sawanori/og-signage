/**
 * メンバー情報（/admin/member-info、Administrator）。サイネージの「MEMBER INFO / メンバー情報」の欄の中身を入力する。
 * 中身は house_rules（旧ハウスルール）。2026-09-25 ユーザー指示でデザイン設定から専用の画面に移した。
 */
import { ForbiddenNotice } from "@/components/admin/forbidden-notice";
import { MemberInfoView } from "@/components/admin/member-info-view";
import { getDb } from "@/lib/runtime";
import { listHouseRules } from "@/lib/services/house";
import { requirePageRole } from "../_components/require-page-role";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `メンバー情報 | ${ADMIN_TITLE}` };

export default async function MemberInfoPage() {
  const user = await requirePageRole("administrator");
  if (!user) return <ForbiddenNotice />;

  const rules = await listHouseRules(getDb());
  return <MemberInfoView rules={rules} />;
}
