import type { ReactNode } from "react";
import { nowSeconds } from "@/db/schema";
import { AdminShell } from "@/components/admin/admin-shell";
import { getDb } from "@/lib/runtime";
import { requirePageUser } from "./_components/current-user";
import { loadShell } from "./_components/load-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "サイネージ管理" };

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requirePageUser();
  const shell = await loadShell(getDb(), user, nowSeconds());
  return <AdminShell shell={shell}>{children}</AdminShell>;
}
