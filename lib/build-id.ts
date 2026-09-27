/**
 * この版の印（ビルドのときに vite.config.ts が git のコミットを埋め込む）。
 * サーバーは公開サイネージの設定の応答に BUILD_HEADER で付け、表示中のページは自分の印と比べて、
 * 違えば新しい版が出たとみて読み直す（app/signage/reload-on-new-build.ts。2026-09-27 ユーザー指示）。
 * テストなど埋め込みの無いところでは null（読み直さない）
 */
const embedded: unknown = import.meta.env.VITE_BUILD_ID;

export const BUILD_ID: string | null = typeof embedded === "string" && embedded !== "" ? embedded : null;

export const BUILD_HEADER = "X-Signage-Build";
