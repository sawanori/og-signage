/**
 * ダッシュボードのサイネージプレビューの縦 / 横（2026-09-25 ユーザー指示）。
 * 選んだ向き（cookie）の読み取り、切り替えボタンの状態、選んだ向きでのプレビューの描画。
 * ダッシュボードの並びの切り替えは画面で確かめる（/dev/dashboard?preview=landscape）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NOW, makeConfig } from "../fixtures/config.fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { parsePreviewOrientation } = await import("@/components/admin/preview-orientation");
const { PreviewOrientationToggle } = await import("@/components/admin/preview-orientation-toggle");
const { SignagePreview } = await import("@/components/admin/signage-preview");

const resolve = () => "/media/x";

describe("parsePreviewOrientation", () => {
  it("portrait / landscape だけを受け付け、それ以外は未選択（null）", () => {
    expect(parsePreviewOrientation("portrait")).toBe("portrait");
    expect(parsePreviewOrientation("landscape")).toBe("landscape");
    for (const value of [undefined, null, "", "LANDSCAPE", "square"]) expect(parsePreviewOrientation(value)).toBeNull();
  });
});

describe("PreviewOrientationToggle", () => {
  it("選んでいる向きのボタンが押された状態になる", () => {
    const html = renderToStaticMarkup(<PreviewOrientationToggle value="landscape" />);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?縦/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?横/);
  });
});

describe("SignagePreview", () => {
  it("縦型の端末でも、横を選べば横型で描く", () => {
    const config = makeConfig();
    expect(config.device.orientation).toBe("portrait");
    const html = renderToStaticMarkup(
      <SignagePreview config={config} now={NOW} resolveMediaUrl={resolve} orientation="landscape" />,
    );
    expect(html).toContain('data-testid="signage-preview" data-orientation="landscape"');
    expect(html).toContain('data-orientation="landscape" data-testid="signage-canvas"');
    expect(html).toContain("width:1920px");
  });

  it("向きを渡さなければ端末の向きで描く", () => {
    const html = renderToStaticMarkup(<SignagePreview config={makeConfig()} now={NOW} resolveMediaUrl={resolve} />);
    expect(html).toContain('data-testid="signage-preview" data-orientation="portrait"');
    expect(html).toContain("width:1080px");
  });
});
