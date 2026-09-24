/**
 * イベント管理の一覧（/admin/events、Staff 以上）。リスト / 月のカレンダー。
 * 保存・削除のあとは ?saved=created|updated|deleted で戻ってきて、結果を知らせる。
 */
import { nowSeconds } from "@/db/schema";
import { EventsManager } from "@/components/admin/events-manager";
import { mediaThumbnailUrl, type ManagedEvent, type SavedNotice } from "@/components/admin/event-types";
import { getDb } from "@/lib/runtime";
import { listEvents } from "@/lib/services/events";
import { listEventCategories } from "@/lib/services/house";
import { requirePageUser } from "../_components/current-user";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `イベント管理 | ${ADMIN_TITLE}` };

const SAVED: readonly SavedNotice[] = ["created", "updated", "deleted"];

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageUser();
  const { saved } = await searchParams;
  const db = getDb();
  const now = nowSeconds();
  const [rows, categories] = await Promise.all([listEvents(db, {}, now), listEventCategories(db)]);
  const categoryById = new Map(categories.map((c) => [c.id, { id: c.id, name: c.name, color: c.color }]));

  const events: ManagedEvent[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    emoji: row.emoji,
    status: row.status,
    startAt: row.startAt,
    endAt: row.endAt,
    location: row.location,
    hostName: row.hostName,
    description: row.description,
    capacity: row.capacity,
    participantCount: row.participantCount,
    category: row.categoryId ? (categoryById.get(row.categoryId) ?? null) : null,
    imageUrl: row.imageMediaId ? mediaThumbnailUrl(row.imageMediaId) : null,
    phase: row.phase,
  }));

  const notice = SAVED.find((s) => s === saved) ?? null;
  return <EventsManager events={events} now={now} saved={notice} />;
}
