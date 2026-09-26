/**
 * 動画の規格（lib/video-requirements.ts）。規格外の動画は、足りない点をすべて並べて断る（2026-09-26 ユーザー指示）。
 * 映像の条件は isPlayable と同じ表（tests/services/media.test.ts の isPlayable の表でも確かめる）。
 */
import { describe, expect, it } from "vitest";
import type { VideoCodecInfo } from "../../lib/services/media";
import { videoCodecViolations, videoRequirementMessage, videoRequirementViolations } from "../../lib/video-requirements";

const MB = 1024 * 1024;
const H264_1080P: VideoCodecInfo = {
  container: "mp4",
  codec: "avc1",
  profile: 100,
  level: 40,
  width: 1920,
  height: 1080,
  fps: 30,
  chromaFormat: "4:2:0",
  bitDepth: 8,
};
const OK = { fileSize: 18 * MB, durationSeconds: 30.4, codecInfo: H264_1080P };

describe("videoRequirementViolations", () => {
  it("規格どおり（18MB ちょうど・30 秒と書き出しの端数・1080p・30fps・4:2:0・8bit）なら何も出ない", () => {
    expect(videoRequirementViolations(OK)).toEqual([]);
    expect(videoRequirementViolations({ ...OK, durationSeconds: 30.5 })).toEqual([]);
  });

  it("縦長の 1080×1920・29.97fps・H.265 の 10bit も通す", () => {
    expect(videoCodecViolations({ ...H264_1080P, width: 1080, height: 1920, fps: 29.97 })).toEqual([]);
    expect(videoCodecViolations({ ...H264_1080P, codec: "hvc1", bitDepth: 10 })).toEqual([]);
    expect(videoCodecViolations({ ...H264_1080P, codec: "hev1", chromaFormat: null, bitDepth: null })).toEqual([]);
  });

  it("足りない点をすべて、1 点ずつ並べる", () => {
    const problems = videoRequirementViolations({
      fileSize: 25_300_000,
      durationSeconds: 32.5,
      codecInfo: { ...H264_1080P, width: 3840, height: 2160, fps: 59.94, chromaFormat: "4:2:2", bitDepth: 10 },
    });
    expect(problems).toEqual([
      "ファイルの大きさ: 25.3MB（18MB 以下にしてください。30 秒の 1920×1080 なら書き出しのビットレートを 4Mbps 程度に）",
      "長さ: 32.5 秒（30 秒以内にしてください）",
      "解像度: 3840×2160（1920×1080 以下、縦長なら 1080×1920 以下にしてください）",
      "フレームレート: 59.94fps（30fps 以下にしてください）",
      "色の形式: 4:2:2（4:2:0 にしてください。書き出しの設定の yuv420p）",
      "色の深さ: 10bit（H.264 は 8bit にしてください）",
    ]);
  });

  it("大きさは 18MB（18×1024×1024 バイト）を 1 バイトでも超えたら断る", () => {
    expect(videoRequirementViolations({ ...OK, fileSize: 18 * MB + 1 })).toEqual([
      "ファイルの大きさ: 18.9MB（18MB 以下にしてください。30 秒の 1920×1080 なら書き出しのビットレートを 4Mbps 程度に）",
    ]);
  });

  it("長さは 30 秒と書き出しの端数 0.5 秒まで。読み取れなければ断る", () => {
    expect(videoRequirementViolations({ ...OK, durationSeconds: 30.51 })).toEqual(["長さ: 30.51 秒（30 秒以内にしてください）"]);
    expect(videoRequirementViolations({ ...OK, durationSeconds: null })).toEqual(["長さ: 読み取れませんでした（MP4 の動画にしてください）"]);
    expect(videoRequirementViolations({ ...OK, durationSeconds: undefined })).toHaveLength(1);
  });

  it("映像が読み取れなければ、その 1 点だけを出す（解像度などは確かめようがない）", () => {
    expect(videoRequirementViolations({ ...OK, codecInfo: null })).toEqual([
      "映像: 読み取れませんでした（H.264 か H.265 の映像が入った MP4 にしてください）",
    ]);
  });

  it("H.264・H.265 以外のコーデックは、分かる名前で出す", () => {
    expect(videoCodecViolations({ ...H264_1080P, codec: "vp09" })).toEqual([
      "圧縮形式（コーデック）: VP9（H.264 か H.265 にしてください）",
    ]);
    expect(videoCodecViolations({ ...H264_1080P, codec: "apch" })).toEqual([
      "圧縮形式（コーデック）: apch（H.264 か H.265 にしてください）",
    ]);
  });

  it("フレームレートが読み取れなければ断る", () => {
    expect(videoCodecViolations({ ...H264_1080P, fps: null })).toEqual([
      "フレームレート: 読み取れませんでした（30fps 以下で書き出してください）",
    ]);
  });

  it("H.264 は色の形式・色の深さが読み取れなくても断る。H.265 は 4:2:2・12bit を断る", () => {
    expect(videoCodecViolations({ ...H264_1080P, chromaFormat: null, bitDepth: null })).toEqual([
      "色の形式: 読み取れませんでした（4:2:0 にしてください。書き出しの設定の yuv420p）",
      "色の深さ: 読み取れませんでした（H.264 は 8bit にしてください）",
    ]);
    expect(videoCodecViolations({ ...H264_1080P, codec: "hvc1", chromaFormat: "4:2:2", bitDepth: 12 })).toEqual([
      "色の形式: 4:2:2（4:2:0 にしてください。書き出しの設定の yuv420p）",
      "色の深さ: 12bit（H.265 は 8bit か 10bit にしてください）",
    ]);
  });
});

describe("videoRequirementMessage", () => {
  it("断る理由の後に、足りない点を 1 行ずつ「・」で並べる", () => {
    expect(videoRequirementMessage(["長さ: 40 秒（30 秒以内にしてください）", "フレームレート: 60fps（30fps 以下にしてください）"])).toBe(
      "この動画はサイネージの規格に合っていないため、アップロードできません。次の点を直して書き出し直してください。\n" +
        "・長さ: 40 秒（30 秒以内にしてください）\n" +
        "・フレームレート: 60fps（30fps 以下にしてください）",
    );
  });
});
