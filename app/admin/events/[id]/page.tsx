/** イベントの編集（/admin/events/[id]、Staff 以上）。無ければ 404 */
import { notFound } from "next/navigation";
import { EventForm } from "@/components/admin/event-form";
import { getDb } from "@/lib/runtime";
import { EventServiceError, getEvent, type EventRow } from "@/lib/services/events";
import { listEventCategories } from "@/lib/services/house";
import { requirePageUser } from "../../_components/current-user";

export const dynamic = "force-dynamic";

export const metadata = { title: "イベントを編集 | サイネージ管理" };

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  const { id } = await params;
  const db = getDb();
  let event: EventRow;
  try {
    event = await getEvent(db, id);
  } catch (e) {
    if (e instanceof EventServiceError && e.code === "not_found") notFound();
    throw e;
  }
  const categories = await listEventCategories(db);
  return (
    <EventForm
      mode="edit"
      eventId={event.id}
      event={event}
      revision={event.revision}
      categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
    />
  );
}
