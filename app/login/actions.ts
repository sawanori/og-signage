"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { signIn, signOut } from "../../lib/auth";

export type LoginState = { email: string; error: string | null };

/** 転送先は自サイト内のパスだけ許す */
function safeRedirectTo(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/admin";
  }
  return value;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  try {
    await signIn("credentials", {
      email,
      password: String(formData.get("password") ?? ""),
      redirectTo: safeRedirectTo(formData.get("callbackUrl")),
    });
  } catch (e) {
    // 成功時の転送（redirect）は例外として投げられるので、そのまま投げ直す
    if (e instanceof CredentialsSignin) {
      return {
        email,
        error: e.code === "rate_limited" ? "しばらくしてからお試しください" : "メールアドレスかパスワードが違います",
      };
    }
    if (e instanceof AuthError) return { email, error: "ログインできませんでした。しばらくしてからお試しください" };
    throw e;
  }
  return { email, error: null };
}

export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
