/**
 * lib/weather.ts（task_013）。DB は一時 libSQL ファイル、fetch はテストで差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { houseSettings, weatherCache } from "../../db/schema";
import { tokyoDateTime } from "../../lib/dates";
import { OPENWEATHER_FORECAST_URL, OPENWEATHER_URL, refreshWeather, summarizeForecast, type FetchLike } from "../../lib/weather";
import { openTempDb } from "../helpers/temp-db";

const FAKE_API_KEY = "sk_test_1234567890abcdef";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 予報（/data/2.5/forecast）の 3 時間ごとの 1 件。at は日本時間 */
function slot(at: [number, number, number, number], max: number, min: number, main: string, pop?: number) {
  return { dt: tokyoDateTime(at[0], at[1], at[2], at[3], 0), main: { temp_max: max, temp_min: min }, weather: [{ main }], ...(pop === undefined ? {} : { pop }) };
}

/** 呼び先（現在の天気・予報）で応答を分ける fetch */
function routedFetch(weather: () => Response, forecast: () => Response, calls: string[] = []): FetchLike {
  return vi.fn(async (input) => {
    calls.push(String(input));
    return new URL(String(input)).pathname.endsWith("/forecast") ? forecast() : weather();
  });
}

async function insertHouseSettings(db: Db, overrides: Partial<typeof houseSettings.$inferInsert> = {}) {
  await db.insert(houseSettings).values({ houseName: "テストハウス", ...overrides });
}

async function readWeatherCache(db: Db) {
  const rows = await db.select().from(weatherCache);
  return rows[0] ?? null;
}

let db: Db;
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
});

afterEach(() => {
  close();
  vi.restoreAllMocks();
});

