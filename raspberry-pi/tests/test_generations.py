import hashlib
import shutil
from pathlib import Path

import pytest

from agent import generations as gen_mod


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def put_media(gm: gen_mod.GenerationManager, content: bytes) -> gen_mod.ManifestEntry:
    sha = sha256_of(content)
    gm.media_path(sha).write_bytes(content)
    return gen_mod.ManifestEntry(kind="media", key=sha, sha256=sha, size=len(content))


def put_bundle(gm: gen_mod.GenerationManager, bundle_id: str, content: bytes) -> gen_mod.ManifestEntry:
    sha = sha256_of(content)
    path = gm.bundle_archive_path(bundle_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return gen_mod.ManifestEntry(kind="bundle", key=bundle_id, sha256=sha, size=len(content))


def test_directory_layout_created(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    assert gm.media_dir.is_dir()
    assert gm.bundles_dir.is_dir()
    assert gm.generations_dir.is_dir()
    assert gm.state_dir.is_dir()
    assert gm.current_version() is None
    assert gm.previous_version() is None


def test_activate_first_generation_has_no_previous(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    entry = put_media(gm, b"hello world")
    manifest = gen_mod.Manifest(version="v1", entries=(entry,))
    gm.write_generation("v1", {"version": "v1"}, manifest)

    assert gm.is_generation_complete("v1") is True
    gm.activate("v1")

    assert gm.current_version() == "v1"
    assert gm.previous_version() is None
    assert gm.current_link.is_symlink()
    assert gm.current_link.resolve() == gm.generation_dir("v1").resolve()


def test_activate_second_generation_moves_old_current_to_previous(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)

    e1 = put_media(gm, b"content-v1")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (e1,)))
    gm.activate("v1")

    e2 = put_media(gm, b"content-v2")
    gm.write_generation("v2", {"version": "v2"}, gen_mod.Manifest("v2", (e1, e2)))
    gm.activate("v2")

    assert gm.current_version() == "v2"
    assert gm.previous_version() == "v1"


def test_is_generation_complete_false_when_media_missing(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    missing_entry = gen_mod.ManifestEntry(kind="media", key="deadbeef", sha256="deadbeef", size=10)
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (missing_entry,)))

    assert gm.is_generation_complete("v1") is False
    with pytest.raises(gen_mod.GenerationError):
        gm.activate("v1")
    assert gm.current_version() is None


def test_is_generation_complete_false_when_size_mismatch(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    content = b"abc"
    sha = sha256_of(content)
    gm.media_path(sha).write_bytes(content)
    wrong_size_entry = gen_mod.ManifestEntry(kind="media", key=sha, sha256=sha, size=999)
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (wrong_size_entry,)))

    assert gm.is_generation_complete("v1") is False


def test_has_enough_space_respects_reserve(data_dir: Path, monkeypatch):
    gm = gen_mod.GenerationManager(data_dir, reserve_bytes=1000)
    entry = gen_mod.ManifestEntry(kind="media", key="a" * 64, sha256="a" * 64, size=500)
    manifest = gen_mod.Manifest("v1", (entry,))

    class FakeUsage:
        free = 2000

    monkeypatch.setattr(gen_mod.shutil, "disk_usage", lambda path: FakeUsage())
    assert gm.has_enough_space(manifest) is True  # 2000 - 500 >= 1000

    class LowUsage:
        free = 1200

    monkeypatch.setattr(gen_mod.shutil, "disk_usage", lambda path: LowUsage())
    assert gm.has_enough_space(manifest) is False  # 1200 - 500 < 1000


def test_ensure_valid_current_falls_back_to_previous_when_current_corrupted(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)

    e1 = put_media(gm, b"content-v1")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (e1,)))
    gm.activate("v1")

    e2 = put_media(gm, b"content-v2")
    gm.write_generation("v2", {"version": "v2"}, gen_mod.Manifest("v2", (e1, e2)))
    gm.activate("v2")

    assert gm.current_version() == "v2"
    assert gm.previous_version() == "v1"

    # v2 の media を壊す（削除）＝現行世代が壊れている状態を再現する
    gm.media_path(e2.sha256).unlink()
    assert gm.is_generation_complete("v2") is False

    restored = gm.ensure_valid_current()

    assert restored == "v1"
    assert gm.current_version() == "v1"


