import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import { House } from "lucide-react";
import { LoginForm } from "./login-form";
import { ADMIN_BRAND, ADMIN_PRODUCT, ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `ログイン | ${ADMIN_TITLE}` };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[#f4f7fc] px-6"
      style={{ fontFamily: '"LINE Seed JP", sans-serif' }}
    >
      <div className="w-full max-w-[400px] rounded-2xl bg-white px-9 pt-10 pb-9 shadow-[0_12px_40px_-16px_rgba(30,64,120,0.18)]">
        <div className="mb-8 flex items-center gap-3 text-[#1c2433]">
          <House className="size-9 stroke-[1.6]" aria-hidden />
          <div className="leading-tight">
            <p className="text-lg font-bold tracking-wide">{ADMIN_BRAND}</p>
            <p className="text-[13px] text-[#6b7688]">{ADMIN_PRODUCT}</p>
          </div>
        </div>
        <h1 className="mb-6 text-xl font-bold text-[#1c2433]">ログイン</h1>
        <LoginForm callbackUrl={typeof callbackUrl === "string" ? callbackUrl : "/admin"} />
      </div>
    </main>
  );
}
