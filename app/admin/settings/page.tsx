/**
 * システム設定（/admin/settings。Administrator のみ。計画 6 節の権限表・8.2 節）。ユーザー管理。
 */
import { UsersScreen } from "@/components/admin/users-screen";
import { getDb } from "@/lib/runtime";
import { listUsers } from "@/lib/services/users";
import { requireAdminPage } from "../_components/require-admin";

export const dynamic = "force-dynamic";

export const metadata = { title: "システム設定 | シェアハウス サイネージ管理" };

export default async function SettingsPage() {
  const user = await requireAdminPage();
  const users = await listUsers(getDb());
  return (
    <UsersScreen
      users={users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.isActive }))}
      currentUserId={user.id}
    />
  );
}