describe("refreshWeather", () => {
  it("緯度経度があれば優先して問い合わせ、condition を OpenWeatherMap の weather[0].main の小文字に変換して保存する", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });

    const calls: string[] = [];
    const tomorrow = new Date(Date.now() + 86_400_000);
    const at = (hour: number): [number, number, number, number] => [
      Number(tomorrow.toLocaleString("en-US", { timeZone: "Asia/Tokyo", year: "numeric" })),
      Number(tomorrow.toLocaleString("en-US", { timeZone: "Asia/Tokyo", month: "numeric" })),
      Number(tomorrow.toLocaleString("en-US", { timeZone: "Asia/Tokyo", day: "numeric" })),
      hour,
    ];
    const fetchImpl = routedFetch(
      () => jsonResponse(200, { name: "Yokohama", weather: [{ main: "Clouds" }], main: { temp: 21.5 } }),
      () => jsonResponse(200, { list: [slot(at(9), 22, 18, "Rain", 0.6), slot(at(12), 25, 19, "Clouds", 0.3)] }),
      calls,
    );

    const before = Math.floor(Date.now() / 1000);
    await refreshWeather(db, FAKE_API_KEY, fetchImpl);

    // 現在の天気と予報を、同じ地域・単位・言語で問い合わせる
    expect(calls).toHaveLength(2);
    for (const [call, endpoint] of [
      [calls[0], OPENWEATHER_URL],
      [calls[1], OPENWEATHER_FORECAST_URL],
    ]) {
      const url = new URL(call);
      expect(url.origin + url.pathname).toBe(endpoint);
      expect(url.searchParams.get("lat")).toBe("35.4437");
      expect(url.searchParams.get("lon")).toBe("139.638");
      expect(url.searchParams.get("q")).toBeNull();
      expect(url.searchParams.get("units")).toBe("metric");
      expect(url.searchParams.get("lang")).toBe("ja");
      expect(url.searchParams.get("appid")).toBe(FAKE_API_KEY);
    }

    const row = await readWeatherCache(db);
    expect(row).not.toBeNull();
    expect(row!.condition).toBe("clouds");
    expect(row!.temperatureC).toBe(21.5);
    // 表示用の地域名は house_settings の値を使う（API の name はフォールバックのみ）
    expect(row!.locationName).toBe("横浜市");
    expect(row!.fetchedAt).toBeGreaterThanOrEqual(before);
    const [year, month, day] = at(0);
    expect(JSON.parse(row!.forecast!)).toEqual([
      { date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, condition: "clouds", maxC: 25, minC: 18, pop: 0.6 },
    ]);
  });

  it("予報だけ取れないとき（HTTP エラー・通信エラー）は、今の天気を保存し、予報は前回の値のまま", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    const previous = JSON.stringify([{ date: "2026-09-26", condition: "clear", maxC: 28, minC: 21, pop: 0.1 }]);
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000, forecast: previous });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshWeather(
      db,
      FAKE_API_KEY,
      routedFetch(
        () => jsonResponse(200, { weather: [{ main: "Rain" }], main: { temp: 17 } }),
        () => jsonResponse(500, { message: "server error" }),
      ),
    );
    let row = await readWeatherCache(db);
    expect(row!.condition).toBe("rain");
    expect(row!.fetchedAt).toBeGreaterThan(1000);
    expect(row!.forecast).toBe(previous);

    await refreshWeather(
      db,
      FAKE_API_KEY,
      routedFetch(
        () => jsonResponse(200, { weather: [{ main: "Snow" }], main: { temp: 1 } }),
        () => {
          throw new Error("network down");
        },
      ),
    );
    row = await readWeatherCache(db);
    expect(row!.condition).toBe("snow");
    expect(row!.forecast).toBe(previous);
  });

  it("緯度経度が無ければ地域名で問い合わせる", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: null, weatherLongitude: null });

    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("q")).toBe("横浜市");
      expect(url.searchParams.get("lat")).toBeNull();
      return jsonResponse(200, { weather: [{ main: "Clear" }], main: { temp: 26 } });
    });

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    // 現在の天気と予報の 2 回
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const row = await readWeatherCache(db);
    expect(row!.condition).toBe("clear");
  });

  it("house_settings の地域名が無ければ API の name を使う", async () => {
    await insertHouseSettings(db, { weatherLocationName: null, weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { name: "Yokohama", weather: [{ main: "Rain" }], main: { temp: 18 } }));

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    const row = await readWeatherCache(db);
    expect(row!.locationName).toBe("Yokohama");
  });

  it("キーが無ければ問い合わせず前回値を保持する", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000 });

    const fetchImpl: FetchLike = vi.fn();
    await refreshWeather(db, undefined, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    const row = await readWeatherCache(db);
    expect(row).toEqual(expect.objectContaining({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000 }));
  });

  it("地域が未設定なら問い合わせず前回値を保持する", async () => {
    await insertHouseSettings(db, { weatherLocationName: null, weatherLatitude: null, weatherLongitude: null });
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000 });

    const fetchImpl: FetchLike = vi.fn();
    await refreshWeather(db, FAKE_API_KEY, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    const row = await readWeatherCache(db);
    expect(row!.fetchedAt).toBe(1000);
  });

  it("HTTP エラー（401 など）のとき前回値を保持する", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000 });

    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(401, { cod: 401, message: "Invalid API key" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);

    const row = await readWeatherCache(db);
    expect(row!.fetchedAt).toBe(1000);
    expect(row!.temperatureC).toBe(20);
    expect(warn).toHaveBeenCalled();
  });

  it("通信エラーのとき前回値を保持する", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000 });

    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    const row = await readWeatherCache(db);
    expect(row!.fetchedAt).toBe(1000);
  });

  it("応答の形式が正しくない（weather や温度が無い）とき前回値を保持する", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 20, condition: "clear", fetchedAt: 1000 });

    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { weather: [], main: {} }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    const row = await readWeatherCache(db);
    expect(row!.fetchedAt).toBe(1000);
  });

  it("weather_cache が空でも新規に1行作る", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, { weather: [{ main: "Snow" }], main: { temp: -1 } }));

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    const rows = await db.select().from(weatherCache);
    expect(rows).toHaveLength(1);
    expect(rows[0].condition).toBe("snow");
  });

  it("2回目の呼び出しでも行が増えず、同じ行が更新される", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });
    const current = [
      jsonResponse(200, { weather: [{ main: "Clear" }], main: { temp: 20 } }),
      jsonResponse(200, { weather: [{ main: "Rain" }], main: { temp: 15 } }),
    ];
    const fetchImpl = routedFetch(
      () => current.shift()!,
      () => jsonResponse(200, { list: [] }),
    );

    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    const [first] = await db.select().from(weatherCache);
    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    const rows = await db.select().from(weatherCache);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].condition).toBe("rain");
    expect(rows[0].temperatureC).toBe(15);
  });

  it("キーをログに出さない", async () => {
    await insertHouseSettings(db, { weatherLocationName: "横浜市", weatherLatitude: 35.4437, weatherLongitude: 139.638 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // 失敗系をひととおり起こしてログを集める
    const failing: FetchLike = vi.fn(async () => jsonResponse(401, { message: "Invalid API key" }));
    await refreshWeather(db, FAKE_API_KEY, failing);
    const throwing: FetchLike = vi.fn(async () => {
      throw new Error("boom");
    });
    await refreshWeather(db, FAKE_API_KEY, throwing);
    const malformed: FetchLike = vi.fn(async () => jsonResponse(200, {}));
    await refreshWeather(db, FAKE_API_KEY, malformed);
    const ok = () => jsonResponse(200, { weather: [{ main: "Clear" }], main: { temp: 20 } });
    await refreshWeather(db, FAKE_API_KEY, routedFetch(ok, () => jsonResponse(401, { message: "Invalid API key" })));
    await refreshWeather(
      db,
      FAKE_API_KEY,
      routedFetch(ok, () => {
        throw new Error("boom");
      }),
    );

    const allArgs = [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls];
    for (const call of allArgs) {
      const serialized = call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      expect(serialized.includes(FAKE_API_KEY)).toBe(false);
    }
    expect(warn.mock.calls.length + log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0);
  });

  it("house_settings が無いとき（未初期化）は問い合わせずに戻る", async () => {
    const fetchImpl: FetchLike = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await refreshWeather(db, FAKE_API_KEY, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readWeatherCache(db)).toBeNull();
  });
});

