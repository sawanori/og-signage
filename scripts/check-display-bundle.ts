/**
 * dist-display（Pi 用表示バンドル）が外部 URL を読み込まないことを検査する（CI の web ジョブ）。
 * 実行: npx tsx scripts/check-display-bundle.ts [dist-display]
 *
 * - HTML: src / href が http(s):// か // で始まるものは不可。
 * - CSS: url(...) と @import が http(s):// か // で始まるものは不可。
 * - JS: 文字列中の http(s)://<ホスト> は、読み込みに使われない識別子（XML 名前空間・エラーメッセージの案内先・
 *   JSON Schema の $schema）のホストだけ許す。それ以外が 1 つでもあれば不可。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** 読み込み先ではなく識別子・文言として埋め込まれている URL のホスト */
const ALLOWED_JS_HOSTS = new Set(["www.w3.org", "react.dev", "json-schema.org"]);

const HTML_LOAD = /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//gi;
const CSS_LOAD = /(?:url\(\s*["']?\s*|@import\s+["']\s*)(?:https?:)?\/\//gi;
const JS_URL = /https?:\/\/([A-Za-z0-9.-]+)/g;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function findExternalRefs(fileName: string, text: string): string[] {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".html") return [...text.matchAll(HTML_LOAD)].map((m) => m[0]);
  if (ext === ".css") return [...text.matchAll(CSS_LOAD)].map((m) => m[0]);
  if (ext === ".js" || ext === ".mjs") {
    return [...text.matchAll(JS_URL)].filter((m) => !ALLOWED_JS_HOSTS.has(m[1].toLowerCase())).map((m) => m[0]);
  }
  return [];
}

const dir = process.argv[2] ?? "dist-display";
const files = listFiles(dir);
if (!files.some((f) => f.endsWith("index.html"))) {
  console.error(`${dir}/index.html がありません。先に npm run build:display を実行してください`);
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const ext = extname(file).toLowerCase();
  if (![".html", ".css", ".js", ".mjs"].includes(ext)) continue;
  for (const ref of findExternalRefs(file, readFileSync(file, "utf8"))) {
    console.error(`外部参照: ${relative(dir, file)}: ${ref}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`外部参照なし（${files.length} ファイルを検査）`);
