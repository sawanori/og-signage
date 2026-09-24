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
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { houseSettings, weatherCache } from "../db/schema";

export type FetchLike = typeof fetch;

export const OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather";

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
  value: { locationName: string; temperatureC: number; condition: string; fetchedAt: number },
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

  await saveWeather(db, {
    locationName: settings.weatherLocationName ?? body.name ?? "",
    temperatureC,
    condition: main.toLowerCase(),
    fetchedAt: Math.floor(Date.now() / 1000),
  });
}
