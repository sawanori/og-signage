"""
生成AI（GPT Image 2）で作った原寸画像を、public/fixtures/ の各ファイルと同じ
ピクセルサイズ・同じ形式(jpg/png)に「中身を覆うように拡大して切り抜く（cover）」
方式で書き出す。

現在のサンプル写真は本スクリプトで生成画像から作る。
旧来の tests/visual/extract-fixtures.py（モック画像からの切り出し）はもう使わない。

やり方:
- 各原寸画像について、出力先ごとの目標サイズにアスペクト比を合わせて
  拡大（LANCZOS）し、はみ出した分を切り捨てる（cover fit）。
- どちらの辺をトリミングするかは、FOCUS の (fx, fy)（元画像内の被写体中心、
  0〜1の割合）が切り抜き後もなるべく中心に残るように決める。
- 出力は JPEG quality=88（決め打ちの引数のみで再現するため、何度実行しても
  同じ結果になる）。

実行:
    python3 tests/visual/apply-generated-fixtures.py [原寸画像フォルダ]

引数省略時のフォルダ: /Volumes/DB/illustration_design/og-signage-fixtures
（pizza.webp / movie.webp / bbq.webp / english.webp / coffee.webp /
  notice_plant.webp / footer_mountains.webp / sidebar_plant.webp /
  avatar.webp / vid_welcome.webp / vid_house.webp / vid_notice.webp）
"""
import argparse
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "public" / "fixtures"

DEFAULT_SRC_DIR = Path("/Volumes/DB/illustration_design/og-signage-fixtures")

JPEG_QUALITY = 88

# 各原寸画像の「被写体の中心」(0〜1の割合、元画像基準)。
# cover 切り抜きで水平/垂直どちらかにトリミングが発生する場合、この点が
# 切り抜き後もなるべく中心に残るように配置を決める。
FOCUS = {
    # 主イベントのピザ: 横型・縦型とも画面幅は全部使われる(左が暗いボケ、
    # 右がチーズの伸びるピザ)。小さなサムネイルだけ横方向のトリミングが
    # 起きるので、右寄りの構図をそのまま活かす。
    "pizza": (0.78, 0.44),
    "movie": (0.5, 0.35),  # テレビ画面(海の映像)を帯の中心に残す
    "bbq": (0.5, 0.48),  # 焼き網の中心
    "english": (0.5, 0.55),  # 人物の顔の高さ
    "coffee": (0.5, 0.5),  # ケトルで注いでいる手元
    "notice_plant": (0.35, 0.55),  # 鉢植え(画面やや左寄りにある)
    "footer_mountains": (0.5, 0.62),  # 空〜山並みの帯
    "sidebar_plant": (0.5, 0.46),  # 観葉植物
    "avatar": (0.5, 0.5),  # 正方形同士なのでトリミングは発生しない
    "vid_welcome": (0.5, 0.42),
    "vid_house": (0.5, 0.42),
    "vid_notice": (0.5, 0.42),
}

SOURCE_FILES = {
    "pizza": "pizza.webp",
    "movie": "movie.webp",
    "bbq": "bbq.webp",
    "english": "english.webp",
    "coffee": "coffee.webp",
    "notice_plant": "notice_plant.webp",
    "footer_mountains": "footer_mountains.webp",
    "sidebar_plant": "sidebar_plant.webp",
    "avatar": "avatar.webp",
    "vid_welcome": "vid_welcome.webp",
    "vid_house": "vid_house.webp",
    "vid_notice": "vid_notice.webp",
}

# source_id -> [(public/fixtures/ からの相対パス, 幅, 高さ), ...]
# サイズは差し替え前の public/fixtures/** と同じピクセル数(維持する対象)。
TARGETS = {
    "pizza": [
        ("portrait/med_pizza.jpg", 1008, 646),
        ("landscape/med_pizza.jpg", 1231, 614),
        ("dashboard/evt-pizza.jpg", 101, 68),
        ("dashboard/today-pizza.jpg", 117, 92),
    ],
    "movie": [
        ("portrait/med_movie.jpg", 348, 113),
        ("landscape/med_movie.jpg", 163, 101),
        ("dashboard/evt-movie.jpg", 101, 68),
    ],
    "bbq": [
        ("portrait/med_bbq.jpg", 348, 117),
        ("landscape/med_bbq.jpg", 163, 104),
        ("dashboard/evt-bbq.jpg", 101, 69),
    ],
    "english": [
        ("portrait/med_english.jpg", 348, 120),
        ("landscape/med_english.jpg", 163, 109),
        ("dashboard/evt-english.jpg", 101, 69),
    ],
    "coffee": [
        ("portrait/med_coffee.jpg", 348, 122),
        ("landscape/med_coffee.jpg", 163, 109),
        ("dashboard/evt-coffee.jpg", 101, 68),
    ],
    "notice_plant": [
        ("portrait/med_notice.jpg", 98, 99),
        ("landscape/med_notice.jpg", 99, 92),
    ],
    "footer_mountains": [
        ("portrait/med_footer.jpg", 1080, 150),
    ],
    "sidebar_plant": [
        ("dashboard/sidebar-plant.jpg", 233, 288),
    ],
    "avatar": [
        ("dashboard/avatar.jpg", 50, 50),
    ],
    "vid_welcome": [
        ("dashboard/vid-welcome.jpg", 104, 47),
    ],
    "vid_house": [
        ("dashboard/vid-house.jpg", 104, 47),
    ],
    "vid_notice": [
        ("dashboard/vid-notice.jpg", 103, 47),
    ],
}


def cover_crop(img: Image.Image, target_w: int, target_h: int, focus: tuple[float, float]) -> Image.Image:
    """中身を覆うように拡大して、focus が中心に残るように target_w x target_h へ切り抜く。"""
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    scaled_w = max(target_w, round(src_w * scale))
    scaled_h = max(target_h, round(src_h * scale))
    resized = img.resize((scaled_w, scaled_h), Image.LANCZOS)

    fx, fy = focus
    anchor_x = fx * scaled_w
    anchor_y = fy * scaled_h

    left = anchor_x - target_w / 2
    top = anchor_y - target_h / 2
    left = min(max(left, 0), scaled_w - target_w)
    top = min(max(top, 0), scaled_h - target_h)

    left, top = round(left), round(top)
    box = (left, top, left + target_w, top + target_h)
    return resized.crop(box)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "src_dir",
        nargs="?",
        type=Path,
        default=DEFAULT_SRC_DIR,
        help="生成済み原寸画像(pizza.webp 等)が置かれたフォルダ",
    )
    args = parser.parse_args()
    src_dir: Path = args.src_dir

    if not src_dir.is_dir():
        print(f"エラー: 原寸画像フォルダが見つかりません: {src_dir}", file=sys.stderr)
        sys.exit(1)

    for source_id, filename in SOURCE_FILES.items():
        src_path = src_dir / filename
        if not src_path.is_file():
            print(f"エラー: 原寸画像が見つかりません: {src_path}", file=sys.stderr)
            sys.exit(1)
        img = Image.open(src_path).convert("RGB")
        focus = FOCUS[source_id]
        for rel_path, w, h in TARGETS[source_id]:
            out_path = OUT / rel_path
            out_path.parent.mkdir(parents=True, exist_ok=True)
            cropped = cover_crop(img, w, h, focus)
            cropped.save(out_path, quality=JPEG_QUALITY)
            print(f"{source_id}: {rel_path} ({w}x{h})")

    print("done")


if __name__ == "__main__":
    main()
