import { redirect } from "next/navigation";

/** トップページは管理画面へ（未ログインなら /admin 側で /login へ転送される） */
export default function Home() {
  redirect("/admin");
}
