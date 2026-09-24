import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import pytest

from agent import generations as gen_mod
from agent import platform as platform_mod
from agent import server as server_mod


def build_bundle_zip(path: Path, files: dict[str, bytes]) -> tuple[bytes, str]:
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    data = path.read_bytes()
    return data, hashlib.sha256(data).hexdigest()


def activate_generation(gm: gen_mod.GenerationManager, version: str, config: dict, tmp_path: Path) -> None:
    bundle_zip_src = tmp_path / f"{version}-bundle.zip"
    bundle_bytes, bundle_sha = build_bundle_zip(
        bundle_zip_src, {"index.html": b"<html>hello</html>", "assets/app.js": b"console.log(1)"}
    )
    bundle_id = f"bundle-{version}"
    gm.bundle_archive_path(bundle_id).parent.mkdir(parents=True, exist_ok=True)
    gm.bundle_archive_path(bundle_id).write_bytes(bundle_bytes)

    config = dict(config)
    config["displayBundle"] = {"id": bundle_id, "sha256": bundle_sha, "size": len(bundle_bytes)}

    entries = [gen_mod.ManifestEntry(kind="bundle", key=bundle_id, sha256=bundle_sha, size=len(bundle_bytes))]
    for item in config.get("playlist") or []:
        entries.append(
            gen_mod.ManifestEntry(kind="media", key=item["sha256"], sha256=item["sha256"], size=item["size"])
        )
    for ref in [
        (config.get("house") or {}).get("logo"),
    ]:
        if ref:
            entries.append(gen_mod.ManifestEntry(kind="media", key=ref["sha256"], sha256=ref["sha256"], size=ref["size"]))

    gm.write_generation(version, config, gen_mod.Manifest(version, tuple(entries)))
    gm.activate(version)


