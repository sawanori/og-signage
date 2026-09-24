/**
 * lib/weather.ts（task_013）。DB は一時 libSQL ファイル、fetch はテストで差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { houseSettings, weatherCache } from "../../db/schema";
import { OPENWEATHER_URL, refreshWeather, type FetchLike } from "../../lib/weather";
import { openTempDb } from "../helpers/temp-db";

const FAKE_API_KEY = "sk_test_1234567890abcdef";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { name: "Yokohama", weather: [{ main: "Clouds" }], main: { temp: 21.5 } });
    });

    const before = Math.floor(Date.now() / 1000);
    await refreshWeather(db, FAKE_API_KEY, fetchImpl);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe(OPENWEATHER_URL);
    expect(url.searchParams.get("lat")).toBe("35.4437");
    expect(url.searchParams.get("lon")).toBe("139.638");
    expect(url.searchParams.get("q")).toBeNull();
    expect(url.searchParams.get("units")).toBe("metric");
    expect(url.searchParams.get("lang")).toBe("ja");
    expect(url.searchParams.get("appid")).toBe(FAKE_API_KEY);

    const row = await readWeatherCache(db);
    expect(row).not.toBeNull();
    expect(row!.condition).toBe("clouds");
    expect(row!.temperatureC).toBe(21.5);
    // 表示用の地域名は house_settings の値を使う（API の name はフォールバックのみ）
    expect(row!.locationName).toBe("横浜市");
    expect(row!.fetchedAt).toBeGreaterThanOrEqual(before);
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { weather: [{ main: "Clear" }], main: { temp: 20 } }))
      .mockResolvedValueOnce(jsonResponse(200, { weather: [{ main: "Rain" }], main: { temp: 15 } }));

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
