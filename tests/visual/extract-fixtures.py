"""
開発用 fixture の写真を、平面化したモック（tests/visual/reference/mock-*.png）から切り出して
public/fixtures/<orientation>/<mediaId>.(jpg|png) に保存する。本番データには使わない。

- 写真に焼き込まれた文字（見出し・説明・QR など）は OpenCV の inpaint で消す。
  実装側がその上に同じ文字を描くので、消し跡は隠れる。
- 主イベント写真には実装側で文字を読みやすくする重ね（グラデーション）を掛ける。
  モックは重ねた後の見た目なので、同じ重ねを逆算して外した写真を保存する
  （実装で重ねるとモックと同じ色に戻る）。重ねの値は components/signage/signage.module.css と揃える。

実行: python3 tests/visual/extract-fixtures.py（先に rectify-mock.py を実行しておく）
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "public" / "fixtures"

# 主イベント写真の重ね。(位置 0〜1, 不透明度)。色は RGB
HERO_OVERLAY = {
    "portrait": ((18, 12, 8), [(0.0, 0.62), (0.35, 0.5), (0.65, 0.0), (1.0, 0.0)]),
    "landscape": ((240, 237, 233), [(0.0, 0.55), (0.2, 0.85), (0.3, 0.86), (0.45, 0.55), (0.62, 0.0), (1.0, 0.0)]),
}

# 切り出し範囲 (x0, y0, x1, y1)。キャンバス座標
CROPS = {
    "portrait": {
        "med_pizza": (36, 284, 1044, 930),
        "med_movie": (616, 1018, 964, 1131),
        "med_bbq": (616, 1142, 964, 1259),
        "med_english": (616, 1271, 964, 1391),
        "med_coffee": (616, 1402, 964, 1524),
        "med_notice": (58, 1642, 156, 1741),
        "med_footer": (0, 1770, 1080, 1920),
        "med_logo": (60, 30, 148, 108),
    },
    "landscape": {
        "med_pizza": (0, 138, 1231, 752),
        "med_movie": (1686, 233, 1849, 334),
        "med_bbq": (1686, 355, 1849, 459),
        "med_english": (1685, 480, 1848, 589),
        "med_coffee": (1685, 611, 1848, 720),
        "med_notice": (69, 841, 168, 933),
        "med_logo": (62, 40, 162, 102),
    },
}

# 文字を消す範囲。"light" は明るい文字だけ、"all" は範囲全体を消す（キャンバス座標）
TEXT_MASKS = {
    ("portrait", "med_pizza"): [
        ("all", (58, 303, 276, 393)),  # TODAY バッジ
        ("light", (62, 380, 575, 505)),  # Pizza Night と絵文字
        ("light", (74, 505, 410, 628)),  # 説明
        ("light", (74, 640, 430, 830)),  # 時間・場所・参加・主催
        ("all", (72, 842, 360, 906)),  # ボタン
        ("light", (690, 340, 995, 492)),  # Good Food Good People!
        ("all", (833, 686, 1012, 879)),  # QR
    ],
    ("portrait", "med_footer"): [
        ("light", (35, 1815, 555, 1905)),
        ("light", (775, 1830, 1045, 1900)),
    ],
    ("landscape", "med_pizza"): [
        ("all", (36, 138, 234, 326)),  # TODAY の円
        ("all", (248, 185, 380, 235)),  # カテゴリ
        ("all", (248, 243, 700, 322)),  # Pizza Night と絵文字
        ("all", (248, 336, 760, 400)),  # 説明
        ("all", (248, 424, 535, 616)),  # 時間・場所・参加・主催
        ("all", (247, 646, 508, 716)),  # ボタン
        ("all", (531, 584, 675, 735)),  # QR
        ("light", (895, 165, 1195, 325)),  # Good Food Good People!
    ],
}


def overlay_alpha(width, stops):
    xs = np.linspace(0.0, 1.0, width)
    pos = [p for p, _ in stops]
    val = [a for _, a in stops]
    return np.interp(xs, pos, val)


def remove_text(img, orientation, media_id, box):
    masks = TEXT_MASKS.get((orientation, media_id))
    if not masks:
        return img
    x0, y0 = box[0], box[1]
    arr = np.asarray(img).copy()
    hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    lum = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    mask = np.zeros(arr.shape[:2], np.uint8)
    for kind, (a, b, c, d) in masks:
        a, b, c, d = a - x0, b - y0, c - x0, d - y0
        if kind == "all":
            mask[b:d, a:c] = 255
        else:
            region = (lum[b:d, a:c] > 165) & (hsv[b:d, a:c, 1] < 90)
            mask[b:d, a:c][region] = 255
    mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    out = cv2.inpaint(arr, mask, 6, cv2.INPAINT_TELEA)
    return Image.fromarray(out)


def remove_overlay(img, orientation):
    color, stops = HERO_OVERLAY[orientation]
    arr = np.asarray(img).astype(np.float64)
    alpha = overlay_alpha(arr.shape[1], stops)[None, :, None]
    c = np.array(color, np.float64)[None, None, :]
    safe = np.clip(1.0 - alpha, 0.08, 1.0)
    base = (arr - alpha * c) / safe
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def logo_with_alpha(img):
    """背景を透明にし、線の濃さを不透明度にしたロゴ"""
    gray = np.asarray(img.convert("L")).astype(np.float64)
    bg = np.percentile(gray, 90)
    ink = np.percentile(gray, 2)
    alpha = np.clip(((bg - gray) / max(bg - ink, 1) - 0.18) * 1.35, 0, 1)
    rgba = np.zeros((*gray.shape, 4), np.uint8)
    rgba[..., 0:3] = np.array([27, 36, 48], np.uint8)
    rgba[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def main():
    for orientation, crops in CROPS.items():
        src = Image.open(HERE / "reference" / f"mock-{orientation}.png").convert("RGB")
        out_dir = OUT / orientation
        out_dir.mkdir(parents=True, exist_ok=True)
        for media_id, box in crops.items():
            img = src.crop(box)
            if media_id == "med_logo":
                logo_with_alpha(img).save(out_dir / f"{media_id}.png")
                continue
            img = remove_text(img, orientation, media_id, box)
            if media_id == "med_pizza":
                img = remove_overlay(img, orientation)
            img.save(out_dir / f"{media_id}.jpg", quality=90)
        print(f"{orientation}: {sorted(p.name for p in out_dir.iterdir())}")


if __name__ == "__main__":
    main()
