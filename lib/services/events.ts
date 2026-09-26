/**
 * イベントのサービス（実装計画 9 節の管理用 API と、管理画面の Server Actions が共通で呼ぶ）。
 *
 * - 更新は revision による条件付き更新。不一致は EventServiceError（409 conflict）。
 * - config の版は config JSON の SHA-256 で決まるので、ここで版を上げる処理はしない。
 * - 画像は media が active かつ type=image のものだけ参照できる（deleting は不可）。
 *   参照の確認と書き込みは同じトランザクションで行い、確認後に削除予約へ変わる隙を作らない。
 * - カテゴリは event_categories にあるものだけ。
 * - 終わっていないイベント（下書きを含む）は MAX_ACTIVE_EVENTS 件まで。超える登録は削除してからにする
 *   （2026-09-25 ユーザー指示。2026-09-26 に 6 → 10 件。サイネージの Upcoming に出すのは開催の近い順に UPCOMING_LIMIT 件）。
 * - 終わったイベントは「終了」のまま 1 週間残し、過ぎたら毎日の Cron（worker/scheduled.ts）が purgeEndedEvents で消す
 *   （2026-09-26 ユーザー指示）。
 * - エラーの message は利用者向けの日本語。
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Db } from "../../db/index";
import { eventCategories, events, media, nowSeconds } from "../../db/schema";
import { SECONDS_PER_DAY } from "../dates";
import { effectiveEndAt, getEventState } from "../display-rules";
import { eventInputSchema, eventUpdateSchema, type EventInput } from "../validators";

export type EventRow = typeof events.$inferSelect;

/** 管理画面の状態の区分。開催前（今日・開始間近を含む）/ 開催中 / 終了 */
export type EventPhase = "before" | "ongoing" | "ended";

export type EventListItem = EventRow & { phase: EventPhase };

export type EventErrorCode = "invalid_input" | "invalid_image" | "invalid_category" | "not_found" | "conflict" | "limit";

const STATUS_BY_CODE: Record<EventErrorCode, 400 | 404 | 409> = {
  invalid_input: 400,
  invalid_image: 400,
  invalid_category: 400,
  not_found: 404,
  conflict: 409,
  limit: 409,
};

/** 終わっていないイベント（下書きを含む）の上限（2026-09-26 ユーザー指示で 6 → 10 件） */
export const MAX_ACTIVE_EVENTS = 10;

/** 終わったイベントを「終了」として残す期間（2026-09-26 ユーザー指示で 1 週間。過ぎたら purgeEndedEvents で消す） */
export const ENDED_EVENT_RETENTION_SECONDS = 7 * SECONDS_PER_DAY;

export class EventServiceError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(
    readonly code: EventErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EventServiceError";
    this.status = STATUS_BY_CODE[code];
  }
}

const notFound = () => new EventServiceError("not_found", "イベントが見つかりません。削除された可能性があります");
const limitReached = (action: string) =>
  new EventServiceError(
    "limit",
    `終わっていないイベントは ${MAX_ACTIVE_EVENTS} 件まで（下書きを含む）です。${action}には、イベント一覧でどれかを削除してください`,
  );

/** Zod の失敗を最初の項目のメッセージで 400 にする */
function invalidInput(error: z.ZodError): EventServiceError {
  return new EventServiceError("invalid_input", error.issues[0]?.message ?? "入力内容を確認してください");
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw invalidInput(result.error);
  return result.data;
}

export function phaseOf(event: Pick<EventRow, "startAt" | "endAt">, now: number): EventPhase {
  const state = getEventState(event, now);
  if (state === "ended") return "ended";
  if (state === "now_happening") return "ongoing";
  return "before";
}

// ---------------------------------------------------------------- 一覧

const optionalSeconds = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.coerce.number().int("期間の指定が正しくありません").nonnegative("期間の指定が正しくありません").optional(),
);

export const eventListQuerySchema = z
  .object({
    /** この時刻以降に終わるもの（UNIX 秒） */
    from: optionalSeconds,
    /** この時刻までに始まるもの（UNIX 秒） */
    to: optionalSeconds,
    phase: z.enum(["before", "ongoing", "ended"], "状態の指定が正しくありません").optional(),
    status: z.enum(["published", "draft"], "公開状態の指定が正しくありません").optional(),
    q: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(100, "検索語は100文字以内で入力してください").optional(),
    ),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: "期間の終わりは始まりより後にしてください",
  });

export type EventListQuery = z.input<typeof eventListQuerySchema>;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 開始が早い順、次に作成が早い順 */
/** query は検証前の値（URL の検索パラメータの文字列もそのまま渡せる） */
export async function listEvents(db: Db, query: EventListQuery | Record<string, string> = {}, now = nowSeconds()): Promise<EventListItem[]> {
  const q = parse(eventListQuerySchema, query);
  const conditions: SQL[] = [];

  if (q.status) conditions.push(eq(events.status, q.status));
  if (q.to !== undefined) conditions.push(lte(events.startAt, q.to));
  if (q.from !== undefined) {
    // 終了なしはその日の終わりまで。ここでは粗く絞り、正確な判定は下で effectiveEndAt で行う
    conditions.push(or(gte(events.endAt, q.from), and(isNull(events.endAt), gte(events.startAt, q.from - SECONDS_PER_DAY)))!);
  }
  if (q.q) {
    const pattern = `%${escapeLike(q.q)}%`;
    const like = (column: AnySQLiteColumn) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
    conditions.push(or(like(events.title), like(events.description), like(events.location), like(events.hostName))!);
  }

  const rows = await db
    .select()
    .from(events)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(events.startAt), asc(events.createdAt), asc(events.id));

  return rows
    .filter((row) => q.from === undefined || effectiveEndAt(row) >= q.from)
    .map((row) => ({ ...row, phase: phaseOf(row, now) }))
    .filter((row) => q.phase === undefined || row.phase === q.phase);
}

