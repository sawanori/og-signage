import type { BusinessCardResult } from "../business-card";
import { prepareSpotlightImage } from "./prepare-spotlight-image";

export type BusinessCardScan = { kind: "ok"; card: BusinessCardResult } | { kind: "error"; message: string };

const NETWORK_ERROR = "名刺を読み取れませんでした。通信状況を確認して、もう一度お試しください。";

/** 名刺の表（必須）と裏（任意）を写真と同じ方法で縮めてから1回で送る（長辺1280px・約400KB。文字は読み取れる大きさ） */
export async function scanBusinessCard(front: Blob, back: Blob | null = null): Promise<BusinessCardScan> {
  const body = new FormData();
  try {
    body.append("card", (await prepareSpotlightImage(front, "photo")).blob, "card");
    if (back) body.append("back", (await prepareSpotlightImage(back, "photo")).blob, "back");
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "画像を処理できませんでした。" };
  }
  let response: Response;
  try {
    // 通信が止まっても読み取り中のまま送信できなくならないよう、上限を決めて諦める（サーバー側の読み取りは20秒まで）
    response = await fetch("/api/business-card", { method: "POST", body, credentials: "same-origin", signal: AbortSignal.timeout(45_000) });
  } catch {
    return { kind: "error", message: NETWORK_ERROR };
  }
  let json: unknown = null;
  try { json = await response.json(); } catch { /* 下で扱う */ }
  if (response.ok && json && typeof json === "object" && "data" in json) return { kind: "ok", card: (json as { data: BusinessCardResult }).data };
  const message = json && typeof json === "object" && "error" in json ? (json as { error?: { message?: unknown } }).error?.message : null;
  return { kind: "error", message: typeof message === "string" ? message : NETWORK_ERROR };
}