def test_ensure_valid_current_returns_none_when_nothing_valid(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    assert gm.ensure_valid_current() is None


def test_interrupted_before_activate_leaves_no_current(data_dir: Path):
    """generations/<version> を書いただけで中断した場合、current/previous は一切変化しない。"""
    gm = gen_mod.GenerationManager(data_dir)
    entry = put_media(gm, b"partial world")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (entry,)))
    # activate() を呼ばずに「電源断」したことを模す

    assert gm.current_version() is None
    assert gm.previous_version() is None
    # 次回起動時の検査でも、まだ current に何も紐付いていないので None のまま
    assert gm.ensure_valid_current() is None


def test_interrupted_during_download_keeps_old_generation_active(data_dir: Path):
    """新世代のダウンロード中（manifest はあるがファイルが未完）に中断しても、
    旧世代がそのまま現行世代として使われ続ける。"""
    gm = gen_mod.GenerationManager(data_dir)
    e1 = put_media(gm, b"content-v1")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (e1,)))
    gm.activate("v1")

    missing_entry = gen_mod.ManifestEntry(kind="media", key="f" * 64, sha256="f" * 64, size=100)
    gm.write_generation("v2", {"version": "v2"}, gen_mod.Manifest("v2", (e1, missing_entry)))
    # v2 はまだ不完全なので activate は呼ばれない（sync.py の挙動を模している）

    assert gm.current_version() == "v1"
    assert gm.ensure_valid_current() == "v1"


def test_crash_between_current_and_previous_swap_still_yields_valid_current(data_dir: Path):
    """activate() は current の付け替え → previous の付け替え、の2段階からなる。
    1段階目の直後にクラッシュしたと仮定しても、current 自体は完全な世代を指しているので
    次回起動時の検査は問題なく通る（previous が一世代古いままなだけ）。"""
    gm = gen_mod.GenerationManager(data_dir)
    e1 = put_media(gm, b"content-v1")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (e1,)))
    gm.activate("v1")

    e2 = put_media(gm, b"content-v2")
    gm.write_generation("v2", {"version": "v2"}, gen_mod.Manifest("v2", (e1, e2)))

    # activate() の第1段階（current の付け替え）だけを実行し、
    # 第2段階（previous の付け替え）の前でクラッシュしたことを模す。
    gm._atomic_symlink(gm.current_link, gm.generation_dir("v2"))

    assert gm.current_version() == "v2"
    assert gm.previous_version() is None  # 古いまま（この時点では previous 未設定）
    assert gm.ensure_valid_current() == "v2"


def test_prune_unreferenced_removes_orphans_but_keeps_current_and_previous(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)

    e1 = put_media(gm, b"content-v1")
    b1 = put_bundle(gm, "bundleA", b"bundle-a-content")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (e1, b1)))
    gm.activate("v1")

    e2 = put_media(gm, b"content-v2")
    b2 = put_bundle(gm, "bundleB", b"bundle-b-content")
    gm.write_generation("v2", {"version": "v2"}, gen_mod.Manifest("v2", (e2, b2)))
    gm.activate("v2")

    # v1 は previous として生きているので、e1/b1 は残るはず。
    # v1 より前の世代の残骸を模して、参照されていない media/bundle を追加する。
    orphan = put_media(gm, b"orphan-content")
    orphan_bundle_dir = gm.bundle_dir("orphanBundle")
    orphan_bundle_dir.mkdir(parents=True, exist_ok=True)
    (orphan_bundle_dir / "bundle.zip").write_bytes(b"orphan-bundle")

    gm.prune_unreferenced()

    assert gm.media_path(e1.sha256).exists()  # previous (v1) から参照
    assert gm.media_path(e2.sha256).exists()  # current (v2) から参照
    assert gm.bundle_archive_path("bundleA").exists()
    assert gm.bundle_archive_path("bundleB").exists()

    assert not gm.media_path(orphan.sha256).exists()
    assert not gm.bundle_dir("orphanBundle").exists()


def test_prune_unreferenced_does_not_delete_in_progress_part_files(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    e1 = put_media(gm, b"content-v1")
    gm.write_generation("v1", {"version": "v1"}, gen_mod.Manifest("v1", (e1,)))
    gm.activate("v1")

    part_file = gm.media_dir / ("b" * 64 + ".part")
    part_file.write_bytes(b"still downloading")

    gm.prune_unreferenced()

    assert part_file.exists()
