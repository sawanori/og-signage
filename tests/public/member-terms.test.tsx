/**
 * メンバー紹介の登録規約（/members/terms。2026-10-03 ユーザー指示）。
 * NonTurn合同会社と登録者の間の約束で、WeWork を運営する WWJ株式会社 は当事者ではないことを載せる。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MemberTermsPage, { metadata } from "@/app/members/terms/page";
import { SPOTLIGHT_SUBMISSION_CONSENT_VERSION } from "@/lib/spotlight-submissions";

describe("登録規約のページ", () => {
  const html = renderToStaticMarkup(<MemberTermsPage />);
  it("当事者は NonTurn合同会社 と登録者で、WWJ株式会社 は当事者でも取扱いの責任者でもないと明記する", () => {
    expect(html).toContain("NonTurn合同会社（以下「当社」）");
    expect(html).toContain("WeWork を運営する WWJ株式会社 は、この規約の当事者ではありません。");
    expect(html).toContain("WWJ株式会社 は、登録された情報の取扱いに関与せず、これについて責任を負いません。");
  });
  it("利用目的・外部サービス・保存期間・ご請求の窓口と管轄を載せる", () => {
    for (const text of ["本サイネージの運用に関連するサービスと、その派生サービス", "Google（Gemini）", "Meta", "7日以内に削除", "横浜地方裁判所", 'href="mailto:m.sawada@non-turn.com"', "2026年10月3日"]) {
      expect(html).toContain(text);
    }
  });
  it("検索に載せず、同意の版はこの規約の版（4）", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(SPOTLIGHT_SUBMISSION_CONSENT_VERSION).toBe(4);
  });
});
