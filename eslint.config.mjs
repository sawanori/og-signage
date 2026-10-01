import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ["node_modules/**", "dist/**", "dist-display/**", "dist-research/**", "research/dist-research/**", ".wrangler/**", ".vinext/**", "worker-configuration.d.ts", "spikes/**", "raspberry-pi/**"],
  },
];

export default config;
