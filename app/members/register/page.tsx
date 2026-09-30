import { SpotlightRegistrationForm } from "@/components/members/spotlight-registration-form";

export const metadata = { title: "メンバー紹介を登録", robots: { index: false, follow: false } };
export const viewport = { width: "device-width", initialScale: 1 };

export default function MemberRegistrationPage() {
  return <SpotlightRegistrationForm />;
}
