import { describe, expect, it } from "vitest";
import { canViewCompanyResearch } from "../../lib/company-research-viewer";

describe("企業データを見られるアカウント", () => {
  it("許可したメールアドレスだけ（大文字小文字と前後の空白は区別しない）", () => {
    expect(canViewCompanyResearch("snp.inc.info@gmail.com", "snp.inc.info@gmail.com")).toBe(true);
    expect(canViewCompanyResearch("SNP.Inc.Info@gmail.com", " other@example.com , snp.inc.info@gmail.com ")).toBe(true);
    expect(canViewCompanyResearch("staff@example.com", "snp.inc.info@gmail.com")).toBe(false);
    expect(canViewCompanyResearch("snp.inc.info@gmail.com.evil.example", "snp.inc.info@gmail.com")).toBe(false);
  });
  it("設定が無ければ誰も見られない", () => {
    expect(canViewCompanyResearch("snp.inc.info@gmail.com", undefined)).toBe(false);
    expect(canViewCompanyResearch("", "")).toBe(false);
  });
});
