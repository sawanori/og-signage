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
    SPOTLIGHT_SUBMISSION_RATE_LIMITER: RateLimit;
    /** 名刺の読み取り（/api/business-card）。ログイン不要の本人登録から呼ばれるので IP ごとに数を絞る */
    BUSINESS_CARD_RATE_LIMITER: RateLimit;
    /** 名刺の読み取りに使う Gemini の API キー（有料枠。Secret）。未設定なら読み取りを使えない */
    GEMINI_API_KEY?: string;
    RESEND_API_KEY?: string;
    SPOTLIGHT_NOTIFICATION_FROM: string;
    /** 管理画面の「企業データ」を見られるアカウントのメールアドレス（カンマ区切り）。未設定なら誰も見られない */
    COMPANY_RESEARCH_VIEWER_EMAILS?: string;
    COMPANY_RESEARCH?: import("../worker/company-research-dispatch").CompanyResearchServiceBinding;
  };
}
