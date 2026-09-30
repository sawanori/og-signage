import { SPOTLIGHT_SUBMISSION_RETRY_AFTER_SECONDS, type SpotlightSubmissionInput } from "../spotlight-submissions";

export type SpotlightSubmissionSnapshot = {
  data: SpotlightSubmissionInput;
  photo: Blob | null;
  logo: Blob | null;
};

export type SpotlightSubmissionResult =
  | { kind: "accepted" }
  | { kind: "expired"; message: string }
  | { kind: "rejected"; status: number; message: string; retryAfterSeconds: number }
  | { kind: "uncertain"; message: string };

const UNCERTAIN = "送信できたか確認できません。画面を閉じずに送信結果を確認してください。";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 外部応答の解釈だけを担当する。過去の結果不明を解除できるかはフォームが判定する。 */
export async function submitSpotlight(snapshot: SpotlightSubmissionSnapshot): Promise<SpotlightSubmissionResult> {
  const body = new FormData();
  body.set("data", JSON.stringify(snapshot.data));
  for (const kind of ["photo", "logo"] as const) {
    const blob = snapshot[kind];
    if (blob) body.set(kind, blob, `${kind}.${blob.type === "image/jpeg" ? "jpg" : blob.type === "image/png" ? "png" : "webp"}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch("/api/spotlight-submissions", { method: "POST", body, signal: controller.signal });
    const json: unknown = await response.json();
    if (response.status === 202 && record(json) && record(json.data) && json.data.accepted === true) return { kind: "accepted" };
    if (!record(json) || !record(json.error) || typeof json.error.message !== "string" || typeof json.error.code !== "string") {
      return { kind: "uncertain", message: UNCERTAIN };
    }
    const message = json.error.message;
    if (response.status === 410) return { kind: "expired", message: "前の送信は期限切れで掲載されません。入力を確認して、もう一度送信してください。" };
    if ([400, 403, 413, 415, 429].includes(response.status)) {
      const seconds = Number(response.headers.get("Retry-After"));
      return {
        kind: "rejected", status: response.status, message,
        retryAfterSeconds: response.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? seconds : SPOTLIGHT_SUBMISSION_RETRY_AFTER_SECONDS) : 0,
      };
    }
    return { kind: "uncertain", message: response.status === 409 ? "送信内容を確認できません。新しく登録せず、スタッフへご相談ください。" : UNCERTAIN };
  } catch {
    return { kind: "uncertain", message: UNCERTAIN };
  } finally {
    clearTimeout(timeout);
  }
}
