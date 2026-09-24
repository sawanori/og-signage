import hashlib
from pathlib import Path

from agent import api as api_mod
from agent import downloader as dl_mod
from agent import generations as gen_mod


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_client(fake_server) -> api_mod.DeviceApiClient:
    return api_mod.DeviceApiClient(fake_server.base_url, fake_server.expected_token, timeout=5)


def test_download_media_success(data_dir: Path, fake_server):
    content = b"x" * 5000
    sha = sha256_of(content)
    fake_server.media[sha] = content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)

    job = dl_mod.DownloadJob(kind="media", key=sha, sha256=sha, size=len(content))
    ok = downloader.process(job)

    assert ok is True
    assert gm.media_path(sha).read_bytes() == content
    assert not downloader.tmp_path(job).exists()
    assert downloader.is_quarantined(sha) is False


def test_download_bundle_success(data_dir: Path, fake_server):
    content = b"zip-bytes" * 100
    sha = sha256_of(content)
    fake_server.bundles["bundle1"] = content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)

    job = dl_mod.DownloadJob(kind="bundle", key="bundle1", sha256=sha, size=len(content))
    ok = downloader.process(job)

    assert ok is True
    assert gm.bundle_archive_path("bundle1").read_bytes() == content


def test_download_skips_if_already_present(data_dir: Path, fake_server):
    content = b"already-there"
    sha = sha256_of(content)

    gm = gen_mod.GenerationManager(data_dir)
    gm.media_path(sha).write_bytes(content)

    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)
    job = dl_mod.DownloadJob(kind="media", key=sha, sha256=sha, size=len(content))

    ok = downloader.process(job)

    assert ok is True
    # サーバーには一度もアクセスしていない
    assert fake_server.request_log == []


def test_download_resumes_partial_with_range_header(data_dir: Path, fake_server):
    content = b"0123456789" * 1000  # 10000 bytes
    sha = sha256_of(content)
    fake_server.media[sha] = content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)
    job = dl_mod.DownloadJob(kind="media", key=sha, sha256=sha, size=len(content))

    # 途中まで取得済みの .part ファイルをあらかじめ置いておく
    partial = content[:4000]
    downloader.tmp_path(job).parent.mkdir(parents=True, exist_ok=True)
    downloader.tmp_path(job).write_bytes(partial)

    ok = downloader.process(job)

    assert ok is True
    assert gm.media_path(sha).read_bytes() == content

    range_headers = [headers.get("Range") for _, path, headers in fake_server.request_log if "media" in path]
    assert any(h == "bytes=4000-" for h in range_headers)


def test_sha_mismatch_three_times_quarantines_and_stops_retrying(data_dir: Path, fake_server):
    wrong_content = b"not-the-right-bytes"
    declared_sha = "0" * 64  # 絶対に一致しない値
    fake_server.media[declared_sha] = wrong_content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)
    job = dl_mod.DownloadJob(
        kind="media", key=declared_sha, sha256=declared_sha, size=len(wrong_content), media_id="media01"
    )

    assert downloader.process(job) is False
    assert downloader.is_quarantined(declared_sha) is False

    assert downloader.process(job) is False
    assert downloader.is_quarantined(declared_sha) is False

    assert downloader.process(job) is False
    assert downloader.is_quarantined(declared_sha) is True

    assert len(fake_server.media_failures) == 1
    failure = fake_server.media_failures[0]["failures"][0]
    assert failure["mediaId"] == "media01"
    assert failure["reason"] == "hash_mismatch"
    assert failure["quarantined"] is True
    assert isinstance(failure["occurredAt"], int)
    assert not gm.media_path(declared_sha).exists()

    requests_before = len(fake_server.request_log)
    # 4回目: 既に隔離済みなので、サーバーへは一切問い合わせない
    assert downloader.process(job) is False
    assert len(fake_server.request_log) == requests_before

    # enqueue も無視される
    downloader.enqueue(job)
    assert downloader._queue.empty()


def test_size_mismatch_is_treated_like_sha_mismatch(data_dir: Path, fake_server):
    content = b"short"
    sha = sha256_of(content)
    fake_server.media[sha] = content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)
    # サイズを実際より大きく偽って宣言する
    job = dl_mod.DownloadJob(kind="media", key=sha, sha256=sha, size=len(content) + 100, media_id="media02")

    for _ in range(3):
        downloader.process(job)

    assert downloader.is_quarantined(sha) is True
    assert len(fake_server.media_failures) == 1
    assert fake_server.media_failures[0]["failures"][0]["mediaId"] == "media02"


def test_bundle_mismatch_quarantines_locally_but_is_not_reported_to_media_failures_api(
    data_dir: Path, fake_server
):
    """mediaFailuresSchema（lib/validators.ts）には mediaId しかなく bundleId 用の欄がない。
    そのため bundle の隔離はローカルで止める（再取得しない）が、API へは報告しない
    （既知の制約。TS 側スキーマの拡張が必要になれば見直す）。"""
    wrong_content = b"not-a-real-bundle"
    declared_sha = "9" * 64
    fake_server.bundles["bundleX"] = wrong_content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)
    job = dl_mod.DownloadJob(kind="bundle", key="bundleX", sha256=declared_sha, size=len(wrong_content))

    for _ in range(3):
        downloader.process(job)

    assert downloader.is_quarantined("bundleX") is True
    assert fake_server.media_failures == []  # 報告できないので送られない
    assert downloader.process(job) is False  # 以後は再取得しない


def test_network_unreachable_returns_false_without_raising(data_dir: Path, fake_server):
    content = b"hello"
    sha = sha256_of(content)
    fake_server.media[sha] = content

    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    downloader = dl_mod.Downloader(client, gm)
    job = dl_mod.DownloadJob(kind="media", key=sha, sha256=sha, size=len(content))

    fake_server.stop()  # サーバーを落として接続不能にする

    ok = downloader.process(job)

    assert ok is False
    assert not gm.media_path(sha).exists()
    assert downloader.is_quarantined(sha) is False  # ネット不通は隔離しない
