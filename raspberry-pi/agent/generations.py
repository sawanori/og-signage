"""Pi 側のディレクトリ構成と世代管理（7 節）。

```
media/<sha256>             画像・動画（内容アドレス。世代間で共有）
bundles/<bundleId>/        表示バンドル（版ごと。bundle.zip を保持）
generations/<version>/     config.json と manifest.json
current -> generations/<version>
previous -> generations/<version>
state/                     適用履歴、隔離した媒体、未送信ログ（上限つき）
```

新しい世代は、manifest が参照する全ファイルがそろい内容アドレス（ファイル名 = sha256）で
存在することを確認してから、`current` を原子的に付け替える
（一時シンボリックリンクを作って `os.replace`）。旧 `current` は `previous` にする。
起動時に `current` が壊れていれば `previous` へ戻す。
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import time
import zipfile
from pathlib import Path
from typing import Literal

DEFAULT_RESERVE_BYTES = 1024**3  # 予備 1GB


class GenerationError(Exception):
    """世代管理に関するエラー。"""


@dataclasses.dataclass(frozen=True)
class ManifestEntry:
    kind: Literal["media", "bundle"]
    key: str  # media は sha256、bundle は bundleId
    sha256: str
    size: int
    # config-schema.ts の mediaId（media のみ。POST /api/device/media-failures の
    # mediaId フィールドに使う）。bundle には対応する ID がないため None。
    media_id: str | None = None


@dataclasses.dataclass(frozen=True)
class Manifest:
    version: str
    entries: tuple[ManifestEntry, ...]

    def to_json(self) -> dict:
        return {
            "version": self.version,
            "entries": [dataclasses.asdict(e) for e in self.entries],
        }

    @classmethod
    def from_json(cls, data: dict) -> "Manifest":
        entries = tuple(ManifestEntry(**e) for e in data["entries"])
        return cls(version=data["version"], entries=entries)


class GenerationManager:
    def __init__(self, data_dir: Path | str, reserve_bytes: int = DEFAULT_RESERVE_BYTES) -> None:
        self.data_dir = Path(data_dir)
        self.media_dir = self.data_dir / "media"
        self.bundles_dir = self.data_dir / "bundles"
        self.generations_dir = self.data_dir / "generations"
        self.state_dir = self.data_dir / "state"
        self.current_link = self.data_dir / "current"
        self.previous_link = self.data_dir / "previous"
        self.reserve_bytes = reserve_bytes
        for d in (self.media_dir, self.bundles_dir, self.generations_dir, self.state_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ---- パス ----
    def media_path(self, sha256: str) -> Path:
        return self.media_dir / sha256

    def bundle_dir(self, bundle_id: str) -> Path:
        return self.bundles_dir / bundle_id

    def bundle_archive_path(self, bundle_id: str) -> Path:
        return self.bundle_dir(bundle_id) / "bundle.zip"

    def bundle_extracted_dir(self, bundle_id: str) -> Path:
        return self.bundle_dir(bundle_id) / "extracted"

    def generation_dir(self, version: str) -> Path:
        return self.generations_dir / version

    # ---- 所持確認 ----
    def has_media(self, sha256: str, size: int | None = None) -> bool:
        p = self.media_path(sha256)
        if not p.is_file():
            return False
        if size is not None and p.stat().st_size != size:
            return False
        return True

    def has_bundle(self, bundle_id: str, size: int | None = None) -> bool:
        p = self.bundle_archive_path(bundle_id)
        if not p.is_file():
            return False
        if size is not None and p.stat().st_size != size:
            return False
        return True

    def missing_entries(self, manifest: Manifest) -> list[ManifestEntry]:
        missing = []
        for e in manifest.entries:
            if e.kind == "media":
                ok = self.has_media(e.sha256, e.size)
            else:
                ok = self.has_bundle(e.key, e.size)
            if not ok:
                missing.append(e)
        return missing

    def required_additional_bytes(self, manifest: Manifest) -> int:
        return sum(e.size for e in self.missing_entries(manifest))

    def has_enough_space(self, manifest: Manifest) -> bool:
        usage = shutil.disk_usage(self.data_dir)
        required = self.required_additional_bytes(manifest)
        return (usage.free - required) >= self.reserve_bytes

    # ---- 世代の準備 ----
    def write_generation(self, version: str, config: dict, manifest: Manifest) -> Path:
        gen_dir = self.generation_dir(version)
        gen_dir.mkdir(parents=True, exist_ok=True)
        tmp_config = gen_dir / "config.json.tmp"
        tmp_manifest = gen_dir / "manifest.json.tmp"

        self._write_json_durably(tmp_config, config)
        self._write_json_durably(tmp_manifest, manifest.to_json())

        os.replace(tmp_config, gen_dir / "config.json")
        os.replace(tmp_manifest, gen_dir / "manifest.json")
        return gen_dir

    @staticmethod
    def _write_json_durably(path: Path, data: dict) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())

    def load_manifest(self, version: str) -> Manifest:
        p = self.generation_dir(version) / "manifest.json"
        return Manifest.from_json(json.loads(p.read_text(encoding="utf-8")))

    def load_config(self, version: str) -> dict:
        p = self.generation_dir(version) / "config.json"
        return json.loads(p.read_text(encoding="utf-8"))

    def is_generation_complete(self, version: str) -> bool:
        gen_dir = self.generation_dir(version)
        cfg = gen_dir / "config.json"
        man = gen_dir / "manifest.json"
        if not (cfg.is_file() and man.is_file()):
            return False
        try:
            manifest = self.load_manifest(version)
        except (OSError, ValueError, KeyError, TypeError):
            return False
        return not self.missing_entries(manifest)

    # ---- current / previous ----
    def _read_link_target(self, link: Path) -> Path | None:
        try:
            if not link.is_symlink():
                return None
            target = os.readlink(link)
        except OSError:
            return None
        target_path = Path(target)
        if not target_path.is_absolute():
            target_path = (link.parent / target_path).resolve()
        return target_path

    def current_version(self) -> str | None:
        target = self._read_link_target(self.current_link)
        return target.name if target is not None else None

    def previous_version(self) -> str | None:
        target = self._read_link_target(self.previous_link)
        return target.name if target is not None else None

    def _atomic_symlink(self, link_path: Path, target_dir: Path) -> None:
        tmp_link = self.data_dir / f".{link_path.name}.tmp.{os.getpid()}.{time.time_ns()}"
        if tmp_link.exists() or tmp_link.is_symlink():
            tmp_link.unlink()
        os.symlink(target_dir, tmp_link, target_is_directory=True)
        os.replace(tmp_link, link_path)  # 同一ディレクトリ内のリネームなので原子的
        self._fsync_dir(link_path.parent)

    @staticmethod
    def _fsync_dir(directory: Path) -> None:
        """リネーム（付け替え）をディスクへ確定させる。電源断で付け替えが失われないように。"""
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    # ---- 切替 ----
    def activate(self, version: str) -> None:
        """`version` が完全にそろっていることを確認してから current に切り替える。

        旧 current は previous にする。切替は一時シンボリックリンク + os.replace で行うため、
        途中で中断しても current は「切替前の状態」か「切替後の状態」のどちらかにしかならない。
        """
        gen_dir = self.generation_dir(version)
        if not self.is_generation_complete(version):
            raise GenerationError(f"generation {version} is not complete")

        old_current_target = self._read_link_target(self.current_link)

        self._atomic_symlink(self.current_link, gen_dir)

        if old_current_target is not None and old_current_target != gen_dir:
            self._atomic_symlink(self.previous_link, old_current_target)

    def _force_current_to(self, version: str) -> None:
        self._atomic_symlink(self.current_link, self.generation_dir(version))

    def rollback_to_previous(self) -> str | None:
        """`previous` が有効なら `current` をそれに戻す。

        表示バンドル切替後の生存確認（task_021）に失敗したときに watchdog から呼ぶ。
        戻した version を返す（previous が無い・壊れている場合は None で何もしない）。
        """
        prev = self.previous_version()
        if prev is None or not self.is_generation_complete(prev):
            return None
        self._force_current_to(prev)
        return prev

    # ---- 表示バンドルの展開（server.py が静的ファイルとして配信するため） ----
    def ensure_bundle_extracted(self, bundle_id: str) -> Path:
        """`bundle.zip` をまだ展開していなければ展開する。展開先ディレクトリを返す。

        展開先に `.extracted` マーカーがあれば再展開しない（べき等）。zip 内のパスが
        展開先の外へ出るエントリ（zip slip）は無視する。
        """
        dest = self.bundle_extracted_dir(bundle_id)
        marker = dest / ".extracted"
        if marker.is_file():
            return dest

        archive = self.bundle_archive_path(bundle_id)
        if not archive.is_file():
            raise GenerationError(f"bundle archive not found: {bundle_id}")

        tmp_dest = self.bundle_dir(bundle_id) / f".extracted.tmp.{os.getpid()}.{time.time_ns()}"
        tmp_dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as zf:
            for member in zf.infolist():
                member_path = (tmp_dest / member.filename).resolve()
                if not str(member_path).startswith(str(tmp_dest.resolve())):
                    continue  # zip slip 対策: 展開先の外へ出るエントリは無視する
                zf.extract(member, tmp_dest)
        (tmp_dest / ".extracted").write_text("", encoding="utf-8")

        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        os.replace(tmp_dest, dest)
        return dest

    # ---- 起動時の検査 ----
    def ensure_valid_current(self) -> str | None:
        """起動時に呼ぶ。current が壊れていれば previous に戻す。

        有効な世代の version 文字列を返す（無ければ None）。
        """
        cur = self.current_version()
        if cur is not None and self.is_generation_complete(cur):
            return cur

        prev = self.previous_version()
        if prev is not None and self.is_generation_complete(prev):
            self._force_current_to(prev)
            return prev

        return None

    # ---- 不要ファイルの掃除 ----
    def prune_unreferenced(self) -> None:
        """current と previous のどちらからも参照されていない media/bundles を削除する。"""
        keep_media: set[str] = set()
        keep_bundles: set[str] = set()
        for version in (self.current_version(), self.previous_version()):
            if version is None:
                continue
            try:
                manifest = self.load_manifest(version)
            except (OSError, ValueError, KeyError, TypeError):
                continue
            for e in manifest.entries:
                if e.kind == "media":
                    keep_media.add(e.sha256)
                else:
                    keep_bundles.add(e.key)

        if self.media_dir.is_dir():
            for f in self.media_dir.iterdir():
                if f.is_file() and not f.name.endswith(".part") and f.name not in keep_media:
                    f.unlink()

        if self.bundles_dir.is_dir():
            for d in self.bundles_dir.iterdir():
                if d.is_dir() and d.name not in keep_bundles:
                    shutil.rmtree(d, ignore_errors=True)
