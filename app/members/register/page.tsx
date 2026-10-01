import { env } from "cloudflare:workers";
import { SpotlightRegistrationForm } from "@/components/members/spotlight-registration-form";

export const metadata = { title: "メンバー紹介を登録", robots: { index: false, follow: false } };
export const viewport = { width: "device-width", initialScale: 1 };
// 完了画面の差出人の案内に、Worker の変数（wrangler.jsonc の vars）を毎回読む
export const dynamic = "force-dynamic";

export default function MemberRegistrationPage() {
  return <SpotlightRegistrationForm notificationFrom={env.SPOTLIGHT_NOTIFICATION_FROM} />;
}