@pytest.fixture
def local_server(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(gm, clock, port=0)
    server.start()
    try:
        yield server, gm, clock
    finally:
        server.stop()


def http_get(server: server_mod.LocalServer, path: str, headers: dict | None = None):
    req = urllib.request.Request(f"http://127.0.0.1:{server.port}{path}", headers=headers or {})
    try:
        resp = urllib.request.urlopen(req, timeout=5)
        return resp.status, dict(resp.headers.items()), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read()


def http_post(server: server_mod.LocalServer, path: str, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    resp = urllib.request.urlopen(req, timeout=5)
    return resp.status


def test_config_json_not_found_before_any_generation(local_server):
    server, gm, clock = local_server
    status, _, _ = http_get(server, "/local/config.json")
    assert status == 404


def test_config_json_returns_current_generation(local_server, tmp_path: Path):
    server, gm, clock = local_server
    config = {"version": "v1", "schedule": [], "playlist": [], "house": {"name": "H"}, "commands": {}}
    activate_generation(gm, "v1", config, tmp_path)

    status, headers, body = http_get(server, "/local/config.json")
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    data = json.loads(body)
    assert data["version"] == "v1"
    assert data["displayBundle"]["id"] == "bundle-v1"


def test_static_serves_index_html_from_current_bundle(local_server, tmp_path: Path):
    server, gm, clock = local_server
    config = {"version": "v1", "schedule": [], "playlist": [], "house": {"name": "H"}, "commands": {}}
    activate_generation(gm, "v1", config, tmp_path)

    status, headers, body = http_get(server, "/")
    assert status == 200
    assert body == b"<html>hello</html>"

    status, headers, body = http_get(server, "/assets/app.js")
    assert status == 200
    assert body == b"console.log(1)"


def test_static_before_any_generation_is_503(local_server):
    server, gm, clock = local_server
    status, _, _ = http_get(server, "/")
    assert status == 503


def test_static_rejects_path_traversal(local_server, tmp_path: Path):
    server, gm, clock = local_server
    config = {"version": "v1", "schedule": [], "playlist": [], "house": {"name": "H"}, "commands": {}}
    activate_generation(gm, "v1", config, tmp_path)

    status, _, _ = http_get(server, "/../../../etc/passwd")
    assert status in (403, 404)


def test_media_range_request(local_server, tmp_path: Path):
    server, gm, clock = local_server
    content = b"0123456789" * 100
    sha = hashlib.sha256(content).hexdigest()
    gm.media_path(sha).write_bytes(content)

    config = {
        "version": "v1",
        "schedule": [],
        "playlist": [{"mediaId": "m1", "sha256": sha, "size": len(content), "durationSeconds": 5}],
        "house": {"name": "H"},
        "commands": {},
    }
    activate_generation(gm, "v1", config, tmp_path)

    status, headers, body = http_get(server, f"/local/media/{sha}")
    assert status == 200
    assert body == content
    assert headers["Content-Type"] == "video/mp4"

    status, headers, body = http_get(server, f"/local/media/{sha}", headers={"Range": "bytes=10-19"})
    assert status == 206
    assert body == content[10:20]
    assert headers["Content-Range"] == f"bytes 10-19/{len(content)}"


def test_media_content_type_guessed_as_image_for_house_logo(local_server, tmp_path: Path):
    server, gm, clock = local_server
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"rest-of-file"
    sha = hashlib.sha256(png_bytes).hexdigest()
    gm.media_path(sha).write_bytes(png_bytes)

    config = {
        "version": "v1",
        "schedule": [],
        "playlist": [],
        "house": {"name": "H", "logo": {"mediaId": "logo1", "sha256": sha, "size": len(png_bytes)}},
        "commands": {},
    }
    activate_generation(gm, "v1", config, tmp_path)

    status, headers, body = http_get(server, f"/local/media/{sha}")
    assert status == 200
    assert headers["Content-Type"] == "image/png"


def test_media_not_found(local_server):
    server, gm, clock = local_server
    status, _, _ = http_get(server, "/local/media/" + "0" * 64)
    assert status == 404


def test_ack_updates_last_ack_monotonic_and_returns_200(local_server):
    server, gm, clock = local_server
    clock.advance(30)

    status = http_post(server, "/local/ack", {})
    assert status == 200
    assert server.last_ack_monotonic() == 30


def test_ack_with_transition_forwards_to_callback(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    clock = platform_mod.FakeClock()
    received = []
    server = server_mod.LocalServer(gm, clock, port=0, on_ack=lambda tid, phase: received.append((tid, phase)))
    server.start()
    try:
        status = http_post(server, "/local/ack", {"transitionId": "abc123", "phase": "fade_out_done"})
        assert status == 200
        assert received == [("abc123", "fade_out_done")]
    finally:
        server.stop()


def test_sse_sends_current_state_events_immediately_on_connect():
    """新規接続直後に current_state_provider の値を1回ずつ送ること（表示ページの再読み込み対策）。"""

    class DummyGen:
        def current_version(self):
            return None

    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(
        DummyGen(),
        clock,
        port=0,
        current_state_provider=lambda: [
            {"transitionId": "t9", "mode": "playing"},
            {"type": "status", "timeSynced": True},
        ],
    )
    server.start()
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{server.port}/local/events")
        resp = urllib.request.urlopen(req, timeout=10)
        received: list[dict] = []
        for raw_line in resp:
            line = raw_line.decode("utf-8").strip()
            if line.startswith("data: "):
                received.append(json.loads(line[len("data: ") :]))
                if len(received) >= 2:
                    break
        resp.close()
        assert received == [
            {"transitionId": "t9", "mode": "playing"},
            {"type": "status", "timeSynced": True},
        ]
    finally:
        server.stop()


def test_sse_without_current_state_provider_sends_nothing_extra():
    """current_state_provider を渡さない場合は既定の空リストで、初期イベントを送らない。"""

    class DummyGen:
        def current_version(self):
            return None

    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(DummyGen(), clock, port=0)
    server.start()
    try:
        received: list[dict] = []
        stop = threading.Event()

        def reader():
            req = urllib.request.Request(f"http://127.0.0.1:{server.port}/local/events")
            resp = urllib.request.urlopen(req, timeout=10)
            for raw_line in resp:
                if stop.is_set():
                    break
                line = raw_line.decode("utf-8").strip()
                if line.startswith("data: "):
                    received.append(json.loads(line[len("data: ") :]))
                    if len(received) >= 1:
                        break

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()

        deadline = time.monotonic() + 5
        while server.broadcaster.subscriber_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.broadcaster.subscriber_count == 1

        server.broadcaster.publish({"transitionId": "t1", "mode": "fading_out"})
        thread.join(timeout=5)
        stop.set()

        assert received == [{"transitionId": "t1", "mode": "fading_out"}]
    finally:
        server.stop()


def test_sse_receives_published_events():
    import agent.generations as gm_mod

    class DummyGen:
        def current_version(self):
            return None

    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(DummyGen(), clock, port=0)
    server.start()
    try:
        received: list[dict] = []
        stop = threading.Event()

        def reader():
            req = urllib.request.Request(f"http://127.0.0.1:{server.port}/local/events")
            resp = urllib.request.urlopen(req, timeout=10)
            for raw_line in resp:
                if stop.is_set():
                    break
                line = raw_line.decode("utf-8").strip()
                if line.startswith("data: "):
                    received.append(json.loads(line[len("data: ") :]))
                    if len(received) >= 2:
                        break

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()

        deadline = time.monotonic() + 5
        while server.broadcaster.subscriber_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.broadcaster.subscriber_count == 1

        server.broadcaster.publish({"transitionId": "t1", "mode": "fading_out"})
        server.broadcaster.publish({"type": "config_updated", "version": "v2"})

        thread.join(timeout=5)
        stop.set()

        assert received == [
            {"transitionId": "t1", "mode": "fading_out"},
            {"type": "config_updated", "version": "v2"},
        ]
    finally:
        server.stop()
