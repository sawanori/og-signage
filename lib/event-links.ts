/**
 * イベント詳細ページ（/events/[id]。ログイン不要）の URL。
 * サイネージはタッチ操作ができないため、QR コードでスマートフォンにこのページを開かせる。
 * イベントに QR の飛び先（qrUrl）が登録されていればそちらを優先する（lib/config-builder.ts）。
 */
export function eventDetailPath(eventId: string): string {
  return `/events/${encodeURIComponent(eventId)}`;
}

export function eventDetailUrl(siteUrl: string, eventId: string): string {
  return new URL(eventDetailPath(eventId), siteUrl).toString();
}
