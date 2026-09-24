/**
 * ダッシュボード（/dev/dashboard、固定データ）をモック image/dashboard.png と同じ 1536×1024 で撮影し、画素で比べる。
 * 結果は docs/design-diff/ に保存する。
 *   dashboard-compare.jpg  左からモック｜実装｜差分
 *   dashboard-actual.png   実装のスクリーンショット（.gitignore 済み）
 *   dashboard-diff.json    差分率（全体と領域ごと）
 * 固定データは app/dev/dashboard/fixture.ts、写真は public/fixtures/dashboard/（モックから切り出したもの）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, "docs", "design-diff");
const WIDTH = 1536;
const HEIGHT = 1024;

/** モック上の各部の範囲 [x0, y0, x1, y1] */
const REGIONS: Record<string, [number, number, number, number]> = {
  sidebar: [0, 0, 269, 1024],
  header: [269, 0, 1536, 92],
  calendar: [284, 93, 707, 279],
  todayEvent: [717, 92, 1100, 282],
  eventList: [284, 292, 1099, 762],
  video: [284, 772, 791, 1006],
  notice: [805, 772, 1099, 1006],
  preview: [1116, 93, 1519, 1005],
};

test("ダッシュボードはモックと比較できる", async ({ page, browser }) => {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto("/dev/dashboard", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  await page.waitForTimeout(500);
  const shot = PNG.sync.read(await page.screenshot({ type: "png", animations: "disabled" }));
  const mock = PNG.sync.read(readFileSync(join(ROOT, "image", "dashboard.png")));
  expect([shot.width, shot.height]).toEqual([mock.width, mock.height]);

  // モックは RGB、スクリーンショットは RGBA。アルファを揃える
  for (let i = 3; i < mock.data.length; i += 4) mock.data[i] = 255;

  const diff = new PNG({ width: WIDTH, height: HEIGHT });
  const mismatched = pixelmatch(mock.data, shot.data, diff.data, WIDTH, HEIGHT, { threshold: 0.1, alpha: 0.35 });

  const regions: Record<string, number> = {};
  for (const [name, [x0, y0, x1, y1]] of Object.entries(REGIONS)) {
    let bad = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * WIDTH + x) * 4;
        // pixelmatch は不一致の画素を赤（255, 0, 0）で塗る
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) bad++;
      }
    }
    regions[name] = Number(((bad / ((x1 - x0) * (y1 - y0))) * 100).toFixed(2));
  }

  const compare = new PNG({ width: WIDTH * 3, height: HEIGHT });
  for (const [i, img] of [mock, shot, diff].entries()) {
    PNG.bitblt(img, compare, 0, 0, WIDTH, HEIGHT, i * WIDTH, 0);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "dashboard-actual.png"), PNG.sync.write(shot));

  // 比較画像は JPEG で保存する（PNG は大きいので .gitignore 済み）。ブラウザで描いて JPEG で撮る
  const jpegPage = await browser.newPage({ viewport: { width: WIDTH * 3, height: HEIGHT }, deviceScaleFactor: 1 });
  const dataUrl = `data:image/png;base64,${PNG.sync.write(compare).toString("base64")}`;
  await jpegPage.setContent(`<body style="margin:0"><img src="${dataUrl}" style="display:block"></body>`);
  await jpegPage.waitForFunction(() => document.images[0]?.complete);
  writeFileSync(join(OUT, "dashboard-compare.jpg"), await jpegPage.screenshot({ type: "jpeg", quality: 82 }));
  await jpegPage.close();

  const ratio = Number(((mismatched / (WIDTH * HEIGHT)) * 100).toFixed(2));
  writeFileSync(
    join(OUT, "dashboard-diff.json"),
    `${JSON.stringify({ page: "/dev/dashboard", width: WIDTH, height: HEIGHT, threshold: 0.1, mismatchedPercent: ratio, regions }, null, 2)}\n`,
  );
  console.log(`dashboard: 差分率 ${ratio}%`, regions);
});
