/**
 * 管理画面の全ページ確認（デプロイ後の確認用）。
 *
 * ログインしてから管理画面の全ページを開き、次のどれかがあれば失敗（終了コード 1）にする。
 * - ステータスが 200 以外
 * - Cloudflare のエラー画面（Error 1101 など）や、アプリのエラー画面の文言が出ている
 * - ブラウザ側で例外が起きた
 *
 * 使い方:
 *   SMOKE_BASE_URL=https://… SMOKE_EMAIL=… SMOKE_PASSWORD=… node scripts/smoke-admin.mjs
 *   任意: SMOKE_SCREENSHOT_DIR=<dir>（各ページのスクリーンショットを保存）
 *        SMOKE_EXTRA_PATHS=/admin/devices/<id>/preview,…（追加で確認するパス）
 */
import { chromium } from "@playwright/test";

const base = process.env.SMOKE_BASE_URL;
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
if (!base || !email || !password) {
  console.error("SMOKE_BASE_URL・SMOKE_EMAIL・SMOKE_PASSWORD を設定してください");
  process.exit(2);
}

const PATHS = [
  "/",
  "/admin",
  "/admin/events",
  "/admin/events/new",
  "/admin/media",
  "/admin/videos",
  "/admin/notices",
  "/admin/member-info",
  "/admin/design",
  "/admin/schedule",
  "/admin/devices",
  "/admin/settings",
  "/admin/guide",
  "/signage", // Web 公開のサイネージ（ログイン不要）
  ...(process.env.SMOKE_EXTRA_PATHS ? process.env.SMOKE_EXTRA_PATHS.split(",") : []),
];

// Cloudflare の例外画面と、app/admin/error.tsx の文言
const ERROR_TEXTS = ["Worker threw exception", "Error 1101", "うまく表示できませんでした", "This page could not be found"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`${page.url()}: ${String(e).slice(0, 200)}`));

await page.goto(`${base}/login`);
await page.fill('input[name="email"]', email);
await page.fill('input[type="password"]', password);
await Promise.all([page.waitForURL(/\/admin/, { timeout: 30000 }), page.click('button[type="submit"]')]);

let failed = 0;
for (const [i, path] of PATHS.entries()) {
  let status = "error";
  try {
    const res = await page.goto(base + path, { waitUntil: "load", timeout: 30000 });
    status = res?.status() ?? "none";
  } catch (e) {
    status = `navigation failed: ${String(e).slice(0, 80)}`;
  }
  await page.waitForTimeout(1000);
  const text = await page.locator("body").innerText().catch(() => "");
  const errorText = ERROR_TEXTS.find((t) => text.includes(t));
  const ok = status === 200 && !errorText;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${status} ${path}${errorText ? `  [${errorText}]` : ""}`);
  if (process.env.SMOKE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SMOKE_SCREENSHOT_DIR}/${String(i).padStart(2, "0")}${path.replaceAll("/", "_")}.png` });
  }
}

if (pageErrors.length) {
  failed += pageErrors.length;
  for (const e of pageErrors) console.log(`FAIL page error ${e}`);
}
await browser.close();
console.log(failed ? `${failed} 件の問題があります` : "すべてのページが正常に表示されました");
process.exit(failed ? 1 : 0);
