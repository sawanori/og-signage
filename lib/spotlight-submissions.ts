import { z } from "zod";
import { spotlightTextSchema } from "./validators";

export const SPOTLIGHT_SUBMISSION_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const SPOTLIGHT_SUBMISSION_MAX_DATA_BYTES = 10 * 1024;
export const SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** 選んだ時点でここまで縮める（サイネージの写真枠は横型で縦300px程度。2026-10-01 に 1920 から変更） */
export const SPOTLIGHT_SUBMISSION_MAX_IMAGE_EDGE = 1280;
/** 画質・寸法を下げても縮めるのはここまで */
export const SPOTLIGHT_SUBMISSION_MIN_IMAGE_EDGE = 640;
/** 1枚あたりこの大きさに収まるまで画質を下げ、それでも大きければ寸法を縮める（写真とロゴを合わせて1MB未満） */
export const SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES = 400 * 1024;
/** 同意文の版。3 で「掲載中は管理のためにメールアドレスを保管する」を足した（2026-10-01） */
export const SPOTLIGHT_SUBMISSION_CONSENT_VERSION = 3;
export const SPOTLIGHT_SUBMISSION_RETRY_AFTER_SECONDS = 60;
export const SPOTLIGHT_SUBMISSION_CLEANUP_BATCH_SIZE = 50;
export const SPOTLIGHT_SUBMISSION_EXPIRY_SECONDS = 24 * 60 * 60;
export const SPOTLIGHT_REGISTRATION_PATH = "/members/register";
/** 管理画面の「確認待ち」タブを直接開くURL（ベルの知らせから飛ぶ）。 */
export const SPOTLIGHT_SUBMISSIONS_PENDING_PATH = "/admin/spotlights?tab=pending";

export const SPOTLIGHT_SUBMISSION_STATUSES = ["receiving", "pending", "approved", "rejected", "expired"] as const;
export const SPOTLIGHT_SUBMISSION_IMAGE_KINDS = ["photo", "logo"] as const;
export const SPOTLIGHT_SUBMISSION_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const spotlightSubmissionInputSchema = z.strictObject({
  ...spotlightTextSchema.shape,
  email: z.string({ error: "メールアドレスを入力してください。画面を読み込み直してください" }).trim()
    .min(1, "メールアドレスを入力してください")
    .max(254, "メールアドレスは254文字以内で入力してください")
    .email("メールアドレスの形式が正しくありません"),
  requestKey: z.uuid({ error: "送信情報が正しくありません" }),
  consent: z.literal(true, { error: "掲載先を確認して同意してください" }),
});

export type SpotlightSubmissionInput = z.infer<typeof spotlightSubmissionInputSchema>;
export type SpotlightSubmissionPayload = z.infer<typeof spotlightTextSchema>;
export type SpotlightSubmissionStatus = (typeof SPOTLIGHT_SUBMISSION_STATUSES)[number];
export type SpotlightSubmissionImageKind = (typeof SPOTLIGHT_SUBMISSION_IMAGE_KINDS)[number];
export type SpotlightSubmissionImageMimeType = (typeof SPOTLIGHT_SUBMISSION_IMAGE_MIME_TYPES)[number];
export type SpotlightNotificationStatus = "pending" | "sent" | "failed" | "skipped";

/** 検査後のサーバーだけが生成する保存情報。公開POSTのJSONでは受け付けない。 */
export interface SpotlightSubmissionFile {
  r2Key: string;
  mimeType: SpotlightSubmissionImageMimeType;
  size: number;
  sha256: string;
}

export interface SpotlightSubmissionSummary {
  id: string;
  companyName: string;
  personName: string;
  submittedAt: number;
  revision: number;
}

/** Staff画面用。requestKey・fingerprint・R2キーはブラウザへ渡さない。 */
export interface SpotlightSubmissionDetail extends SpotlightSubmissionSummary {
  payload: SpotlightSubmissionPayload;
  contactEmail: string | null;
  consentedAt: number;
  consentVersion: number;
  photoUrl: string | null;
  logoUrl: string | null;
}

export interface SpotlightSubmissionReview {
  notificationStatus: SpotlightNotificationStatus;
}

export interface SpotlightSubmissionApproval extends SpotlightSubmissionReview {
  spotlightId: string | null;
}
