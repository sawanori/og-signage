import hashlib
from pathlib import Path

from agent import api as api_mod
from agent import downloader as dl_mod
from agent import generations as gen_mod
from agent import sync as sync_mod


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ImmediateDownloader(dl_mod.Downloader):
    """テスト用: enqueue されたジョブをスレッドを使わずその場で処理する。"""

    def enqueue(self, job: dl_mod.DownloadJob) -> None:
        if self.is_quarantined(job.key):
            return
        self.process(job)
        if self._on_job_done is not None:
            self._on_job_done()


def make_client(fake_server) -> api_mod.DeviceApiClient:
    return api_mod.DeviceApiClient(fake_server.base_url, fake_server.expected_token, timeout=5)


def build_engine(data_dir: Path, fake_server):
    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = ImmediateDownloader(client, gm)
    logs: list[tuple[str, str]] = []
    engine = sync_mod.SyncEngine(client, gm, downloader, on_log=lambda lvl, msg: logs.append((lvl, msg)))
    downloader.set_on_job_done(engine.try_activate_pending)
    return gm, client, downloader, engine, logs


def make_config(
    version: str, media_content: bytes, bundle_content: bytes, bundle_id: str = "bundle01"
) -> tuple[dict, str, str]:
    media_sha = sha256_of(media_content)
    bundle_sha = sha256_of(bundle_content)
    config = {
        "schemaVersion": 1,
        "version": version,
        "events": [],
        "notices": [],
        "house": {"name": "HARMONY HOUSE"},
        "schedule": {},
        "weather": None,
        "playlist": [
            {
                "mediaId": "media01",
                "sha256": media_sha,
                "size": len(media_content),
                "durationSeconds": 10,
            }
        ],
        "displayBundle": {"id": bundle_id, "sha256": bundle_sha, "size": len(bundle_content)},
        "device": {"orientation": "portrait", "volume": 0},
        "commands": {},
    }
    return config, media_sha, bundle_sha


def test_new_version_downloads_and_activates(data_dir: Path, fake_server):
    gm, client, downloader, engine, logs = build_engine(data_dir, fake_server)

    media_content = b"video-bytes" * 100
    bundle_content = b"bundle-bytes" * 50
    config, media_sha, bundle_sha = make_config("v1", media_content, bundle_content)
    fake_server.media[media_sha] = media_content
    fake_server.bundles["bundle01"] = bundle_content
    fake_server.set_config(config)

    engine.run_once()

    assert gm.current_version() == "v1"
    assert gm.media_path(media_sha).read_bytes() == media_content
    assert gm.bundle_archive_path("bundle01").read_bytes() == bundle_content
    assert engine.pending_version is None


def test_no_op_on_304(data_dir: Path, fake_server):
    gm, client, downloader, engine, logs = build_engine(data_dir, fake_server)

    media_content = b"video-bytes"
    bundle_content = b"bundle-bytes"
    config, media_sha, bundle_sha = make_config("v1", media_content, bundle_content)
    fake_server.media[media_sha] = media_content
    fake_server.bundles["bundle01"] = bundle_content
    fake_server.set_config(config)

    engine.run_once()
    assert gm.current_version() == "v1"

    generations_before = sorted(p.name for p in gm.generations_dir.iterdir())

    # 2 回目: ETag が一致するのでサーバーは 304 を返すはず
    engine.run_once()

    generations_after = sorted(p.name for p in gm.generations_dir.iterdir())
    assert generations_before == generations_after
    assert gm.current_version() == "v1"

    config_requests = [1 for method, path, _ in fake_server.request_log if path == "/api/device/config"]
    assert len(config_requests) == 2  # 1回目(200) + 2回目(304)


def test_insufficient_space_holds_update_and_keeps_current(data_dir: Path, fake_server, monkeypatch):
    gm, client, downloader, engine, logs = build_engine(data_dir, fake_server)

    media_content = b"video-bytes"
    bundle_content = b"bundle-bytes"
    config, media_sha, bundle_sha = make_config("v1", media_content, bundle_content)
    fake_server.media[media_sha] = media_content
    fake_server.bundles["bundle01"] = bundle_content
    fake_server.set_config(config)

    class TinyFreeSpace:
        free = 1  # ほぼゼロ

    monkeypatch.setattr(gen_mod.shutil, "disk_usage", lambda path: TinyFreeSpace())

    engine.run_once()

    assert gm.current_version() is None  # 現行世代なし（保留）
    assert engine.pending_version == "v1"
    assert list(gm.generations_dir.iterdir()) == []  # 世代ディレクトリすら作られない
    assert any("空き容量が不足" in msg for _, msg in logs)


