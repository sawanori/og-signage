/** `cloudflare:workers` のテスト用の差し替え（vitest.config.ts の alias） */
export const env = {
  TURSO_DATABASE_URL: "file::memory:",
  TURSO_AUTH_TOKEN: undefined as string | undefined,
  AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SPOTLIGHT_SUBMISSION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  BUSINESS_CARD_RATE_LIMITER: { limit: async () => ({ success: true }) },
  COMPANY_CHAT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  COMPANY_CHAT_EMAILS: "viewer@example.com" as string | undefined,
  COMPANY_RESEARCH: undefined as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } | undefined,
  GEMINI_API_KEY: undefined as string | undefined,
  RESEND_API_KEY: undefined as string | undefined,
  SPOTLIGHT_NOTIFICATION_FROM: "サイネージ管理 <noreply@non-turn.com>",
  COMPANY_RESEARCH_VIEWER_EMAILS: "viewer@example.com" as string | undefined,
};
