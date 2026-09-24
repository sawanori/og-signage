/**
 * 表示バンドルの公開（scripts/publish-display-bundle.ts）のうち、zip・ID・DB 登録。
 * R2 への配置は wrangler を呼ぶだけなのでここでは扱わない。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { displayBundles } from "@/db/schema";
import {
  bundleIdFor,
  bundleR2Key,
  createZip,
  registerDisplayBundle,
  sha256Hex,
} from "@/scripts/publish-display-bundle";
import { openTempDb } from "../helpers/temp-db";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("createZip", () => {
  it("同じ中身なら同じバイト列になり、標準の unzip で展開できる", () => {
    const files = [
      { name: "index.html", data: Buffer.from("<!doctype html><title>サイネージ</title>") },
      { name: "assets/app.js", data: Buffer.from("console.log(1);".repeat(100)) },
    ];
    const a = createZip(files);
    const b = createZip(files);
    expect(sha256Hex(a)).toBe(sha256Hex(b));

    const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "b.zip"), a);
    execFileSync("unzip", ["-q", "b.zip", "-d", "out"], { cwd: dir });
    expect(readFileSync(join(dir, "out/index.html"), "utf8")).toBe("<!doctype html><title>サイネージ</title>");
    expect(readFileSync(join(dir, "out/assets/app.js"), "utf8")).toBe("console.log(1);".repeat(100));
  });
});

describe("bundleIdFor", () => {
  it("ハッシュ先頭 12 桁と UTC の日時", () => {
    const id = bundleIdFor("0123456789abcdef".repeat(4), new Date("2026-09-25T09:30:05Z"));
    expect(id).toBe("0123456789ab-20260925093005");
    expect(bundleR2Key(id)).toBe("display-bundles/0123456789ab-20260925093005.zip");
  });
});

describe("registerDisplayBundle", () => {
  it("新しいバンドルを登録し、現行をそれだけに切り替える", async () => {
    const { db, close } = await openTempDb();
    cleanups.push(close);
    const rec = (n: number) => {
      const sha = String(n).repeat(64).slice(0, 64);
      const id = bundleIdFor(sha, new Date(Date.UTC(2026, 8, 25, 0, 0, n)));
      return { id, sha256: sha, size: 10 + n, r2Key: bundleR2Key(id), publishedAt: 1_780_000_000 + n };
    };
    await registerDisplayBundle(db, rec(1));
    await registerDisplayBundle(db, rec(2));

    const rows = await db.select().from(displayBundles);
    expect(rows).toHaveLength(2);
    const current = await db.select().from(displayBundles).where(eq(displayBundles.isCurrent, true));
    expect(current.map((r) => r.id)).toEqual([rec(2).id]);
    expect(current[0]).toMatchObject({ sha256: rec(2).sha256, size: 12, r2Key: rec(2).r2Key, schemaVersion: 1 });
  });
});
