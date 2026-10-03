import { MemberTerms } from "@/components/members/member-terms";

export const metadata = { title: "メンバー紹介 登録規約", robots: { index: false, follow: false } };
export const viewport = { width: "device-width", initialScale: 1 };

export default function MemberTermsPage() {
  return <MemberTerms />;
}
