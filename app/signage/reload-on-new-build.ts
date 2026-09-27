/**
 * 新しい版が出たら、表示中のサイネージを読み直す（2026-09-27 ユーザー指示。Pi で開いたままのページを手で読み直さなくてよいように）。
 * 設定を取り直すたびに、応答に付いたサーバーの版（lib/build-id.ts の BUILD_HEADER）とこのページの版を比べる。
 * 読み直しても版が合わないとき（古いページが返ったなど）に繰り返さないよう、同じ版への読み直しは 1 回だけにする。
 */
import { BUILD_ID } from "@/lib/build-id";

const STORAGE_KEY = "og-signage-reloaded-for";

/** 読み直すか。どちらかの版が分からないとき・同じ版のとき・その版へはもう読み直したときは読み直さない */
export function shouldReload(current: string | null, server: string | null, reloadedFor: string | null): boolean {
  return current !== null && server !== null && server !== "" && server !== current && server !== reloadedFor;
}

/** サーバーの版が新しければ、覚えてから読み直す。読み直したら true */
export function reloadIfNewBuild(
  serverBuild: string | null,
  current: string | null = BUILD_ID,
  reload: () => void = () => window.location.reload(),
): boolean {
  let reloadedFor: string | null = null;
  try {
    reloadedFor = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // 使えない（プライベートモードなど）ときは覚えずに進める
  }
  if (!shouldReload(current, serverBuild, reloadedFor)) return false;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, serverBuild as string);
  } catch {
    // 同上
  }
  reload();
  return true;
}
