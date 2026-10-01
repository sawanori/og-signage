/**
 * vinext は multipart/form-data の POST を Server Action の候補として扱い、next.config.ts の
 * experimental.serverActions.bodySizeLimit を超えると API に届く前に 413 を返す（2026-10-01 本番で発生）。
 * メンバー本人登録の受付上限（写真・ロゴ込み 5MiB）より大きくしておく。
 */
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { SPOTLIGHT_SUBMISSION_MAX_BODY_BYTES } from "@/lib/spotlight-submissions";

describe("next.config の multipart 上限", () => {
  it("本人登録の受付上限より大きい", () => {
    const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;
    // vinext は "6mb" を 6 × 1024 × 1024 バイトと読む（node_modules/vinext/dist/config/next-config.js の parseBodySizeLimit）
    const match = typeof limit === "string" ? /^(\d+)mb$/i.exec(limit) : null;
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 1024 * 1024).toBeGreaterThan(SPOTLIGHT_SUBMISSION_MAX_BODY_BYTES);
  });
});
