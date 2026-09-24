/** イベントの追加（/admin/events/new、Staff 以上） */
import { nowSeconds } from "@/db/schema";
import { EventForm } from "@/components/admin/event-form";
import { getDb } from "@/lib/runtime";
import { listEventCategories } from "@/lib/services/house";
import { requirePageUser } from "../../_components/current-user";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `新しいイベント | ${ADMIN_TITLE}` };

export default async function NewEventPage() {
  await requirePageUser();
  const categories = await listEventCategories(getDb());
  return (
    <EventForm
      mode="create"
      now={nowSeconds()}
      categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
    />
  );
}
