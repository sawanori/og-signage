/**
 * 端末ごとの config（GET /api/device/config）を組み立てる（計画 6 節の前提 11、9 節「端末用」）。
 *
 * - すべての読み取りを 1 つの読み取りトランザクション（libSQL の "read"）で行う。
 *   組み立て中に管理画面から更新が入っても、応答は更新前か更新後のどちらか一方の世代になる。
 * - version は version 自体を除いた config をキー順固定の JSON にしたものの SHA-256。
 *   内容が同じなら同じ、変われば変わる。手動で版を上げる処理は持たない。
 * - 時刻による絞り込み（今日のイベント・お知らせの時間帯・表示スケジュール）は表示側（lib/display-rules.ts）。
 *   ここで絞るのは、イベントの公開状態と期間（前日〜30 日後）、お知らせの enabled、再生できる動画だけ。
 * - 返す前に signageConfigSchema で検査する。通らなければ例外（壊れた config は配らない）。
 */
import type { Client } from "@libsql/client";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { Db } from "../db/index";
import {
  devices,
  displayBundles,
  displaySchedules,
  eventCategories,
  events,
  houseRules,
  houseSettings,
  media,
  notices,
  playlistItems,
  videoPlaybackSettings,
  weatherCache,
} from "../db/schema";
import * as schema from "../db/schema";
import { z } from "zod";
import {
  SCHEMA_VERSION,
  dailyForecastSchema,
  signageConfigSchema,
  type DailyForecast,
  type MediaRef,
  type SignageConfig,
  type VideoIntervalMinutes,
} from "./config-schema";
import { SECONDS_PER_DAY, startOfTokyoDay, endOfTokyoDay } from "./dates";
import { effectiveEndAt } from "./display-rules";
import { eventDetailUrl } from "./event-links";

/** イベントを載せる期間。前日の 0:00 から 30 日後の 23:59:59 まで（日本時間） */
export const EVENT_WINDOW_PAST_DAYS = 1;
export const EVENT_WINDOW_FUTURE_DAYS = 30;

/** config を組み立てられない状態（現行の表示バンドルやデザイン設定がない、端末が消えた）。503 で返す */
export class ConfigUnavailableError extends Error {
  constructor(readonly code: "device_not_found" | "no_display_bundle" | "no_house_settings" | "no_video_settings") {
    super(code);
    this.name = "ConfigUnavailableError";
  }
}

/** キー順を固定した JSON（配列の順は保つ）。version の計算に使う */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** version を除いた config から version を計算する */
export async function computeConfigVersion(body: Omit<SignageConfig, "version">): Promise<string> {
  return sha256Hex(canonicalJson(body));
}

type MediaColumns = { id: string | null; sha256: string | null; fileSize: number | null };

function toMediaRef(row: MediaColumns | null): MediaRef | null {
  if (!row || row.id === null || row.sha256 === null || row.fileSize === null) return null;
  return { mediaId: row.id, sha256: row.sha256, size: row.fileSize };
}

const mediaColumns = { id: media.id, sha256: media.sha256, fileSize: media.fileSize };

