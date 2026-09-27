import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

/**
 * この版の印（lib/build-id.ts）。表示中のサイネージが、新しい版が出たことに気づいて読み直すために使う（2026-09-27 ユーザー指示）。
 * git のコミット。SIGNAGE_BUILD_ID を渡せばそれを使う（手元で版の切り替わりを試すとき）。どちらも無ければ空で、読み直しはしない
 */
function buildId(): string {
  if (process.env.SIGNAGE_BUILD_ID) return process.env.SIGNAGE_BUILD_ID;
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId()),
  },
  plugins: [
    tailwindcss(),
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
