// @vitest-environment jsdom
/**
 * 新しい版が出たら表示中のサイネージを読み直す（app/signage/reload-on-new-build.ts。2026-09-27 ユーザー指示）。
 * 版が分からないとき・同じ版のときは読み直さず、同じ版への読み直しは 1 回だけ（読み直しても古いページが返ったときに繰り返さない）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadIfNewBuild, shouldReload } from "@/app/signage/reload-on-new-build";

afterEach(() => window.sessionStorage.clear());

describe("shouldReload", () => {
  it("サーバーの版がこのページと違い、まだその版へ読み直していなければ読み直す", () => {
    expect(shouldReload("aaa", "bbb", null)).toBe(true);
  });

  it("同じ版・どちらかの版が分からない・その版へはもう読み直した、のどれかなら読み直さない", () => {
    expect(shouldReload("aaa", "aaa", null)).toBe(false);
    expect(shouldReload(null, "bbb", null)).toBe(false);
    expect(shouldReload("aaa", null, null)).toBe(false);
    expect(shouldReload("aaa", "", null)).toBe(false);
    expect(shouldReload("aaa", "bbb", "bbb")).toBe(false);
  });
});

describe("reloadIfNewBuild", () => {
  it("新しい版なら 1 回だけ読み直す。次の新しい版にはまた読み直す", () => {
    const reload = vi.fn();
    expect(reloadIfNewBuild("bbb", "aaa", reload)).toBe(true);
    // 読み直しても古いページ（aaa）が返ってきた場合。同じ bbb へは繰り返さない
    expect(reloadIfNewBuild("bbb", "aaa", reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadIfNewBuild("ccc", "aaa", reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("同じ版なら読み直さない", () => {
    const reload = vi.fn();
    expect(reloadIfNewBuild("aaa", "aaa", reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("このページの版が埋め込まれていない（テストや手元の古いビルド）なら読み直さない", () => {
    const reload = vi.fn();
    expect(reloadIfNewBuild("bbb", null, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
