/**
 * Pi 用表示バンドルのビルド設定（npm run build:display）。
 * display/ を root に静的ビルドし、リポジトリ直下の dist-display/ に出力する。
 * 相対パス（base: "./"）で出力し、フォント等もすべて同梱する（外部 URL を読まない）。
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { "@": repoRoot } },
  build: {
    outDir: fileURLToPath(new URL("../dist-display", import.meta.url)),
    emptyOutDir: true,
    // フォントを data: URI に埋め込まず、ファイルとして同梱する
    assetsInlineLimit: 0,
  },
});
