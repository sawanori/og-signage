"use client";

/**
 * 予期しないエラーの画面（管理画面・ログイン共通）。
 * 要件定義書 28 節に従い、エラーの原文は画面に出さずコンソールにだけ残す。
 */
import { useEffect } from "react";

export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f4f7fc] px-6">
      <div className="w-full max-w-[440px] rounded-2xl bg-white px-9 pt-10 pb-9 text-[#1c2433] shadow-[0_12px_40px_-16px_rgba(30,64,120,0.18)]">
        <h1 className="mb-3 text-lg font-bold">うまく表示できませんでした</h1>
        <p className="mb-6 text-sm leading-relaxed text-[#5b6577]">
          時間をおいてもう一度お試しください。何度も表示される場合は、管理者に連絡してください。
        </p>
        <button
          type="button"
          onClick={reset}
          className="w-full rounded-xl bg-[#3794ff] py-3 text-sm font-bold text-white hover:opacity-90"
        >
          もう一度読み込む
        </button>
      </div>
    </main>
  );
}
