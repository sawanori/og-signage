import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // Workers 専用のモジュール。テストでは差し替える
      "cloudflare:workers": fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // next-auth は拡張子なしで next/server を読む。Vite に解決させるためにインライン化する
    server: { deps: { inline: ["next-auth"] } },
  },
});
