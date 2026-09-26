/**
 * サイネージで流せる動画の要件（2026-09-26 ユーザー指示: 規格外の動画は、足りない要件をすべて並べて断る）。
 * ブラウザ（アップロードを始める前。lib/client/upload.ts）とサーバー（完了時。lib/services/media.ts）が同じ表で判定する。
 *
 * 要件: MP4・H.264（4:2:0・8bit）か H.265（4:2:0・8/10bit）・1920×1080 以下（縦は 1080×1920 以下）・30fps 以下・
 * 長さと大きさの上限（lib/file-sniff.ts の MAX_VIDEO_SECONDS・MAX_VIDEO_MB。2026-09-26 から 30 秒・18MB）。
 */
import { MAX_VIDEO_MB, MAX_VIDEO_SECONDS, MEDIA_MAX_BYTES, isVideoTooLong } from "./file-sniff";
import type { VideoCodecInfo } from "./services/media";

/** 判定に使う動画の事実（ブラウザが MP4 から読んだもの） */
export type VideoFacts = {
  fileSize: number;
  durationSeconds: number | null | undefined;
  codecInfo: VideoCodecInfo | null | undefined;
};

const CODEC_NAMES: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "H.265",
  hev1: "H.265",
  vp09: "VP9",
  av01: "AV1",
  mp4v: "MPEG-4",
};

const isH264 = (codec: string) => codec === "avc1" || codec === "avc3";
const isH265 = (codec: string) => codec === "hvc1" || codec === "hev1";

/** 小数は 2 桁までで、末尾の 0 は出さない（29.97・30） */
const trim = (n: number) => String(Number(n.toFixed(2)));

/** 映像そのもの（コーデック・解像度・フレームレート・色）の足りない点 */
export function videoCodecViolations(info: VideoCodecInfo | null | undefined): string[] {
  if (!info) return ["映像: 読み取れませんでした（H.264 か H.265 の映像が入った MP4 にしてください）"];
  const problems: string[] = [];
  const codecName = CODEC_NAMES[info.codec] ?? info.codec;
  const h264 = isH264(info.codec);
  const h265 = isH265(info.codec);
  if (!h264 && !h265) problems.push(`圧縮形式（コーデック）: ${codecName}（H.264 か H.265 にしてください）`);

  const shortSide = Math.min(info.width, info.height);
  const longSide = Math.max(info.width, info.height);
  if (shortSide > 1080 || longSide > 1920) {
    problems.push(`解像度: ${info.width}×${info.height}（1920×1080 以下、縦長なら 1080×1920 以下にしてください）`);
  }

  if (info.fps === null) problems.push("フレームレート: 読み取れませんでした（30fps 以下で書き出してください）");
  else if (info.fps > 30.01) problems.push(`フレームレート: ${trim(info.fps)}fps（30fps 以下にしてください）`);

  if (h264) {
    if (info.chromaFormat !== "4:2:0") {
      problems.push(`色の形式: ${info.chromaFormat ?? "読み取れませんでした"}（4:2:0 にしてください。書き出しの設定の yuv420p）`);
    }
    if (info.bitDepth !== 8) {
      problems.push(
        `色の深さ: ${info.bitDepth === null ? "読み取れませんでした" : `${info.bitDepth}bit`}（H.264 は 8bit にしてください）`,
      );
    }
  }
  if (h265) {
    if (info.chromaFormat !== null && info.chromaFormat !== "4:2:0") {
      problems.push(`色の形式: ${info.chromaFormat}（4:2:0 にしてください。書き出しの設定の yuv420p）`);
    }
    if (info.bitDepth !== null && info.bitDepth !== 8 && info.bitDepth !== 10) {
      problems.push(`色の深さ: ${info.bitDepth}bit（H.265 は 8bit か 10bit にしてください）`);
    }
  }
  return problems;
}

/** 動画の足りない点をすべて（大きさ・長さ・映像）。空なら要件を満たしている */
export function videoRequirementViolations(facts: VideoFacts): string[] {
  const problems: string[] = [];
  if (facts.fileSize > MEDIA_MAX_BYTES.video) {
    problems.push(
      `ファイルの大きさ: ${(facts.fileSize / 1_000_000).toFixed(1)}MB（${MAX_VIDEO_MB}MB 以下にしてください。${MAX_VIDEO_SECONDS} 秒の 1920×1080 なら書き出しのビットレートを 4Mbps 程度に）`,
    );
  }
  if (facts.durationSeconds === null || facts.durationSeconds === undefined) {
    problems.push("長さ: 読み取れませんでした（MP4 の動画にしてください）");
  } else if (isVideoTooLong(facts.durationSeconds)) {
    problems.push(`長さ: ${trim(facts.durationSeconds)} 秒（${MAX_VIDEO_SECONDS} 秒以内にしてください）`);
  }
  return [...problems, ...videoCodecViolations(facts.codecInfo)];
}

/** 足りない点を並べた、利用者向けの文 */
export function videoRequirementMessage(problems: readonly string[]): string {
  return `この動画はサイネージの規格に合っていないため、アップロードできません。次の点を直して書き出し直してください。\n${problems
    .map((p) => `・${p}`)
    .join("\n")}`;
}