describe("summarizeForecast", () => {
  const NOW = tokyoDateTime(2026, 9, 25, 10, 0);

  it("日本時間の日ごとにまとめ、今日は含めず明日から 3 日分。最高・最低はその日の最大・最小、天気は正午に近い時刻、降水確率は最大", () => {
    const list = [
      slot([2026, 9, 25, 15], 30, 25, "Clear", 0),
      slot([2026, 9, 26, 0], 21, 18.5, "Rain", 0.9),
      slot([2026, 9, 26, 9], 24, 19, "Clouds", 0.4),
      slot([2026, 9, 26, 12], 27.4, 22, "Clear", 0.1),
      slot([2026, 9, 26, 21], 23, 20, "Rain", 0.7),
      slot([2026, 9, 27, 15], 26, 21, "Rain"),
      slot([2026, 9, 28, 12], 25, 20, "Clouds", 0.2),
      slot([2026, 9, 29, 12], 24, 19, "Clear", 0),
    ];
    expect(summarizeForecast(list, NOW)).toEqual([
      { date: "2026-09-26", condition: "clear", maxC: 27.4, minC: 18.5, pop: 0.9 },
      { date: "2026-09-27", condition: "rain", maxC: 26, minC: 21, pop: null },
      { date: "2026-09-28", condition: "clouds", maxC: 25, minC: 20, pop: 0.2 },
    ]);
  });

  it("日本時間の 0 時をまたぐ境目で日付を分ける（UTC の日付では分けない）", () => {
    // 2026-09-26 08:00 JST は UTC では 9/25 23:00。明日（9/26）の分になる。9/25 23:00 JST は今日なので含めない
    const list = [slot([2026, 9, 26, 8], 20, 17, "Rain", 0.5), slot([2026, 9, 25, 23], 22, 21, "Clear", 0)];
    expect(summarizeForecast(list, NOW)).toEqual([{ date: "2026-09-26", condition: "rain", maxC: 20, minC: 17, pop: 0.5 }]);
  });

  it("欠けた項目は飛ばし、何も残らなければ空", () => {
    const list = [{ dt: tokyoDateTime(2026, 9, 26, 12, 0) }, { main: { temp_max: 20, temp_min: 10 }, weather: [{ main: "Rain" }] }];
    expect(summarizeForecast(list, NOW)).toEqual([]);
  });
});
