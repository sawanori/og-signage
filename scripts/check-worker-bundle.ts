/**
 * Workers 用ビルド（dist/server）に、読み込み時に落ちる Node の require 呼び出しが残っていないかを調べる。
 *
 * rolldown は CommonJS の require("fs") などを、Workers では「require は無い」と例外を投げる関数の呼び出しに置き換える。
 * 縮小後は `t(\`fs\`)` のような形になるため、1 引数の呼び出しで Workers に無いモジュール名を渡しているものを探す。
 * （2026-09-25: qrcode のパッケージ入口が require("fs") を実行し、ダッシュボードが本番で 500 になった）
 *
 * 使い方: tsx scripts/check-worker-bundle.ts dist/server
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "dist/server";
const MODULES = ["fs", "fs/promises", "child_process", "worker_threads"];
const names = MODULES.map((m) => m.replace("/", "\\/")).join("|");
// 例: t(`fs`) / require("fs") / __require('node:fs') / e("node:child_process")
const pattern = new RegExp(`[A-Za-z_$][\\w$]*\\((["'\`])(?:node:)?(?:${names})\\1\\)`, "g");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
  });
}

let found = 0;
for (const file of walk(root)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(pattern)) {
    found++;
    const at = m.index ?? 0;
    console.error(`${file}: ${text.slice(Math.max(0, at - 80), at + m[0].length + 40).replace(/\s+/g, " ")}`);
  }
}

if (found) {
  console.error(`Workers で読み込み時に落ちる require 呼び出しが ${found} 件あります（${MODULES.join(", ")}）`);
  process.exit(1);
}
console.log(`OK: ${root} に Workers で落ちる require 呼び出しはありません`);
