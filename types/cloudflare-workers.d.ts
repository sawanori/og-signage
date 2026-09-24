/**
 * `cloudflare:workers` の型（使う分だけ）。値は wrangler.jsonc の binding と Secret（.dev.vars）。
 * テストでは vitest.config.ts の alias で tests/stubs/cloudflare-workers.ts に差し替える。
 */
declare module "cloudflare:workers" {
  /** Rate Limiting binding（ratelimits） */
  export interface RateLimit {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  }

  export const env: {
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN?: string;
    AUTH_SECRET: string;
    LOGIN_RATE_LIMITER: RateLimit;
  };
}
