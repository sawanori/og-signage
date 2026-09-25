/** イベントの追加（/admin/events/new、Staff 以上） */
import { nowSeconds } from "@/db/schema";
import { EventForm } from "@/components/admin/event-form";
import { getDb } from "@/lib/runtime";
import { MAX_ACTIVE_EVENTS, countActiveEvents } from "@/lib/services/events";
import { listEventCategories } from "@/lib/services/house";
import { requirePageUser } from "../../_components/current-user";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `新しいイベント | ${ADMIN_TITLE}` };

export default async function NewEventPage() {
  await requirePageUser();
  const db = getDb();
  const now = nowSeconds();
  const [categories, activeCount] = await Promise.all([listEventCategories(db), countActiveEvents(db, now)]);
  return (
    <EventForm
      mode="create"
      now={now}
      categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
      // 終わっていないイベントが上限に達していたら、先に知らせて保存できないようにする（2026-09-25 ユーザー指示）
      limit={activeCount >= MAX_ACTIVE_EVENTS ? { count: activeCount, max: MAX_ACTIVE_EVENTS } : null}
    />
  );
}
