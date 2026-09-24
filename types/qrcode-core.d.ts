/**
 * qrcode の中核モジュール（lib/core/qrcode.js）の型。
 * パッケージ入口は Workers で落ちるため中核を直接読む（components/signage/parts.tsx 参照）。
 * 型は @types/qrcode の create をそのまま使う。
 */
declare module "qrcode/lib/core/qrcode" {
  export { create } from "qrcode";
}
