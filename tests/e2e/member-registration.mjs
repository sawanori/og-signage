/** 隔離コピーの実Worker・ローカルsqld/R2を使う。HTTP/APIのモックはしない。 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { createClient } from "@libsql/client";

const base = process.env.E2E_BASE_URL;
const databaseUrl = process.env.E2E_DATABASE_URL;
const output = process.env.E2E_OUTPUT_DIR;
if (!base || !databaseUrl || !output) throw new Error("E2E_BASE_URL/E2E_DATABASE_URL/E2E_OUTPUT_DIRを指定してください");
for (const value of [base, databaseUrl]) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname), "専用のローカル環境だけで実行してください");
}
await mkdir(output, { recursive: true });
const db = createClient({ url: databaseUrl });
const browser = await chromium.launch({ headless: true });
const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } });
const staff = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await anonymous.newPage();
const admin = await staff.newPage();
const errors = [];
const failedAssets = [];
for (const current of [page, admin]) {
  current.on("pageerror", (error) => errors.push(error.message));
  current.on("response", (response) => {
    if (response.status() >= 400 && ["image", "font"].includes(response.request().resourceType())) failedAssets.push(`${response.status()} ${response.url()}`);
  });
}

const png = new PNG({ width: 360, height: 560 });
for (let index = 0; index < png.data.length; index += 4) {
  png.data[index] = 100; png.data[index + 1] = 145; png.data[index + 2] = 165; png.data[index + 3] = 255;
}
const photo = PNG.sync.write(png);
const publicConfig = async () => {
  const response = await anonymous.request.get(`${base}/api/signage/config`);
  assert.equal(response.status(), 200);
  return response.json();
};
const query = async (sql) => (await db.execute(sql)).rows;
async function submit(name, withPhoto = true) {
  await page.goto(`${base}/members/register`, { waitUntil: "networkidle" });
  await page.getByLabel("会社名・所属", { exact: true }).fill("ブラウザ検証株式会社");
  await page.getByLabel("お名前", { exact: true }).fill(name);
  await page.getByLabel("メールアドレス", { exact: true }).fill("member@example.test");
  await page.getByLabel("ふりがな（任意）", { exact: true }).fill("やまだたろう");
  await page.getByLabel("ひとこと（任意）", { exact: true }).fill("実際の送信と掲載を確認");
  if (withPhoto) {
    await page.getByLabel("写真（任意）", { exact: true }).setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: photo });
    await page.getByAltText("選択した写真", { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "掲載イメージを確認", exact: true }).click();
  await page.getByRole("checkbox").check();
  const received = page.waitForResponse((response) => response.url().endsWith("/api/spotlight-submissions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "紹介を送信", exact: true }).click();
  const response = await received;
  assert.equal(response.status(), 202, await response.text());
  await page.getByRole("heading", { name: "送信しました", exact: true }).waitFor();
}

try {
  const before = await publicConfig();
  assert.equal(before.spotlights.length, 0);
  await submit("実動作 太郎");
  await page.screenshot({ path: join(output, "submitted.png"), fullPage: true });
  const [pending] = await query("SELECT id,status,photo_file FROM member_spotlight_submissions");
  assert.equal(pending.status, "pending");
  assert.equal((await query("SELECT id FROM member_spotlights")).length, 0);
  assert.equal((await query("SELECT id FROM media")).length, 0);
  assert.equal((await publicConfig()).spotlights.length, 0);
  const anonymousImage = await anonymous.request.get(`${base}/api/spotlight-submissions/${pending.id}/images/photo`);
  assert.ok([401, 403].includes(anonymousImage.status()));

  await admin.goto(`${base}/login?callbackUrl=/admin/spotlights`, { waitUntil: "networkidle" });
  await admin.getByLabel("メールアドレス", { exact: true }).fill("member-e2e@example.test");
  await admin.getByLabel("パスワード", { exact: true }).fill("local-member-e2e-only");
  await admin.getByRole("button", { name: "ログイン", exact: true }).click();
  await admin.waitForURL("**/admin/spotlights");
  await admin.getByRole("button", { name: "確認待ち（1件）", exact: true }).click();
  await admin.getByRole("button", { name: "内容を確認", exact: true }).click();
  await admin.getByRole("region", { name: "申請内容の確認", exact: true }).waitFor();
  await admin.waitForFunction(() => { const image = document.querySelector('img[alt="本人写真"]'); return image?.complete && image.naturalWidth > 0; });
  const staffImage = await staff.request.get(`${base}/api/spotlight-submissions/${pending.id}/images/photo`);
  assert.equal(staffImage.status(), 200);
  assert.equal(staffImage.headers()["cache-control"], "private, no-store");
  await admin.screenshot({ path: join(output, "review.png"), fullPage: true });
  await admin.getByRole("button", { name: "掲載する", exact: true }).click();
  await admin.getByRole("button", { name: "確認待ち（0件）", exact: true }).waitFor();
  const after = await publicConfig();
  assert.notEqual(after.version, before.version);
  assert.equal(after.spotlights.length, 1);
  assert.equal(after.spotlights[0].personName, "実動作 太郎");
  assert.equal("personNameKana" in after.spotlights[0], false);
  const image = await anonymous.request.get(`${base}/api/signage/media/${after.spotlights[0].photo.mediaId}`);
  assert.equal(image.status(), 200);
  assert.ok((await image.body()).length > 0);
  assert.equal(image.headers()["content-type"], "image/webp");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${base}/signage?layout=landscape`, { waitUntil: "networkidle" });
  await page.getByTestId("spotlight").getByText("実動作 太郎", { exact: false }).waitFor();
  await page.waitForFunction(() => { const image = document.querySelector('[data-testid="spotlight"] img'); return image?.complete && image.naturalWidth > 0; });
  await page.screenshot({ path: join(output, "published-signage.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await submit("却下確認 次郎", false);
  await admin.reload({ waitUntil: "networkidle" });
  await admin.getByRole("button", { name: "確認待ち（1件）", exact: true }).click();
  await admin.getByRole("button", { name: "内容を確認", exact: true }).click();
  await admin.getByRole("button", { name: "却下", exact: true }).click();
  await admin.getByRole("alertdialog").getByRole("button", { name: "却下する", exact: true }).click();
  await admin.getByRole("button", { name: "確認待ち（0件）", exact: true }).waitFor();
  const states = await query("SELECT status FROM member_spotlight_submissions ORDER BY created_at,id");
  assert.deepEqual(states.map((row) => row.status).sort(), ["approved", "rejected"]);
  assert.equal((await publicConfig()).spotlights.length, 1);
  assert.equal((await query("SELECT id FROM member_spotlights")).length, 1);
  assert.equal((await query("SELECT id FROM media")).length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedAssets, []);
  const result = { browser: await browser.version(), base, databaseUrl, mockedRequests: 0, anonymousPost: 202, unpublishedUntilApproval: true, anonymousPendingImage: anonymousImage.status(), staffLogin: true, staffPendingImage: 200, approved: true, publicConfigChanged: true, publicImage: 200, signageNameAndImage: true, rejectedWithoutPublication: true, submissionCount: 2, spotlightCount: 1, mediaCount: 1, errors, failedAssets };
  await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "failure-public.png"), fullPage: true });
  await admin.screenshot({ path: join(output, "failure-admin.png"), fullPage: true });
  throw error;
} finally {
  db.close();
  await browser.close();
}
