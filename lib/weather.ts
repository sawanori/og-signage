/**
 * 天気の取得と保存（task_013。30 分ごとに Cron から呼ぶ。worker/scheduled.ts）。
 *
 * - house_settings の緯度経度（両方あれば優先）、なければ地域名（weatherLocationName）で
 *   OpenWeatherMap の Current Weather API（`/data/2.5/weather`）に問い合わせる（計画 6 節 前提 4）。
 * - condition は OpenWeatherMap の `weather[0].main` を小文字化したもの。
 *   components/signage/parts.tsx の WEATHER_ICONS・db/schema.ts の weather_cache のコメントに合わせる
 *   （lib/config-schema.ts の weatherSchema.condition は z.string() で特定の語彙を強制しないため、
 *   すでに実装済みの表示側の語彙に合わせるのが正しい）。
 * - 失敗（キー未設定・地域未設定・HTTP エラー・応答不正・通信エラー）は weather_cache を変更せず、
 *   ログだけ出す（前回値を保持）。
 * - API キーはどんな場合もログに出さない。
 * - 現在の天気が取れたら、同じ地域の 5 日・3 時間ごとの予報（`/data/2.5/forecast`。無料プランで使える）も取り、
 *   明日から 3 日分を日ごとにまとめて weather_cache.forecast に保存する（フッターの天気の横に明日・明後日を出すため。
 *   2026-09-25 ユーザー指示）。予報だけ取れなかったときは、今の天気は保存し、予報は前回の値のまま。
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { houseSettings, weatherCache } from "../db/schema";
import { tokyoDateKey, tokyoParts } from "./dates";

export type FetchLike = typeof fetch;

export const OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather";
export const OPENWEATHER_FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";

/** 日ごとの予報（日本時間）。condition は現在の天気と同じ語彙（weather[0].main の小文字） */
export type DailyForecast = { date: string; condition: string; maxC: number; minC: number; pop: number | null };

/** 何日分を持つか。日付が変わってから次の取得（30 分ごと）までのあいだも明日・明後日を出せるよう 3 日分 */
const FORECAST_DAYS = 3;

type ForecastEntry = {
  dt?: number;
  main?: { temp_max?: number; temp_min?: number };
  weather?: { main?: string }[];
  pop?: number;
};

/**
 * 3 時間ごとの予報を日本時間の日ごとにまとめる。今日は含めず、明日から FORECAST_DAYS 日分。
 * 最高・最低はその日の値の最大・最小、天気は正午に近い時刻のもの、降水確率はその日の最大。
 */
export function summarizeForecast(list: readonly ForecastEntry[], now: number): DailyForecast[] {
  const today = tokyoDateKey(now);
  const days = new Map<string, { dt: number; max: number; min: number; condition: string; pop: number | null }[]>();
  for (const e of list) {
    const max = e.main?.temp_max;
    const min = e.main?.temp_min;
    const condition = e.weather?.[0]?.main;
    if (typeof e.dt !== "number" || typeof max !== "number" || typeof min !== "number" || !condition) continue;
    const date = tokyoDateKey(e.dt);
    if (date <= today) continue;
    const entries = days.get(date) ?? [];
    entries.push({ dt: e.dt, max, min, condition: condition.toLowerCase(), pop: typeof e.pop === "number" ? e.pop : null });
    days.set(date, entries);
  }
  return [...days.keys()]
    .sort()
    .slice(0, FORECAST_DAYS)
    .map((date) => {
      const entries = days.get(date)!;
      const noon = entries.reduce((best, e) =>
        Math.abs(tokyoParts(e.dt).hour - 12) < Math.abs(tokyoParts(best.dt).hour - 12) ? e : best,
      );
      const pops = entries.flatMap((e) => (e.pop === null ? [] : [e.pop]));
      return {
        date,
        condition: noon.condition,
        maxC: Math.max(...entries.map((e) => e.max)),
        minC: Math.min(...entries.map((e) => e.min)),
        pop: pops.length > 0 ? Math.max(...pops) : null,
      };
    });
}

