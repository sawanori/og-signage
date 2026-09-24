import { logout } from "../../app/login/actions";

/** 管理画面のヘッダーに置くログアウトボタン */
export function LogoutButton({ className }: { className?: string }) {
  return (
    <form action={logout}>
      <button type="submit" className={className}>
        ログアウト
      </button>
    </form>
  );
}
