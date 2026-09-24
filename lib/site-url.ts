import { headers } from "next/headers";

/**
 * 今のリクエストのサイトの URL（例: https://sharehouse-signage.snp-inc-info.workers.dev）。
 * 画面（サーバー部品）で QR の飛び先を作るのに使う。API では request.url の origin を使う。
 */
export async function currentSiteUrl(): Promise<string | null> {
  const h = await headers();
  const host = h.get("host");
  if (!host) return null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}
