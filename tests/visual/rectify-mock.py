"""
モック写真（image/UI-V.png・UI-H.png）から画面部分だけを透視変換で平面化し、
表示キャンバスと同じ解像度（1080x1920 / 1920x1080）の比較基準画像を作る。

四隅の座標は明暗の境目を各辺で数十点測って直線を当てはめ、その交点から求めた値（2026-09-24 実測）。
実行: python3 tests/visual/rectify-mock.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "reference"

# (左上, 右上, 右下, 左下) の画面の角（モック画像の画素座標）
MOCKS = {
    "portrait": ("image/UI-V.png", [(152.0, 41.0), (875.5, 21.8), (876.0, 1509.5), (151.0, 1487.5)], (1080, 1920)),
    "landscape": ("image/UI-H.png", [(25.0, 52.5), (1513.0, 52.0), (1514.5, 951.0), (24.5, 951.0)], (1920, 1080)),
}


def perspective_coeffs(dst, src):
    """出力座標 dst の四隅を入力座標 src の四隅へ写す 8 係数（PIL の PERSPECTIVE 用）"""
    rows = []
    for (x, y), (u, v) in zip(dst, src):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    a = np.array(rows, dtype=float)
    b = np.array(src, dtype=float).reshape(8)
    return np.linalg.solve(a, b).tolist()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (path, corners, (w, h)) in MOCKS.items():
        src = Image.open(ROOT / path).convert("RGB")
        dst = [(0, 0), (w, 0), (w, h), (0, h)]
        coeffs = perspective_coeffs(dst, corners)
        flat = src.transform((w, h), Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC)
        flat.save(OUT / f"mock-{name}.png")
        print(f"{name}: {OUT / f'mock-{name}.png'}")


if __name__ == "__main__":
    main()
