// @vitest-environment jsdom
/**
 * ダッシュボードの定期動画カード（components/admin/video-settings-card.tsx）。
 * 再生リストは動画 3 本とスライドショー 1 つまでなので、4 つまで並べ、4 つ埋まったら「動画を追加」の枠は出さない。
 * スライドショーは「スライドショー」と写真の秒数の合計で 1 つの項目として出る（形は load-dashboard.ts の toDashboardVideos）。
 * Server Actions・画面遷移は差し替える。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardVideo, DashboardVideoSettings } from "@/components/admin/dashboard-types";

const actions = vi.hoisted(() => ({ requestTestPlayAction: vi.fn(), updateDevicePlaybackSettingsAction: vi.fn() }));
vi.mock("@/app/admin/_actions/playback", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { VideoSettingsCard } from "@/components/admin/video-settings-card";

const video = (n: number): DashboardVideo => ({ mediaId: `vid_${n}`, name: `video${n}.mp4`, durationSeconds: 20, thumbnailUrl: null });
const slideshow: DashboardVideo = { mediaId: "img_1", name: "スライドショー", durationSeconds: 15, thumbnailUrl: "/api/media/img_1/thumbnail" };

function settings(videos: DashboardVideo[]): DashboardVideoSettings {
  return { deviceId: "dev_1", revision: 1, enabled: true, intervalMinutes: 10, mode: "sequence", volume: 0, videos, nextVideoAt: null, observedAt: null };
}

afterEach(cleanup);

describe("VideoSettingsCard の再生リストの並び", () => {
  it("動画 3 本とスライドショーの 4 つをすべて並べ、「動画を追加」の枠は出さない", () => {
    render(<VideoSettingsCard video={settings([video(1), slideshow, video(2), video(3)])} />);
    const names = screen.getAllByRole("button", { name: /をサイネージで再生$/ }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["video1.mp4 をサイネージで再生", "スライドショー をサイネージで再生", "video2.mp4 をサイネージで再生", "video3.mp4 をサイネージで再生"]);
    expect(screen.getByText("00:15")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "動画を追加" })).toBeNull();
  });

  it("3 つまでなら「動画を追加」の枠を出す", () => {
    render(<VideoSettingsCard video={settings([video(1), slideshow, video(2)])} />);
    expect(screen.getAllByRole("button", { name: /をサイネージで再生$/ })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "動画を追加" }).getAttribute("href")).toBe("/admin/videos");
  });
});
