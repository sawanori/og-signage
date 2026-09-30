/**
 * メンバー紹介（/admin/spotlights、Staff 以上）。サイネージの MEMBER SPOTLIGHT に出すメンバーの一覧・追加・編集・削除。
 */
import { SpotlightsView } from "@/components/admin/spotlights-view";
import { getDb } from "@/lib/runtime";
import { listSpotlights } from "@/lib/services/spotlights";
import { listSpotlightSubmissions } from "@/lib/services/spotlight-submissions";
import { requirePageUser } from "../_components/current-user";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `メンバー紹介 | ${ADMIN_TITLE}` };

export default async function SpotlightsPage() {
  const user = await requirePageUser();
  const db = getDb();
  const [spotlights, submissions] = await Promise.all([listSpotlights(db), listSpotlightSubmissions(db, user)]);
  return <SpotlightsView spotlights={spotlights} submissions={submissions} />;
}
