/**
 * 表示スケジュール（display_schedules）のサービス。
 *
 * - 権限は Administrator（計画 6 節の権限表）。
 * - 曜日ごとに枠は1つ。行がない曜日は終日表示（計画 6 節・8.1 節）。
 * - 時間帯は日をまたいでよい（start > end は翌日の end まで。lib/dates.ts の isMinuteInRange）。
 * - start === end は不可。重複した曜日も不可。どちらも lib/validators.ts の displayScheduleSchema が検証する。
 * - revision は持たない（曜日を主キーに全件を置き換える）。
 */
import { asc } from "drizzle-orm";
import type { Db } from "../../db/index";
import { displaySchedules } from "../../db/schema";
import type { AuthUser } from "../auth";
import { displayScheduleSchema, type DisplayScheduleInput } from "../validators";
import { assertRole, parseInput } from "./notices";

export type DisplayScheduleRow = typeof displaySchedules.$inferSelect;

export async function getDisplaySchedule(db: Db): Promise<DisplayScheduleRow[]> {
  return db.select().from(displaySchedules).orderBy(asc(displaySchedules.weekday));
}

/** 送られた曜日の分だけ全件を置き換える。含まれない曜日は行がなくなり、終日表示に戻る */
export async function replaceDisplaySchedule(db: Db, user: AuthUser, input: unknown): Promise<DisplayScheduleRow[]> {
  assertRole(user, "administrator");
  const data: DisplayScheduleInput = parseInput(displayScheduleSchema, input);

  return db.transaction(async (tx) => {
    await tx.delete(displaySchedules);
    if (data.entries.length > 0) {
      await tx.insert(displaySchedules).values(
        data.entries.map((entry) => ({
          weekday: entry.weekday,
          startTime: entry.startTime,
          endTime: entry.endTime,
          enabled: entry.enabled,
        })),
      );
    }
    return tx.select().from(displaySchedules).orderBy(asc(displaySchedules.weekday));
  });
}