def test_network_unreachable_keeps_current_generation(data_dir: Path, fake_server):
    gm, client, downloader, engine, logs = build_engine(data_dir, fake_server)

    media_content = b"video-bytes"
    bundle_content = b"bundle-bytes"
    config, media_sha, bundle_sha = make_config("v1", media_content, bundle_content)
    fake_server.media[media_sha] = media_content
    fake_server.bundles["bundle01"] = bundle_content
    fake_server.set_config(config)

    engine.run_once()
    assert gm.current_version() == "v1"

    fake_server.stop()

    # 例外を投げず、現行世代を維持したまま戻ってくること
    engine.run_once()

    assert gm.current_version() == "v1"
    assert any("ネットワーク不通" in msg for _, msg in logs)


def test_version_upgrade_moves_old_to_previous(data_dir: Path, fake_server):
    gm, client, downloader, engine, logs = build_engine(data_dir, fake_server)

    media_v1 = b"video-v1"
    bundle_v1 = b"bundle-v1"
    config1, sha1, bsha1 = make_config("v1", media_v1, bundle_v1)
    fake_server.media[sha1] = media_v1
    fake_server.bundles["bundle01"] = bundle_v1
    fake_server.set_config(config1)
    engine.run_once()
    assert gm.current_version() == "v1"

    # displayBundle の id は「ハッシュ付きの不変な ID」（6 節前提）なので、
    # 内容が変われば bundleId も変わる。
    media_v2 = b"video-v2"
    bundle_v2 = b"bundle-v2"
    config2, sha2, bsha2 = make_config("v2", media_v2, bundle_v2, bundle_id="bundle02")
    fake_server.media[sha2] = media_v2
    fake_server.bundles["bundle02"] = bundle_v2
    fake_server.set_config(config2)
    engine.run_once()

    assert gm.current_version() == "v2"
    assert gm.previous_version() == "v1"
    assert gm.bundle_archive_path("bundle01").read_bytes() == bundle_v1  # previous からまだ参照される
    assert gm.bundle_archive_path("bundle02").read_bytes() == bundle_v2


def test_extract_media_references_reads_playlist_and_bundle():
    config = {
        "playlist": [
            {"mediaId": "m1", "sha256": "a" * 64, "size": 10, "durationSeconds": 5},
            {"mediaId": "m2", "sha256": "b" * 64, "size": 20, "durationSeconds": 5},
        ],
        "displayBundle": {"id": "bundle01", "sha256": "c" * 64, "size": 30},
    }
    refs = sync_mod.extract_media_references(config)
    assert refs == [
        sync_mod.MediaReference(media_id="m1", sha256="a" * 64, size=10),
        sync_mod.MediaReference(media_id="m2", sha256="b" * 64, size=20),
    ]

    manifest = sync_mod.build_manifest("v1", config)
    kinds = {(e.kind, e.key, e.media_id) for e in manifest.entries}
    assert kinds == {("media", "a" * 64, "m1"), ("media", "b" * 64, "m2"), ("bundle", "bundle01", None)}


def test_extract_media_references_reads_house_events_and_notices_images():
    """lib/config-schema.ts の collectMediaRefs と同じ規則:
    house.logo / house.footerImage / events[].image / notices[].image / playlist[] を
    mediaId で重複を除いて集める。displayBundle は含めない。"""
    config = {
        "house": {
            "name": "HARMONY HOUSE",
            "logo": {"mediaId": "logo1", "sha256": "1" * 64, "size": 100},
            "footerImage": {"mediaId": "footer1", "sha256": "2" * 64, "size": 200},
        },
        "events": [
            {"id": "e1", "image": {"mediaId": "eventimg1", "sha256": "3" * 64, "size": 300}},
            {"id": "e2", "image": None},
        ],
        "notices": [
            {"id": "n1", "image": {"mediaId": "noticeimg1", "sha256": "4" * 64, "size": 400}},
            # 同じ mediaId の重複は1件だけになる
            {"id": "n2", "image": {"mediaId": "logo1", "sha256": "1" * 64, "size": 100}},
        ],
        "playlist": [{"mediaId": "video1", "sha256": "5" * 64, "size": 500, "durationSeconds": 10}],
    }

    refs = sync_mod.extract_media_references(config)
    media_ids = [r.media_id for r in refs]

    assert media_ids == ["logo1", "footer1", "eventimg1", "noticeimg1", "video1"]


def test_extract_media_references_handles_missing_playlist_and_bundle():
    assert sync_mod.extract_media_references({}) == []
    manifest = sync_mod.build_manifest("v1", {})
    assert manifest.entries == ()
