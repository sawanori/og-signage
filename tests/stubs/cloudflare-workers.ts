/** `cloudflare:workers` のテスト用の差し替え（vitest.config.ts の alias） */
export const env = {
  TURSO_DATABASE_URL: "file::memory:",
  TURSO_AUTH_TOKEN: undefined as string | undefined,
  AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
};
