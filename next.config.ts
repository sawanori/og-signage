import type { NextConfig } from "next";

/**
 * vinext は multipart/form-data の POST を行き先に関係なく Server Action の候補として扱い、本文がこの上限を
 * 超えると API に届く前に素の文字の 413「Payload Too Large」を返す
 * （node_modules/vinext/dist/server/app-server-action-execution.js の handleProgressiveServerActionRequest）。
 * メンバー本人登録（/api/spotlight-submissions）は写真・ロゴ込みで最大 5MiB を受けるため、既定の 1MB から上げる
 * （2026-10-01。スマホから写真付きで送ると「送信できたか確認できません」になっていた）。
 */
const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
