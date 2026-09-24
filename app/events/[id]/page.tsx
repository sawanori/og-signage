/**
 * イベント詳細ページ（/events/[id]。ログイン不要）。
 * サイネージはタッチ操作ができないため、大きな枠の QR コードからスマートフォンでこのページを開く
 * （QR の飛び先が未登録のイベントは、lib/config-builder.ts がこのページの URL を入れる）。
 * 公開中のイベントだけを出し、下書き・存在しないものは 404。検索エンジンには載せない。
 */
import { notFound } from "next/navigation";
import { CalendarDays, MapPin, UserRound, Users } from "lucide-react";
import { formatDateJa, formatParticipation, formatTimeRange } from "@/components/signage/model";
import { getPublicEvent } from "@/lib/public-signage";
import { getDb } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export const metadata = { title: "イベントの詳細", robots: { index: false, follow: false } };

// スマートフォンで読むページなので、端末の幅で表示する
export const viewport = { width: "device-width", initialScale: 1 };

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getPublicEvent(getDb(), id);
  if (!event) notFound();

  return (
    <main className="min-h-screen bg-[#f4f3f1] text-[#16202b]" style={{ fontFamily: '"LINE Seed JP", sans-serif' }}>
      <article className="mx-auto max-w-xl pb-12">
        {event.imageMediaId ? (
          // eslint-disable-next-line @next/next/no-img-element -- R2 の中継をそのまま使う
          <img
            src={`/api/signage/media/${encodeURIComponent(event.imageMediaId)}`}
            alt=""
            className="aspect-[3/2] w-full object-cover"
          />
        ) : (
          <div className="aspect-[3/2] w-full" style={{ backgroundColor: event.category?.color ?? "#2b3440" }} />
        )}
        <div className="px-5 pt-6">
          {event.category ? (
            <span
              className="inline-block rounded-full px-3 py-1 text-xs font-bold text-white"
              style={{ backgroundColor: event.category.color }}
            >
              {event.category.name}
            </span>
          ) : null}
          <h1 className="mt-3 text-2xl leading-snug font-bold">
            {event.title}
            {event.emoji ? ` ${event.emoji}` : ""}
          </h1>
          <ul className="mt-5 space-y-3 text-[15px]">
            <li className="flex items-start gap-3">
              <CalendarDays className="mt-0.5 size-5 shrink-0" aria-hidden />
              <span>
                {formatDateJa(event.startAt)} {formatTimeRange(event)}
              </span>
            </li>
            {event.location ? (
              <li className="flex items-start gap-3">
                <MapPin className="mt-0.5 size-5 shrink-0" aria-hidden />
                <span>{event.location}</span>
              </li>
            ) : null}
            <li className="flex items-start gap-3">
              <Users className="mt-0.5 size-5 shrink-0" aria-hidden />
              <span>{formatParticipation(event)}</span>
            </li>
            {event.hostName ? (
              <li className="flex items-start gap-3">
                <UserRound className="mt-0.5 size-5 shrink-0" aria-hidden />
                <span>主催：{event.hostName}</span>
              </li>
            ) : null}
          </ul>
          {event.description ? <p className="mt-6 leading-relaxed whitespace-pre-line">{event.description}</p> : null}
          {event.qrUrl ? (
            <a
              href={event.qrUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-8 block rounded-full bg-[#16202b] py-3 text-center font-bold text-white"
            >
              関連ページを開く
            </a>
          ) : null}
        </div>
      </article>
    </main>
  );
}
