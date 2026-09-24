"use server";

/**
 * イベントの Server Actions（Staff 以上）。Route Handler と同じ lib/services/events.ts を呼ぶ。
 * 失敗は例外にせず { ok: false, error: { code, message } } で返し、画面は入力を保ったまま message を出す。
 */
import { AuthzError, requireRole } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import {
  createEvent,
  deleteEvent,
  EventServiceError,
  getEvent,
  listEvents,
  updateEvent,
  type EventListItem,
  type EventListQuery,
  type EventRow,
} from "../../../lib/services/events";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

async function run<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireRole("staff");
    return { ok: true, data: await action() };
  } catch (e) {
    if (e instanceof AuthzError) {
      return e.status === 401
        ? { ok: false, error: { code: "unauthorized", message: "ログインしてください" } }
        : { ok: false, error: { code: "forbidden", message: "この操作を行う権限がありません" } };
    }
    if (e instanceof EventServiceError) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
}

export async function listEventsAction(query: EventListQuery = {}): Promise<ActionResult<EventListItem[]>> {
  return run(() => listEvents(getDb(), query));
}

export async function getEventAction(id: string): Promise<ActionResult<EventRow>> {
  return run(() => getEvent(getDb(), id));
}

export async function createEventAction(input: unknown): Promise<ActionResult<EventRow>> {
  return run(() => createEvent(getDb(), input));
}

export async function updateEventAction(id: string, input: unknown): Promise<ActionResult<EventRow>> {
  return run(() => updateEvent(getDb(), id, input));
}

export async function deleteEventAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    await deleteEvent(getDb(), id);
    return null;
  });
}
