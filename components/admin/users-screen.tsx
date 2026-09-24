"use client";

/**
 * システム設定（/admin/settings。Administrator のみ）。ユーザーの追加・役割変更・無効化と再有効化。
 * 最後の有効な管理者はサーバー側で守る。画面でも該当する操作を押せなくする。
 */
import { Plus, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { changeUserRoleAction, createUserAction, setUserActiveAction } from "@/app/admin/_actions/users";
import type { Role } from "@/lib/auth";
import styles from "./admin.module.css";
import { ConfirmDialog, type ConfirmRequest } from "./confirm-dialog";
import { ROLE_LABELS } from "./dashboard-types";
import d from "./devices.module.css";
import type { UserView } from "./devices-types";

type Notice = { text: string; error: boolean } | null;

const PASSWORD_MIN_LENGTH = 12;

export function UsersScreen({ users, currentUserId }: { users: UserView[]; currentUserId: string }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const activeAdmins = users.filter((u) => u.isActive && u.role === "administrator").length;
  const isLastAdmin = (u: UserView) => u.isActive && u.role === "administrator" && activeAdmins <= 1;

  const apply = (task: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    startTransition(async () => {
      const result = await task();
      setNotice(result.ok ? { text: done, error: false } : { text: result.error, error: true });
      router.refresh();
    });

  const who = (u: UserView) => u.name?.trim() || u.email;

  const changeRole = (u: UserView, role: Role) => {
    const run = () => apply(() => changeUserRoleAction(u.id, role), `${who(u)} さんの役割を「${ROLE_LABELS[role]}」にしました`);
    if (role === "staff") {
      setConfirm({
        title: `${who(u)} さんを「${ROLE_LABELS.staff}」にしますか？`,
        body: "管理者専用の画面が使えなくなり、開いている画面ではログインし直しが必要になります。",
        confirmLabel: "変更する",
        onConfirm: run,
      });
    } else {
      run();
    }
  };

  const toggleActive = (u: UserView) => {
    if (!u.isActive) {
      apply(() => setUserActiveAction(u.id, true), `${who(u)} さんを有効に戻しました`);
      return;
    }
    setConfirm({
      title: `${who(u)} さんを無効にしますか？`,
      body: "ログインできなくなり、開いている画面の次の操作も拒否されます。あとで有効に戻せます。",
      confirmLabel: "無効にする",
      danger: true,
      onConfirm: () => apply(() => setUserActiveAction(u.id, false), `${who(u)} さんを無効にしました`),
    });
  };

  return (
    <div className={d.page}>
      <div className={d.pageHead}>
        <h2 className={d.pageTitle}>システム設定</h2>
        <p className={d.pageSub}>管理画面を使うユーザーを追加し、役割の変更や無効化ができます。</p>
      </div>
      <div className={d.settingsGrid}>
        <section className={`${styles.card} ${d.listCard}`} aria-labelledby="users-title">
          <h3 id="users-title" className={styles.cardTitle}>
            ユーザー一覧
          </h3>
          <table className={d.table}>
            <thead>
              <tr>
                <th scope="col">名前</th>
                <th scope="col">メールアドレス</th>
                <th scope="col">役割</th>
                <th scope="col">状態</th>
                <th scope="col">
                  <span className={d.visuallyHidden}>操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const locked = isLastAdmin(u);
                return (
                  <tr key={u.id} data-inactive={!u.isActive || undefined}>
                    <td>
                      <span className={d.userCell}>
                        <span className={d.userAvatar} aria-hidden>
                          <UserRound size={16} />
                        </span>
                        {u.name ?? "—"}
                        {u.id === currentUserId ? <span className={d.youTag}>あなた</span> : null}
                      </span>
                    </td>
                    <td className={d.emailCell}>{u.email}</td>
                    <td>
                      <select
                        className={`${styles.select} ${d.roleSelect}`}
                        value={u.role}
                        disabled={pending || locked}
                        aria-label={`${who(u)} さんの役割`}
                        title={locked ? "最後の管理者は役割を変えられません" : undefined}
                        onChange={(e) => changeRole(u, e.target.value as Role)}
                      >
                        <option value="staff">{ROLE_LABELS.staff}</option>
                        <option value="administrator">{ROLE_LABELS.administrator}</option>
                      </select>
                    </td>
                    <td>
                      <span className={d.stateBadge} data-active={u.isActive}>
                        {u.isActive ? "有効" : "無効"}
                      </span>
                    </td>
                    <td className={d.actionCell}>
                      <button
                        type="button"
                        className={`${styles.outlineButton} ${d.actionButton} ${u.isActive ? d.dangerButton : ""}`}
                        disabled={pending || locked}
                        title={locked ? "最後の管理者は無効にできません" : undefined}
                        onClick={() => toggleActive(u)}
                      >
                        {u.isActive ? "無効にする" : "有効に戻す"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {notice ? (
            <p className={`${d.message} ${notice.error ? d.messageError : ""}`} role="status">
              {notice.text}
            </p>
          ) : null}
        </section>
        <AddUserCard />
      </div>
      {confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}

function AddUserCard() {
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createUserAction(data);
      if (!result.ok) {
        setNotice({ text: result.error, error: true });
        return;
      }
      setNotice({ text: `${result.data.email} を追加しました。初期パスワードは本人に直接伝えてください`, error: false });
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <section className={`${styles.card} ${d.registerCard}`} aria-labelledby="add-user-title">
      <h3 id="add-user-title" className={styles.cardTitle}>
        ユーザーを追加
      </h3>
      <form ref={formRef} className={d.stackForm} onSubmit={onSubmit}>
        <label className={d.field}>
          <span className={d.label}>メールアドレス</span>
          <input className={d.input} name="email" type="email" required autoComplete="off" />
        </label>
        <label className={d.field}>
          <span className={d.label}>名前</span>
          <input className={d.input} name="name" required maxLength={100} autoComplete="off" />
        </label>
        <label className={d.field}>
          <span className={d.label}>役割</span>
          <select className={`${styles.select} ${d.selectField}`} name="role" defaultValue="staff">
            <option value="staff">{ROLE_LABELS.staff}</option>
            <option value="administrator">{ROLE_LABELS.administrator}</option>
          </select>
        </label>
        <label className={d.field}>
          <span className={d.label}>初期パスワード（{PASSWORD_MIN_LENGTH} 文字以上）</span>
          <input
            className={d.input}
            name="password"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
        </label>
        <button type="submit" className={d.primaryButton} disabled={pending}>
          <Plus size={18} strokeWidth={2.4} aria-hidden />
          追加する
        </button>
      </form>
      {notice ? (
        <p className={`${d.message} ${notice.error ? d.messageError : ""}`} role="status">
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
