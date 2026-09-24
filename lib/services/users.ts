/**
 * 管理ユーザーの一覧・追加・役割変更・無効化（task_019。計画 6 節の権限表、8.2 節のシステム設定）。
 *
 * - 権限（Administrator のみ）は呼び出し側（app/admin/_actions/users.ts）で確認する。
 * - 有効な Administrator が 1 人だけのとき、その人は無効化・降格できない。
 *   確認と更新は同じ書き込みトランザクションで行い、同時操作で 0 人にならないようにする。
 * - 無効化・降格では session_version を 1 増やし、開いている画面の次の操作を拒否させる（lib/auth.ts の照合）。
 * - パスワードは lib/password.ts でハッシュ化して保存する。
 */
import { and, asc, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import { nowSeconds, users } from "../../db/schema";
import type { Role } from "../auth";
import { hashPassword } from "../password";

export const PASSWORD_MIN_LENGTH = 12;

export type UserErrorCode = "invalid_input" | "not_found" | "email_taken" | "last_administrator";

export class UserServiceError extends Error {
  constructor(
    readonly code: UserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UserServiceError";
  }
}

const roleSchema = z.enum(["staff", "administrator"], "役割を選んでください");

export const userCreateSchema = z.object({
  email: z
    .string("メールアドレスを入力してください")
    .trim()
    .toLowerCase()
    .regex(/^[^\s@]+@[^\s@]+$/, "メールアドレスが正しくありません")
    .max(254, "メールアドレスが長すぎます"),
  name: z.string("名前を入力してください").trim().min(1, "名前を入力してください").max(100, "名前は100文字以内で入力してください"),
  role: roleSchema,
  password: z
    .string("パスワードを入力してください")
    .min(PASSWORD_MIN_LENGTH, `パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`)
    .max(200, "パスワードは200文字以内にしてください"),
});

export type UserCreateInput = z.input<typeof userCreateSchema>;

export type UserSummary = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  isActive: boolean;
  createdAt: number;
};

const summaryColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
};

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new UserServiceError("invalid_input", result.error.issues[0]?.message ?? "入力内容を確かめてください");
  }
  return result.data;
}

const notFound = () => new UserServiceError("not_found", "ユーザーが見つかりません。画面を読み込み直してください");
const lastAdministrator = () =>
  new UserServiceError("last_administrator", "最後の管理者は無効にしたり役割を変えたりできません");

/** 一覧（登録順）。パスワードハッシュ・ログイン失敗回数は返さない */
export async function listUsers(db: Db): Promise<UserSummary[]> {
  return db.select(summaryColumns).from(users).orderBy(asc(users.createdAt), asc(users.email));
}

export async function createUser(db: Db, input: unknown): Promise<UserSummary> {
  const data = parse(userCreateSchema, input);
  const passwordHash = await hashPassword(data.password);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, data.email));
    if (existing) throw new UserServiceError("email_taken", "このメールアドレスはすでに登録されています");
    const [row] = await tx
      .insert(users)
      .values({ email: data.email, name: data.name, role: data.role, passwordHash })
      .returning(summaryColumns);
    return row;
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 対象以外に有効な Administrator がいるか */
async function hasOtherActiveAdministrator(tx: Tx, userId: string): Promise<boolean> {
  const [{ n }] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "administrator"), eq(users.isActive, true), ne(users.id, userId)));
  return n > 0;
}

/** 役割を変える。降格は session_version を上げる。最後の有効な Administrator は降格できない */
export async function changeUserRole(db: Db, userId: string, role: unknown): Promise<UserSummary> {
  const next = parse(roleSchema, role);
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound();
    if (user.role === next) return pick(user);

    const demoting = user.role === "administrator";
    if (demoting && user.isActive && !(await hasOtherActiveAdministrator(tx, userId))) throw lastAdministrator();

    const [updated] = await tx
      .update(users)
      .set({
        role: next,
        sessionVersion: demoting ? user.sessionVersion + 1 : user.sessionVersion,
        updatedAt: nowSeconds(),
      })
      .where(eq(users.id, userId))
      .returning(summaryColumns);
    return updated;
  });
}

/** 無効化・再有効化。無効化は session_version を上げる。最後の有効な Administrator は無効化できない */
export async function setUserActive(db: Db, userId: string, active: boolean): Promise<UserSummary> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound();
    if (user.isActive === active) return pick(user);

    if (!active && user.role === "administrator" && !(await hasOtherActiveAdministrator(tx, userId))) {
      throw lastAdministrator();
    }

    const [updated] = await tx
      .update(users)
      .set({
        isActive: active,
        sessionVersion: active ? user.sessionVersion : user.sessionVersion + 1,
        updatedAt: nowSeconds(),
      })
      .where(eq(users.id, userId))
      .returning(summaryColumns);
    return updated;
  });
}

function pick(user: typeof users.$inferSelect): UserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}
