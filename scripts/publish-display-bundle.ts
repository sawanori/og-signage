/**
 * Pi 用表示バンドル（dist-display/）を公開する（計画 7 節「表示ページ」、task_014b）。
 *
 * 1. dist-display/ を zip にする（ファイル順と時刻を固定。同じ中身なら同じバイト列）。
 * 2. SHA-256 を計算し、ID を「ハッシュ先頭 12 桁-公開日時（UTC）」にする（不変 ID。上書きしない）。
 * 3. R2 の display-bundles/<id>.zip に置く（wrangler r2 object put）。
 * 4. display_bundles に登録し、is_current を新しいものへ切り替える（1 トランザクション）。
 *    config の displayBundle が変わるので、端末の config の version も変わる。
 *
 * 実行: npm run build:display && npm run publish:display
 *
 * 接続先（環境変数）:
 * - TURSO_DATABASE_URL / TURSO_AUTH_TOKEN: DB。未設定なら file:local.db（ローカル）。
 * - DISPLAY_BUNDLE_R2: "local"（既定。wrangler のローカル R2）か "remote"（本番の R2）。
 * - DISPLAY_BUNDLE_R2_BUCKET: バケット名。既定は wrangler.jsonc の sharehouse-signage。
 * - DISPLAY_BUNDLE_R2_PERSIST_TO: ローカル R2 の保存先（wrangler の --persist-to）。未設定なら wrangler の既定。
 * - DISPLAY_BUNDLE_DIR: バンドルのディレクトリ。既定は dist-display。
 */
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/index";
import { displayBundles } from "../db/schema";
import { SCHEMA_VERSION } from "../lib/config-schema";

// ---------------------------------------------------------------- zip

/** ディレクトリ配下のファイルを、区切りを / にした相対パスの昇順で返す */
export function listBundleFiles(dir: string): { name: string; path: string }[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  return walk(dir)
    .map((path) => ({ name: relative(dir, path).split(sep).join("/"), path }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** deflate の zip を作る。時刻は 1980-01-01 00:00 に固定する */
export function createZip(files: { name: string; data: Uint8Array }[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const UTF8_FLAG = 1 << 11;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に必要な版
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 作成した版
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

// ---------------------------------------------------------------- ID と登録

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** ハッシュ先頭 12 桁と公開日時（UTC、YYYYMMDDHHmmss）。例: 3f2a9c01b7de-20260925093000 */
export function bundleIdFor(sha256: string, publishedAt: Date): string {
  const stamp = publishedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${sha256.slice(0, 12)}-${stamp}`;
}

export const bundleR2Key = (id: string) => `display-bundles/${id}.zip`;

export type BundleRecord = { id: string; sha256: string; size: number; r2Key: string; publishedAt: number };

/** display_bundles に登録し、現行を新しいものへ切り替える（現行は常に 1 件） */
export async function registerDisplayBundle(db: Db, record: BundleRecord): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(displayBundles).set({ isCurrent: false }).where(eq(displayBundles.isCurrent, true));
    await tx.insert(displayBundles).values({ ...record, schemaVersion: SCHEMA_VERSION, isCurrent: true });
  });
}

// ---------------------------------------------------------------- 実行

function putToR2(key: string, file: string): void {
  const target = process.env.DISPLAY_BUNDLE_R2 ?? "local";
  if (target !== "local" && target !== "remote") throw new Error('DISPLAY_BUNDLE_R2 は "local" か "remote" を指定してください');
  const bucket = process.env.DISPLAY_BUNDLE_R2_BUCKET ?? "sharehouse-signage";
  const args = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", "application/zip", `--${target}`];
  if (target === "local" && process.env.DISPLAY_BUNDLE_R2_PERSIST_TO) args.push("--persist-to", process.env.DISPLAY_BUNDLE_R2_PERSIST_TO);
  execFileSync("npx", args, { stdio: "inherit" });
}

async function main(): Promise<void> {
  const dir = process.env.DISPLAY_BUNDLE_DIR ?? "dist-display";
  const files = listBundleFiles(dir);
  if (!files.some((f) => f.name === "index.html")) {
    throw new Error(`${dir}/index.html がありません。先に npm run build:display を実行してください`);
  }

  const zip = createZip(files.map((f) => ({ name: f.name, data: readFileSync(f.path) })));
  const sha256 = sha256Hex(zip);
  const publishedAt = new Date();
  const id = bundleIdFor(sha256, publishedAt);
  const r2Key = bundleR2Key(id);

  // R2 に置いてから DB に登録する（DB が存在しないオブジェクトを指さないように）
  const tmp = mkdtempSync(join(tmpdir(), "display-bundle-"));
  try {
    const zipPath = join(tmp, `${id}.zip`);
    writeFileSync(zipPath, zip);
    putToR2(r2Key, zipPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const { client, db } = createDb(createClient, process.env.TURSO_DATABASE_URL ?? "file:local.db", process.env.TURSO_AUTH_TOKEN);
  try {
    await registerDisplayBundle(db, { id, sha256, size: zip.length, r2Key, publishedAt: Math.floor(publishedAt.getTime() / 1000) });
  } finally {
    client.close();
  }
  console.log(JSON.stringify({ id, sha256, size: zip.length, r2Key }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
