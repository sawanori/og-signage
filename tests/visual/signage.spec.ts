/**
 * 表示ページ（固定データ）をモックと同じ解像度で撮影し、平面化したモックの画面部分と画素で比べる。
 * 結果は docs/design-diff/ に保存する。
 *   <向き>-compare.png  左からモック｜実装｜差分
 *   <向き>-actual.png   実装のスクリーンショット
 *   <向き>-diff.json    差分率（全体と領域ごと）
 * モックの平面化は tests/visual/rectify-mock.py、fixture の写真は tests/visual/extract-fixtures.py で作る。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "docs", "design-diff");

const CASES = [
  { orientation: "portrait", width: 1080, height: 1920, grid: [4, 8] },
  { orientation: "landscape", width: 1920, height: 1080, grid: [8, 4] },
] as const;

for (const c of CASES) {
  test(`${c.orientation} はモックと比較できる`, async ({ page }) => {
    await page.setViewportSize({ width: c.width, height: c.height });
    await page.goto(`/dev/signage?orientation=${c.orientation}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((img) => img.complete));
    await page.waitForTimeout(500);
    const shot = PNG.sync.read(await page.screenshot({ type: "png", animations: "disabled" }));
    const mock = PNG.sync.read(readFileSync(join(HERE, "reference", `mock-${c.orientation}.png`)));
    expect([shot.width, shot.height]).toEqual([mock.width, mock.height]);

    const { width, height } = mock;
    const diff = new PNG({ width, height });
    const mismatched = pixelmatch(mock.data, shot.data, diff.data, width, height, { threshold: 0.1, alpha: 0.35 });

    const [cols, rows] = c.grid;
    const regions: Record<string, number> = {};
    const cw = Math.ceil(width / cols);
    const ch = Math.ceil(height / rows);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        let bad = 0;
        let all = 0;
        for (let y = gy * ch; y < Math.min((gy + 1) * ch, height); y++) {
          for (let x = gx * cw; x < Math.min((gx + 1) * cw, width); x++) {
            const i = (y * width + x) * 4;
            // pixelmatch は不一致の画素を赤（255, 0, 0）で塗る
            if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) bad++;
            all++;
          }
        }
        regions[`x${gx * cw}-${Math.min((gx + 1) * cw, width)}_y${gy * ch}-${Math.min((gy + 1) * ch, height)}`] =
          Number(((bad / all) * 100).toFixed(2));
      }
    }

    const compare = new PNG({ width: width * 3, height });
    for (const [i, img] of [mock, shot, diff].entries()) {
      PNG.bitblt(img, compare, 0, 0, width, height, i * width, 0);
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${c.orientation}-compare.png`), PNG.sync.write(compare));
    writeFileSync(join(OUT, `${c.orientation}-actual.png`), PNG.sync.write(shot));
    const ratio = Number(((mismatched / (width * height)) * 100).toFixed(2));
    writeFileSync(
      join(OUT, `${c.orientation}-diff.json`),
      `${JSON.stringify({ orientation: c.orientation, width, height, threshold: 0.1, mismatchedPercent: ratio, regions }, null, 2)}\n`,
    );
    console.log(`${c.orientation}: 差分率 ${ratio}%`);
  });
}
