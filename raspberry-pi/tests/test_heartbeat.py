from pathlib import Path

from agent import api as api_mod
from agent import generations as gen_mod
from agent import heartbeat as hb_mod


def make_client(fake_server) -> api_mod.DeviceApiClient:
    return api_mod.DeviceApiClient(fake_server.base_url, fake_server.expected_token, timeout=5)


def test_build_payload_contains_expected_fields_and_defaults(data_dir: Path, fake_server, monkeypatch):
    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)

    monkeypatch.setattr(hb_mod, "get_time_synced", lambda: True)
    monkeypatch.setattr(hb_mod, "get_cpu_temp_c", lambda: 45.6)
    monkeypatch.setattr(hb_mod, "get_mem_available_bytes", lambda: 123456)

    sender = hb_mod.HeartbeatSender(client, gm, agent_version="1.2.3")
    payload = sender.build_payload()

    assert payload["agentVersion"] == "1.2.3"
    assert payload["appliedVersion"] is None  # まだ current がない
    assert payload["bundleId"] is None
    assert payload["pendingVersion"] is None
    assert payload["timeSynced"] is True
    assert payload["cpuTempC"] == 45.6
    assert payload["memAvailableBytes"] == 123456
    assert isinstance(payload["diskFreeBytes"], int)
    # player.py（task_021）が未配線の間も heartbeatSchema の必須項目を満たす既定値を送る
    assert payload["mode"] == "off"
    assert payload["displayHealthy"] is False
    assert payload["nextVideoAt"] is None
    assert payload["lastVideoFinishedAt"] is None


def test_build_payload_reflects_current_generation_and_pending(data_dir: Path, fake_server, monkeypatch):
    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)

    content = b"video"
    sha = __import__("hashlib").sha256(content).hexdigest()
    gm.media_path(sha).write_bytes(content)
    entry = gen_mod.ManifestEntry(kind="media", key=sha, sha256=sha, size=len(content))
    gm.write_generation("v1", {"version": "v1", "displayBundle": {"id": "bundle01"}}, gen_mod.Manifest("v1", (entry,)))
    gm.activate("v1")

    monkeypatch.setattr(hb_mod, "get_time_synced", lambda: None)

    sender = hb_mod.HeartbeatSender(
        client,
        gm,
        agent_version="1.0.0",
        pending_version_provider=lambda: "v2",
    )
    payload = sender.build_payload()

    assert payload["appliedVersion"] == "v1"
    assert payload["bundleId"] == "bundle01"
    assert payload["pendingVersion"] == "v2"
    # timeSynced は heartbeatSchema で必須 boolean（null 不可）。判定不能時は False にする。
    assert payload["timeSynced"] is False


def test_player_status_provider_hook_is_merged_into_payload(data_dir: Path, fake_server):
    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)

    def fake_player_status():
        return {"mode": "playing", "displayHealthy": True, "nextVideoAt": 1234567890}

    sender = hb_mod.HeartbeatSender(
        client, gm, agent_version="1.0.0", player_status_provider=fake_player_status
    )
    payload = sender.build_payload()

    assert payload["mode"] == "playing"
    assert payload["displayHealthy"] is True
    assert payload["nextVideoAt"] == 1234567890


def test_send_once_posts_payload_to_server(data_dir: Path, fake_server):
    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    sender = hb_mod.HeartbeatSender(client, gm, agent_version="1.0.0")

    sender.send_once()

    assert len(fake_server.heartbeats) == 1
    assert fake_server.heartbeats[0]["agentVersion"] == "1.0.0"


def test_send_once_swallows_network_error(data_dir: Path, fake_server):
    gm = gen_mod.GenerationManager(data_dir)
    client = make_client(fake_server)
    logs: list[tuple[str, str]] = []
    sender = hb_mod.HeartbeatSender(
        client, gm, agent_version="1.0.0", on_log=lambda lvl, msg: logs.append((lvl, msg))
    )

    fake_server.stop()
    sender.send_once()  # 例外を投げない

    assert any("ネットワーク不通" in msg for _, msg in logs)
