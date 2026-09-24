import { defineConfig, devices } from "@playwright/test";

/**
 * 表示ページのモック比較（npm run test:visual）。ブラウザが必要なため CI では実行しない。
 */
const PORT = 4173;

export default defineConfig({
  testDir: "tests/visual",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    deviceScaleFactor: 1,
  },
  webServer: {
    command: `npx vinext dev -p ${PORT}`,
    url: `http://localhost:${PORT}/dev/signage`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
