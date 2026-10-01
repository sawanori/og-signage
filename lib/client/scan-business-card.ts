import type { BusinessCardResult } from "../business-card";
import { prepareSpotlightImage } from "./prepare-spotlight-image";

export type BusinessCardScan = { kind: "ok"; card: BusinessCardResult } | { kind: "error"; message: string };

const NETWORK_ERROR = "名刺を読み取れませんでした。通信状況を確認して、もう一度お試しください。";

/** 名刺の写真を写真と同じ方法で縮めてから送る（長辺1280px・約400KB。文字は読み取れる大きさ） */
export async function scanBusinessCard(file: Blob): Promise<BusinessCardScan> {
  let image: Blob;
  try {
    image = (await prepareSpotlightImage(file, "photo")).blob;
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "画像を処理できませんでした。" };
  }
  const body = new FormData();
  body.append("card", image, "card");
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
