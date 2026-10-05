/**
 * 管理画面の枠のデータ（app/admin/_components/load-dashboard.ts の loadShell）。
 * メンバー本人からの申請（2026-10-01）が確認待ちなら、ベルに件数と「確認待ち」タブへのリンクを出す。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadShell } from "@/app/admin/_components/load-dashboard";
import type { Db } from "@/db/index";
import type { AuthUser } from "@/lib/auth";
import { approveSpotlightSubmission, submitSpotlightSubmission } from "@/lib/services/spotlight-submissions";
import { memberSpotlightSubmissions, users } from "@/db/schema";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

let db: Db;
let close: () => void;
const staff: AuthUser = { id: "staff", email: "staff@example.com", name: "Staff", role: "staff" };
const submit = (bucket: SpotlightBucket) =>
  submitSpotlightSubmission(db, bucket, { requestKey: crypto.randomUUID(), companyName: "所属", personName: "名前", email: "member@example.com", consent: true }, {}, 100);

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(users).values(staff);
});
afterEach(() => close());

describe("loadShell のベルの知らせ", () => {
  it("確認待ちの申請があれば件数と確認待ちタブへのリンクを出し、無くなれば消す", async () => {
    expect((await loadShell(db, staff, 200)).alerts).toEqual([]);

    const bucket = new SpotlightBucket();
    await submit(bucket);
    await submit(bucket);
    expect((await loadShell(db, staff, 200)).alerts).toEqual([
      { id: "spotlight-submissions", message: "メンバー紹介の確認待ちが 2 件あります", href: "/admin/spotlights?tab=pending" },
    ]);

    for (const row of await db.select().from(memberSpotlightSubmissions)) {
      await approveSpotlightSubmission(db, bucket, staff, row.id, 0);
    }
    expect((await loadShell(db, staff, 200)).alerts).toEqual([]);
  });

  it("企業データを見られるアカウント（COMPANY_RESEARCH_VIEWER_EMAILS）だけ、メニューに出す印を付ける", async () => {
    expect((await loadShell(db, staff, 200)).user.canViewCompanyResearch).toBe(false);
    expect((await loadShell(db, { ...staff, email: "viewer@example.com" }, 200)).user.canViewCompanyResearch).toBe(true);
    // 相談チャット（COMPANY_CHAT_EMAILS）も同じ
    expect((await loadShell(db, staff, 200)).user.canUseCompanyChat).toBe(false);
    expect((await loadShell(db, { ...staff, email: "viewer@example.com" }, 200)).user.canUseCompanyChat).toBe(true);
  });
});
