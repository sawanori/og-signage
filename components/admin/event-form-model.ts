/**
 * イベントのフォームの値と検証。
 *
 * 画面の入力（日付・時刻・数値は文字列）を API の形（UNIX 秒・数値・null）に直し、
 * lib/validators.ts の eventInputSchema で検証する。エラーは画面の項目名に付け替える。
 */
import type { FieldErrors, Resolver } from "react-hook-form";
import { isHHMM, tokyoDateKey, tokyoDateTime, tokyoParts } from "@/lib/dates";
import { eventInputSchema, type EventInput } from "@/lib/validators";

export type EventFormValues = {
  title: string;
  /** YYYY-MM-DD（日本時間） */
  startDate: string;
  /** HH:MM */
  startTime: string;
  /** 空なら開始日と同じ日 */
  endDate: string;
  /** 空なら終了なし（その日の終わりまで表示） */
  endTime: string;
  location: string;
  description: string;
  categoryId: string;
  emoji: string;
  hostName: string;
  catchCopy: string;
  participation: "free" | "limited";
  capacity: string;
  participantCount: string;
  qrUrl: string;
  imageMediaId: string;
  status: "published" | "draft";
};

/** 編集時に読み込むイベント（lib/services/events.ts の EventRow の一部） */
export type EventFormSource = {
  title: string;
  description: string | null;
  location: string | null;
  startAt: number;
  endAt: number | null;
  categoryId: string | null;
  emoji: string | null;
  hostName: string | null;
  catchCopy: string | null;
  participation: "free" | "limited";
  capacity: number | null;
  participantCount: number | null;
  qrUrl: string | null;
  imageMediaId: string | null;
  status: "published" | "draft";
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const hm = (unix: number) => {
  const p = tokyoParts(unix);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
};

export function emptyFormValues(now: number): EventFormValues {
  return {
    title: "",
    startDate: tokyoDateKey(now),
    startTime: "",
    endDate: "",
    endTime: "",
    location: "",
    description: "",
    categoryId: "",
    emoji: "",
    hostName: "",
    catchCopy: "",
    participation: "free",
    capacity: "",
    participantCount: "",
    qrUrl: "",
    imageMediaId: "",
    status: "published",
  };
}

export function toFormValues(e: EventFormSource): EventFormValues {
  const startDate = tokyoDateKey(e.startAt);
  const endDate = e.endAt === null ? "" : tokyoDateKey(e.endAt);
  return {
    title: e.title,
    startDate,
    startTime: hm(e.startAt),
    endDate: endDate === startDate ? "" : endDate,
    endTime: e.endAt === null ? "" : hm(e.endAt),
    location: e.location ?? "",
    description: e.description ?? "",
    categoryId: e.categoryId ?? "",
    emoji: e.emoji ?? "",
    hostName: e.hostName ?? "",
    catchCopy: e.catchCopy ?? "",
    participation: e.participation,
    capacity: e.capacity === null ? "" : String(e.capacity),
    participantCount: e.participantCount === null ? "" : String(e.participantCount),
    qrUrl: e.qrUrl ?? "",
    imageMediaId: e.imageMediaId ?? "",
    status: e.status,
  };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 日本時間の日付と時刻から UNIX 秒。存在しない日付は null */
export function parseDateTime(date: string, time: string): number | null {
  const m = DATE.exec(date);
  if (!m || !isHHMM(time)) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hour, minute] = time.split(":").map(Number);
  const unix = tokyoDateTime(year, month, day, hour, minute);
  const p = tokyoParts(unix);
  return p.year === year && p.month === month && p.day === day ? unix : null;
}

type FieldName = keyof EventFormValues;

/** API の項目名 → 画面の項目名 */
const FIELD_OF_PATH: Partial<Record<string, FieldName>> = {
  startAt: "startDate",
  endAt: "endTime",
};

export const eventFormResolver: Resolver<EventFormValues, unknown, EventInput> = async (values) => {
  const errors: Partial<Record<FieldName, { type: string; message: string }>> = {};
  const add = (name: FieldName, message: string) => {
    errors[name] ??= { type: "validate", message };
  };

  let startAt: number | null = null;
  if (values.startDate.trim() === "" || values.startTime.trim() === "") {
    add("startDate", "開始日時を入力してください");
  } else {
    startAt = parseDateTime(values.startDate, values.startTime);
    if (startAt === null) add("startDate", "開始日時が正しくありません");
  }

  let endAt: number | null = null;
  if (values.endTime.trim() !== "") {
    endAt = parseDateTime(values.endDate.trim() || values.startDate, values.endTime);
    if (endAt === null) add("endTime", "終了日時が正しくありません");
  } else if (values.endDate.trim() !== "") {
    add("endTime", "終了の時刻を入力してください");
  }

  const count = (name: "capacity" | "participantCount", label: string): number | null => {
    const v = values[name].trim();
    if (v === "") return null;
    if (!/^\d+$/.test(v)) {
      add(name, `${label}は数字で入力してください`);
      return null;
    }
    return Number(v);
  };

  const input = {
    title: values.title,
    description: values.description,
    location: values.location,
    // 開始が未入力・不正のときも他の項目は検証する（開始のエラーは上で付け済み）
    startAt: startAt ?? 0,
    endAt: startAt === null ? null : endAt,
    categoryId: values.categoryId,
    emoji: values.emoji,
    hostName: values.hostName,
    catchCopy: values.catchCopy,
    participation: values.participation,
    capacity: values.participation === "limited" ? count("capacity", "定員") : null,
    participantCount: count("participantCount", "参加人数"),
    qrUrl: values.qrUrl,
    imageMediaId: values.imageMediaId,
    status: values.status,
  };

  const result = eventInputSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "");
      const name = FIELD_OF_PATH[key] ?? (key in values ? (key as FieldName) : "title");
      add(name, issue.message);
    }
  }

  if (Object.keys(errors).length > 0 || !result.success) {
    return { values: {}, errors: errors as FieldErrors<EventFormValues> };
  }
  return { values: result.data, errors: {} };
};