/** 予報を取ってまとめる。取れない・形が違うときは null（前回の値のまま） */
async function fetchForecast(query: URLSearchParams, fetchImpl: FetchLike): Promise<DailyForecast[] | null> {
  try {
    const response = await fetchImpl(`${OPENWEATHER_FORECAST_URL}?${query.toString()}`);
    const body = (await response.json()) as { list?: ForecastEntry[]; message?: string };
    if (!response.ok || !Array.isArray(body.list)) {
      console.warn(`[weather] 予報を取得できませんでした（status=${response.status}）。予報は前回値を保持します`, body.message ?? "");
      return null;
    }
    const days = summarizeForecast(body.list, Math.floor(Date.now() / 1000));
    return days.length > 0 ? days : null;
  } catch (e) {
    console.warn("[weather] 予報の取得で通信エラーがありました。予報は前回値を保持します", e);
    return null;
  }
}

type OpenWeatherResponse = {
  name?: string;
  weather?: { main?: string }[];
  main?: { temp?: number };
  message?: string;
};

type LocationSettings = {
  weatherLatitude: number | null;
  weatherLongitude: number | null;
  weatherLocationName: string | null;
};

/** 緯度経度があれば優先、なければ地域名。どちらも無ければ null（問い合わせない） */
function buildQuery(settings: LocationSettings, apiKey: string): URLSearchParams | null {
  const params = new URLSearchParams({ units: "metric", lang: "ja", appid: apiKey });
  if (settings.weatherLatitude !== null && settings.weatherLongitude !== null) {
    params.set("lat", String(settings.weatherLatitude));
    params.set("lon", String(settings.weatherLongitude));
    return params;
  }
  if (settings.weatherLocationName !== null && settings.weatherLocationName !== "") {
    params.set("q", settings.weatherLocationName);
    return params;
  }
  return null;
}

async function saveWeather(
  db: Db,
  value: { locationName: string; temperatureC: number; condition: string; fetchedAt: number; forecast?: string },
): Promise<void> {
  const [existing] = await db.select({ id: weatherCache.id }).from(weatherCache).limit(1);
  if (existing) {
    await db.update(weatherCache).set(value).where(eq(weatherCache.id, existing.id));
  } else {
    await db.insert(weatherCache).values(value);
  }
}

/**
 * 天気を取得して weather_cache に保存する。失敗時は何もせず（前回値を保持し）、ログだけ出す。
 * `apiKey` は Workers の Secret（`OPENWEATHER_API_KEY`）を呼び出し側から渡す。
 */
export async function refreshWeather(db: Db, apiKey: string | undefined, fetchImpl: FetchLike = fetch): Promise<void> {
  if (!apiKey) {
    console.warn("[weather] OPENWEATHER_API_KEY が設定されていません。前回値を保持します");
    return;
  }

  const [settings] = await db.select().from(houseSettings).limit(1);
  if (!settings) {
    console.warn("[weather] house_settings が初期化されていません。前回値を保持します");
    return;
  }

  const query = buildQuery(settings, apiKey);
  if (!query) {
    console.warn("[weather] 天気の地域が設定されていません。前回値を保持します");
    return;
  }

  let response: Response;
  try {
    response = await fetchImpl(`${OPENWEATHER_URL}?${query.toString()}`);
  } catch (e) {
    console.warn("[weather] 通信エラーのため取得できませんでした。前回値を保持します", e);
    return;
  }

  let body: OpenWeatherResponse;
  try {
    body = (await response.json()) as OpenWeatherResponse;
  } catch (e) {
    console.warn(`[weather] 応答の解析に失敗しました（status=${response.status}）。前回値を保持します`, e);
    return;
  }

  if (!response.ok) {
    console.warn(`[weather] 取得に失敗しました（status=${response.status}）。前回値を保持します`, body.message ?? "");
    return;
  }

  const main = body.weather?.[0]?.main;
  const temperatureC = body.main?.temp;
  if (!main || typeof temperatureC !== "number") {
    console.warn("[weather] 応答の形式が正しくありません。前回値を保持します");
    return;
  }

  const forecast = await fetchForecast(query, fetchImpl);
  await saveWeather(db, {
    locationName: settings.weatherLocationName ?? body.name ?? "",
    temperatureC,
    condition: main.toLowerCase(),
    fetchedAt: Math.floor(Date.now() / 1000),
    ...(forecast ? { forecast: JSON.stringify(forecast) } : {}),
  });
}
