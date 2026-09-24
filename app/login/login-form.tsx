"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { email: "", error: null };

const inputClass =
  "h-11 w-full rounded-lg border border-[#d9e2ef] bg-white px-3.5 text-[15px] text-[#1c2433] outline-none transition placeholder:text-[#a3adbd] focus:border-[#2f7cf0] focus:ring-3 focus:ring-[#2f7cf0]/20";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, action, pending] = useActionState(login, initialState);

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      {state.error && (
        <p role="alert" className="rounded-lg bg-[#fdeeee] px-3.5 py-2.5 text-sm text-[#c8363b]">
          {state.error}
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-bold text-[#3a4558]">メールアドレス</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          defaultValue={state.email}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-bold text-[#3a4558]">パスワード</span>
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="mt-1 h-11 rounded-lg bg-[#2f7cf0] text-[15px] font-bold text-white shadow-[0_6px_16px_-6px_rgba(47,124,240,0.6)] transition hover:bg-[#256ddb] disabled:opacity-60"
      >
        {pending ? "ログインしています…" : "ログイン"}
      </button>
    </form>
  );
}