// ---------------------------------------------------------------- 取得・作成・更新・削除

export async function getEvent(db: Db, id: string): Promise<EventRow> {
  const [row] = await db.select().from(events).where(eq(events.id, id));
  if (!row) throw notFound();
  return row;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 終わっていないイベント（下書きを含む）の数。終了なしは開始日の終わりまで。exceptId は数えない */
export async function countActiveEvents(db: Db | Tx, now = nowSeconds(), exceptId?: string): Promise<number> {
  // ここでは粗く絞り、正確な判定は effectiveEndAt で行う（listEvents と同じ）
  const rows = await db
    .select({ id: events.id, startAt: events.startAt, endAt: events.endAt })
    .from(events)
    .where(or(gte(events.endAt, now), and(isNull(events.endAt), gte(events.startAt, now - SECONDS_PER_DAY)))!);
  return rows.filter((row) => row.id !== exceptId && effectiveEndAt(row) >= now).length;
}

async function assertReferences(tx: Tx, input: EventInput): Promise<void> {
  if (input.imageMediaId !== null) {
    const [image] = await tx
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.id, input.imageMediaId), eq(media.type, "image"), eq(media.state, "active")));
    if (!image) {
      throw new EventServiceError("invalid_image", "選んだ画像は使えません。別の画像を選んでください");
    }
  }
  if (input.categoryId !== null) {
    const [category] = await tx
      .select({ id: eventCategories.id })
      .from(eventCategories)
      .where(eq(eventCategories.id, input.categoryId));
    if (!category) {
      throw new EventServiceError("invalid_category", "選んだカテゴリが見つかりません。選び直してください");
    }
  }
}

/** 定員ありでないときの定員は保存しない */
function toColumns(input: EventInput) {
  return { ...input, capacity: input.participation === "limited" ? input.capacity : null };
}

export async function createEvent(db: Db, input: unknown, now = nowSeconds()): Promise<EventRow> {
  const data = parse(eventInputSchema, input);
  return db.transaction(async (tx) => {
    await assertReferences(tx, data);
    if (effectiveEndAt(data) >= now && (await countActiveEvents(tx, now)) >= MAX_ACTIVE_EVENTS) {
      throw limitReached("新しく登録する");
    }
    const [row] = await tx.insert(events).values(toColumns(data)).returning();
    return row;
  });
}

/** revision が一致したときだけ更新し、revision を 1 増やす。不一致は 409、無ければ 404 */
export async function updateEvent(db: Db, id: string, input: unknown, now = nowSeconds()): Promise<EventRow> {
  const { revision, ...data } = parse(eventUpdateSchema, input);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ revision: events.revision, startAt: events.startAt, endAt: events.endAt })
      .from(events)
      .where(eq(events.id, id));
    if (!current) throw notFound();
    if (current.revision !== revision) {
      throw new EventServiceError("conflict", "他の人が先に更新しました");
    }
    await assertReferences(tx, data);
    // 終わったイベントを先の日時に直して数に戻すときだけ上限を見る（今あるイベントの手直しは止めない）
    const revives = effectiveEndAt(current) < now && effectiveEndAt(data) >= now;
    if (revives && (await countActiveEvents(tx, now, id)) >= MAX_ACTIVE_EVENTS) {
      throw limitReached("このイベントを先の日時にする");
    }
    const [row] = await tx
      .update(events)
      .set({ ...toColumns(data), revision: revision + 1, updatedAt: nowSeconds() })
      .where(and(eq(events.id, id), eq(events.revision, revision)))
      .returning();
    if (!row) throw new EventServiceError("conflict", "他の人が先に更新しました");
    return row;
  });
}

export async function deleteEvent(db: Db, id: string): Promise<void> {
  const deleted = await db.delete(events).where(eq(events.id, id)).returning({ id: events.id });
  if (deleted.length === 0) throw notFound();
}

/**
 * 終わってから ENDED_EVENT_RETENTION_SECONDS を過ぎたイベントを消す（下書きも）。毎日の Cron から呼ぶ。消した id を返す。
 * 画像の media は消さない（動画・メディアの画面に残る）
 */
export async function purgeEndedEvents(db: Db, now = nowSeconds()): Promise<string[]> {
  const cutoff = now - ENDED_EVENT_RETENTION_SECONDS;
  // ここでは粗く絞り、正確な判定は effectiveEndAt で行う（終了なしは開始日の終わりまで）
  const rows = await db
    .select({ id: events.id, startAt: events.startAt, endAt: events.endAt })
    .from(events)
    .where(or(lt(events.endAt, cutoff), and(isNull(events.endAt), lt(events.startAt, cutoff)))!);
  const ids = rows.filter((row) => effectiveEndAt(row) < cutoff).map((row) => row.id);
  if (ids.length > 0) await db.delete(events).where(inArray(events.id, ids));
  return ids;
}

// ---------------------------------------------------------------- Route Handler 用

/** EventServiceError を { error: { code, message } } の応答にする。それ以外は投げ直す */
export function eventErrorResponse(error: unknown): Response {
  if (error instanceof EventServiceError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  throw error;
}

/** 本文を JSON として読む。壊れていれば 400 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EventServiceError("invalid_input", "入力内容を確認してください");
  }
}
