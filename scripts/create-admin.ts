/**
 * Administrator を作る。
 * 実行: npm run admin:create -- --email a@example.com --name "名前" --password "..."
 * 接続先は TURSO_DATABASE_URL（未設定なら file:local.db）。
 */
import { createClient } from "@libsql/client";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createDb, type Db } from "../db/index";
import { users } from "../db/schema";
import { hashPassword } from "../lib/password";

export type AdminInput = { email: string; name: string; password: string };

export const PASSWORD_MIN_LENGTH = 12;

export async function createAdmin(db: Db, input: AdminInput): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("メールアドレスが正しくありません");
  if (!input.name.trim()) throw new Error("名前を入力してください");
  if (input.password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`);
  }

  const [row] = await db
    .insert(users)
    .values({
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      role: "administrator",
    })
    .returning({ id: users.id });
  return row.id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" }, password: { type: "string" } },
  });
  if (!values.email || !values.name || !values.password) {
    console.error('使い方: npm run admin:create -- --email <メール> --name <名前> --password <パスワード>');
    process.exit(1);
  }
  const { client, db } = createDb(
    createClient,
    process.env.TURSO_DATABASE_URL ?? "file:local.db",
    process.env.TURSO_AUTH_TOKEN,
  );
  try {
    const id = await createAdmin(db, { email: values.email, name: values.name, password: values.password });
    console.log(`Administrator を作成しました（id: ${id}）`);
  } finally {
    client.close();
  }
}
