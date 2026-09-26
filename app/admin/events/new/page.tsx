/** イベントの追加（/admin/events/new、Staff 以上） */
import { nowSeconds } from "@/db/schema";
import { EventForm } from "@/components/admin/event-form";
import { getDb } from "@/lib/runtime";
import { MAX_EVENTS, countEvents } from "@/lib/services/events";
import { listEventCategories } from "@/lib/services/house";
import { requirePageUser } from "../../_components/current-user";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `新しいイベント | ${ADMIN_TITLE}` };

export default async function NewEventPage() {
  await requirePageUser();
  const db = getDb();
  const now = nowSeconds();
  const [categories, eventCount] = await Promise.all([listEventCategories(db), countEvents(db)]);
  return (
    <EventForm
      mode="create"
      now={now}
      categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
      // イベント（下書き・終了を含む）が上限に達していたら、先に知らせて保存できないようにする（2026-09-25・26 ユーザー指示）
      limit={eventCount >= MAX_EVENTS ? { count: eventCount, max: MAX_EVENTS } : null}
    />
  );
}