/** 読み取りトランザクション内で config の中身（version 以外）を読む */
async function readConfigBody(tx: Db, deviceId: string, now: number): Promise<Omit<SignageConfig, "version">> {
  const [device] = await tx.select().from(devices).where(eq(devices.id, deviceId));
  if (!device) throw new ConfigUnavailableError("device_not_found");

  const [bundle] = await tx
    .select({ id: displayBundles.id, sha256: displayBundles.sha256, size: displayBundles.size })
    .from(displayBundles)
    .where(eq(displayBundles.isCurrent, true));
  if (!bundle) throw new ConfigUnavailableError("no_display_bundle");

  const [house] = await tx.select().from(houseSettings).orderBy(asc(houseSettings.id)).limit(1);
  if (!house) throw new ConfigUnavailableError("no_house_settings");

  const [settings] = await tx.select().from(videoPlaybackSettings).where(eq(videoPlaybackSettings.deviceId, deviceId));
  if (!settings) throw new ConfigUnavailableError("no_video_settings");

  // ---- イベント（公開のみ・前日〜30 日後）
  const from = startOfTokyoDay(now) - EVENT_WINDOW_PAST_DAYS * SECONDS_PER_DAY;
  const to = endOfTokyoDay(now + EVENT_WINDOW_FUTURE_DAYS * SECONDS_PER_DAY);
  const eventRows = await tx
    .select({ event: events, category: eventCategories, image: mediaColumns })
    .from(events)
    .leftJoin(eventCategories, eq(events.categoryId, eventCategories.id))
    .leftJoin(media, eq(events.imageMediaId, media.id))
    .where(
      and(
        eq(events.status, "published"),
        lte(events.startAt, to),
        // 終了なしは開始日の終わりまで。粗く絞り、正確な判定は下の effectiveEndAt で行う
        or(gte(events.endAt, from), and(isNull(events.endAt), gte(events.startAt, from - SECONDS_PER_DAY))),
      ),
    )
    .orderBy(asc(events.startAt), asc(events.createdAt), asc(events.id));

  // ---- お知らせ（enabled のもの。時間帯の絞り込みは表示側）
  const noticeRows = await tx
    .select({ notice: notices, image: mediaColumns })
    .from(notices)
    .leftJoin(media, eq(notices.imageMediaId, media.id))
    .where(eq(notices.enabled, true))
    .orderBy(desc(notices.updatedAt), asc(notices.id));

  const logo = house.logoMediaId
    ? (await tx.select(mediaColumns).from(media).where(eq(media.id, house.logoMediaId)))[0] ?? null
    : null;
  const footerImage = house.footerImageMediaId
    ? (await tx.select(mediaColumns).from(media).where(eq(media.id, house.footerImageMediaId)))[0] ?? null
    : null;
  const rules = await tx.select().from(houseRules).orderBy(asc(houseRules.position), asc(houseRules.id));
  const scheduleRows = await tx.select().from(displaySchedules).orderBy(asc(displaySchedules.weekday));
  const [weather] = await tx.select().from(weatherCache).orderBy(desc(weatherCache.fetchedAt)).limit(1);
  const forecast = weather ? parseForecast(weather.forecast) : undefined;

  // ---- プレイリスト（再生できる active な動画だけ）
  const playlistRows = settings.playlistId
    ? await tx
        .select({ id: media.id, sha256: media.sha256, fileSize: media.fileSize, durationSeconds: media.durationSeconds })
        .from(playlistItems)
        .innerJoin(media, eq(playlistItems.mediaId, media.id))
        .where(
          and(
            eq(playlistItems.playlistId, settings.playlistId),
            eq(media.type, "video"),
            eq(media.playable, true),
            eq(media.state, "active"),
            isNotNull(media.durationSeconds),
          ),
        )
        .orderBy(asc(playlistItems.position), asc(playlistItems.id))
    : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    events: eventRows
      .filter(({ event }) => effectiveEndAt(event) >= from)
      .map(({ event, category, image }) => ({
        id: event.id,
        status: event.status,
        title: event.title,
        description: event.description,
        location: event.location,
        startAt: event.startAt,
        endAt: event.endAt,
        category: category ? { id: category.id, name: category.name, color: category.color } : null,
        emoji: event.emoji,
        hostName: event.hostName,
        catchCopy: event.catchCopy,
        participation: event.participation,
        capacity: event.capacity,
        participantCount: event.participantCount,
        qrUrl: event.qrUrl,
        image: toMediaRef(image),
        createdAt: event.createdAt,
      })),
    notices: noticeRows.map(({ notice, image }) => ({
      id: notice.id,
      title: notice.title,
      body: notice.body,
      image: toMediaRef(image),
      qrUrl: notice.qrUrl,
      enabled: notice.enabled,
      displayMode: notice.displayMode,
      displayStartTime: notice.displayStartTime,
      displayEndTime: notice.displayEndTime,
      updatedAt: notice.updatedAt,
    })),
    house: {
      name: house.houseName,
      headerCopy: house.headerCopy,
      footerCopy: house.footerCopy,
      footerQrUrl: house.footerQrUrl,
      logo: toMediaRef(logo),
      footerImage: toMediaRef(footerImage),
      rules: rules.map((r) => ({ icon: r.icon, title: r.title, text: r.text })),
    },
    schedule: scheduleRows.map((s) => ({
      weekday: s.weekday as SignageConfig["schedule"][number]["weekday"],
      startTime: s.startTime,
      endTime: s.endTime,
      enabled: s.enabled,
    })),
    weather: weather
      ? {
          locationName: weather.locationName,
          temperatureC: weather.temperatureC,
          condition: weather.condition,
          fetchedAt: weather.fetchedAt,
          ...(forecast ? { forecast } : {}),
        }
      : null,
    video: {
      enabled: settings.enabled,
      intervalMinutes: settings.intervalMinutes as VideoIntervalMinutes,
      mode: settings.playbackMode,
    },
    playlist: playlistRows.flatMap((row) => {
      const ref = toMediaRef(row);
      return ref && row.durationSeconds !== null ? [{ ...ref, durationSeconds: row.durationSeconds }] : [];
    }),
    displayBundle: bundle,
    device: {
      orientation: device.orientation,
      width: device.resolutionWidth,
      height: device.resolutionHeight,
      volume: device.volume,
    },
    commands: { testPlayRequestedAt: device.testPlayRequestedAt, testPlayMediaId: device.testPlayMediaId },
  };
}

/**
 * 端末の config を組み立てる。読み取りは 1 つの読み取りトランザクション内。
 * 返り値は signageConfigSchema の検査済み。
 * siteUrl を渡すと、QR の飛び先が未登録のイベントにイベント詳細ページの URL を入れる
 * （すべてのスライドに QR を出すため。2026-09-25 ユーザー指示）。
 */
export async function buildDeviceConfig(
  db: Db,
  deviceId: string,
  now: number,
  siteUrl: string | null = null,
): Promise<SignageConfig> {
  const client = db.$client;
  const readTx = await client.transaction("read");
  let body: Omit<SignageConfig, "version">;
  try {
    // libSQL の Transaction は execute/batch を持つので、drizzle をその上に載せて同じ書き方で読む
    body = await readConfigBody(drizzle(readTx as unknown as Client, { schema }), deviceId, now);
    await readTx.commit();
  } finally {
    readTx.close();
  }
  if (siteUrl) {
    body = {
      ...body,
      events: body.events.map((event) => (event.qrUrl ? event : { ...event, qrUrl: eventDetailUrl(siteUrl, event.id) })),
    };
  }
  const version = await computeConfigVersion(body);
  return signageConfigSchema.parse({ ...body, version });
}

/** `If-None-Match` が version と一致するか（引用符・W/・複数指定・* を扱う） */
export function matchesIfNoneMatch(header: string | null, version: string): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const tag = raw.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
    return tag === "*" || tag === version;
  });
}

/** weather_cache.forecast（JSON）を読む。無い・読めない・形が違うときは undefined（予報を出さない） */
function parseForecast(raw: string | null): DailyForecast[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = z.array(dailyForecastSchema).safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
