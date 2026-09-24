/**
 * task_019: ユーザー管理。DB は一時 libSQL ファイル。
 * Server Action は getDb とセッションだけを差し替えて、権限の確認を実際に通す。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { users } from "../../db/schema";
import { loadSessionUser } from "../../lib/auth";
import { verifyPassword } from "../../lib/password";
import { changeUserRole, createUser, listUsers, setUserActive, UserServiceError } from "../../lib/services/users";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, session: null as unknown }));

vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth")>();
  return {
    ...actual,
    requireRole: (role: import("../../lib/auth").Role) =>
      actual.requireRole(role, { db: state.db, getSession: async () => state.session }),
  };
});

const { changeUserRoleAction, createUserAction, setUserActiveAction } = await import("../../app/admin/_actions/users");

let db: Db;
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.session = null;
});

afterEach(() => close());

async function insertUser(email: string, role: "staff" | "administrator", isActive = true) {
  const [row] = await db.insert(users).values({ email, role, isActive }).returning();
  return row;
}

async function row(id: string) {
  const [r] = await db.select().from(users).where(eq(users.id, id));
  return r;
}

function sessionOf(user: { id: string; sessionVersion: number }) {
  return { userId: user.id, sessionVersion: user.sessionVersion };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

const newUser = { email: " New@Example.com ", name: "山田", role: "staff", password: "correct-horse-1" };

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UserServiceError);
  expect((error as UserServiceError).code).toBe(code);
}

describe("追加", () => {
  it("メールを小文字にし、パスワードは lib/password.ts のハッシュで保存する", async () => {
    const created = await createUser(db, newUser);
    expect(created).toMatchObject({ email: "new@example.com", name: "山田", role: "staff", isActive: true });
    expect(created).not.toHaveProperty("passwordHash");

    const stored = await row(created.id);
    expect(stored.passwordHash).toMatch(/^pbkdf2\$/);
    expect(stored.passwordHash).not.toContain(newUser.password);
    expect(await verifyPassword(newUser.password, stored.passwordHash!)).toBe(true);
  });

  it("パスワードが 12 文字未満、メール不正、役割不正は追加しない", async () => {
    await expectCode(createUser(db, { ...newUser, password: "short-11chr" }), "invalid_input");
    await expectCode(createUser(db, { ...newUser, email: "no-at-mark" }), "invalid_input");
    await expectCode(createUser(db, { ...newUser, role: "owner" }), "invalid_input");
    expect(await listUsers(db)).toHaveLength(0);
  });

  it("同じメールアドレスは追加できない", async () => {
    await createUser(db, newUser);
    await expectCode(createUser(db, { ...newUser, email: "new@example.com" }), "email_taken");
  });
});

describe("最後の Administrator の保護", () => {
  it("有効な Administrator が 1 人だけなら無効化も降格もできない", async () => {
    const admin = await insertUser("admin@example.com", "administrator");
    await insertUser("off@example.com", "administrator", false);
    await expectCode(setUserActive(db, admin.id, false), "last_administrator");
    await expectCode(changeUserRole(db, admin.id, "staff"), "last_administrator");
    expect(await row(admin.id)).toMatchObject({ role: "administrator", isActive: true, sessionVersion: 0 });
  });

  it("もう 1 人有効な Administrator がいれば無効化できる", async () => {
    const a = await insertUser("a@example.com", "administrator");
    const b = await insertUser("b@example.com", "administrator");
    await setUserActive(db, a.id, false);
    // 残った 1 人は守られる
    await expectCode(setUserActive(db, b.id, false), "last_administrator");
    await expectCode(changeUserRole(db, b.id, "staff"), "last_administrator");
  });

  it("無効な Administrator は他に管理者がいなくても降格できる", async () => {
    await insertUser("admin@example.com", "administrator");
    const off = await insertUser("off@example.com", "administrator", false);
    expect(await changeUserRole(db, off.id, "staff")).toMatchObject({ role: "staff" });
  });
});

describe("session_version", () => {
  it("無効化と降格で 1 増え、古いセッションは照合に失敗する。再有効化・昇格では増えない", async () => {
    await insertUser("admin@example.com", "administrator");
    const staff = await insertUser("staff@example.com", "staff");
    const oldSession = sessionOf(staff);
    expect(await loadSessionUser(db, oldSession)).not.toBeNull();

    await setUserActive(db, staff.id, false);
    expect((await row(staff.id)).sessionVersion).toBe(1);
    expect(await loadSessionUser(db, oldSession)).toBeNull();

    await setUserActive(db, staff.id, true);
    expect((await row(staff.id)).sessionVersion).toBe(1);
    // 無効化前のセッションは再有効化しても戻らない
    expect(await loadSessionUser(db, oldSession)).toBeNull();

    await changeUserRole(db, staff.id, "administrator");
    expect((await row(staff.id)).sessionVersion).toBe(1);

    const promotedSession = sessionOf(await row(staff.id));
    await changeUserRole(db, staff.id, "staff");
    expect((await row(staff.id)).sessionVersion).toBe(2);
    expect(await loadSessionUser(db, promotedSession)).toBeNull();
  });

  it("同じ値への変更は何もしない", async () => {
    const staff = await insertUser("staff@example.com", "staff");
    await changeUserRole(db, staff.id, "staff");
    await setUserActive(db, staff.id, true);
    expect((await row(staff.id)).sessionVersion).toBe(0);
  });

  it("存在しないユーザーは not_found", async () => {
    await expectCode(setUserActive(db, "missing", false), "not_found");
    await expectCode(changeUserRole(db, "missing", "staff"), "not_found");
  });
});

describe("Server Actions の権限", () => {
  it("Staff は追加・役割変更・無効化ができない", async () => {
    const staff = await insertUser("staff@example.com", "staff");
    const other = await insertUser("other@example.com", "staff");
    state.session = sessionOf(staff);
    const before = await db.select().from(users);

    const denied = { ok: false, error: "この操作を行う権限がありません" };
    expect(await createUserAction(form(newUser))).toEqual(denied);
    expect(await changeUserRoleAction(staff.id, "administrator")).toEqual(denied);
    expect(await setUserActiveAction(other.id, false)).toEqual(denied);
    expect(await db.select().from(users)).toEqual(before);
  });

  it("未ログインは拒否する", async () => {
    expect(await createUserAction(form(newUser))).toEqual({ ok: false, error: "ログインしてください" });
    expect(await listUsers(db)).toHaveLength(0);
  });

  it("Administrator は追加・役割変更・無効化ができ、自分が最後の管理者なら無効化できない", async () => {
    const admin = await insertUser("admin@example.com", "administrator");
    state.session = sessionOf(admin);

    const created = await createUserAction(form(newUser));
    if (!created.ok) throw new Error(created.error);
    expect(created.data).toMatchObject({ email: "new@example.com", role: "staff" });

    expect(await changeUserRoleAction(created.data.id, "administrator")).toMatchObject({
      ok: true,
      data: { role: "administrator" },
    });
    expect(await setUserActiveAction(created.data.id, false)).toMatchObject({ ok: true, data: { isActive: false } });
    expect(await setUserActiveAction(admin.id, false)).toEqual({
      ok: false,
      error: "最後の管理者は無効にしたり役割を変えたりできません",
    });
    expect(await createUserAction(form({ ...newUser, password: "short" }))).toEqual({
      ok: false,
      error: "パスワードは12文字以上にしてください",
    });
  });

  it("無効化されたユーザーの次の操作は拒否される", async () => {
    const admin = await insertUser("admin@example.com", "administrator");
    const other = await insertUser("other@example.com", "administrator");
    state.session = sessionOf(other);
    await setUserActive(db, other.id, false);
    expect(await setUserActiveAction(admin.id, false)).toEqual({ ok: false, error: "ログインしてください" });
  });
});
