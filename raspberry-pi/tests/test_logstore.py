from pathlib import Path

from agent import api as api_mod
from agent import logstore as logstore_mod


def make_client(fake_server) -> api_mod.DeviceApiClient:
    return api_mod.DeviceApiClient(fake_server.base_url, fake_server.expected_token, timeout=5)


def test_append_and_pending_count(data_dir: Path):
    store = logstore_mod.LogStore(data_dir / "state")
    store.append("info", "hello")
    store.append("warning", "world")
    assert store.pending_count() == 2


def test_max_entries_caps_local_storage(data_dir: Path):
    store = logstore_mod.LogStore(data_dir / "state", max_entries=3)
    for i in range(10):
        store.append("info", f"message-{i}")
    assert store.pending_count() == 3


def test_flush_sends_at_most_batch_size_and_removes_sent_entries(data_dir: Path, fake_server):
    store = logstore_mod.LogStore(data_dir / "state", batch_size=2)
    client = make_client(fake_server)

    store.append("info", "a")
    store.append("info", "b")
    store.append("info", "c")

    sent = store.flush(client)

    assert sent == 2
    assert store.pending_count() == 1
    assert len(fake_server.logs_received) == 1
    assert len(fake_server.logs_received[0]["logs"]) == 2
    first_entry = fake_server.logs_received[0]["logs"][0]
    assert first_entry["type"] == "info"
    assert first_entry["message"] == "a"
    assert isinstance(first_entry["createdAt"], int)


def test_flush_returns_zero_when_nothing_pending(data_dir: Path, fake_server):
    store = logstore_mod.LogStore(data_dir / "state")
    client = make_client(fake_server)
    assert store.flush(client) == 0


def test_flush_keeps_entries_on_network_failure(data_dir: Path, fake_server):
    store = logstore_mod.LogStore(data_dir / "state")
    client = make_client(fake_server)
    store.append("info", "a")

    fake_server.stop()
    sent = store.flush(client)

    assert sent == 0
    assert store.pending_count() == 1
