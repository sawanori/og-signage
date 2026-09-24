import pytest

from agent import api as api_mod


def make_client(fake_server, token: str | None = None) -> api_mod.DeviceApiClient:
    return api_mod.DeviceApiClient(fake_server.base_url, token or fake_server.expected_token, timeout=5)


def test_get_config_first_time_returns_data_and_etag(fake_server):
    fake_server.set_config({"version": "v1", "playlist": []})
    client = make_client(fake_server)

    result = client.get_config(etag=None)

    assert result.not_modified is False
    assert result.data == {"version": "v1", "playlist": []}
    assert result.etag  # ETag が返る


def test_get_config_returns_304_when_etag_matches(fake_server):
    fake_server.set_config({"version": "v1"})
    client = make_client(fake_server)

    first = client.get_config(etag=None)
    second = client.get_config(etag=first.etag)

    assert second.not_modified is True
    assert second.data is None


def test_get_config_unauthorized_raises_http_error(fake_server):
    client = make_client(fake_server, token="wrong-token")
    with pytest.raises(api_mod.HttpError) as exc_info:
        client.get_config()
    assert exc_info.value.status == 401


def test_get_media_supports_range(fake_server):
    content = b"0123456789"
    fake_server.media["m1"] = content
    client = make_client(fake_server)

    with client.get_media("m1", range_header="bytes=5-") as resp:
        assert resp.status == 206
        body = resp.read()
    assert body == b"56789"


def test_get_media_full_without_range(fake_server):
    content = b"abcdef"
    fake_server.media["m1"] = content
    client = make_client(fake_server)

    with client.get_media("m1") as resp:
        assert resp.status == 200
        body = resp.read()
    assert body == content


def test_get_media_not_found_raises_http_error(fake_server):
    client = make_client(fake_server)
    with pytest.raises(api_mod.HttpError) as exc_info:
        client.get_media("does-not-exist")
    assert exc_info.value.status == 404


def test_post_heartbeat_logs_and_media_failure_are_received(fake_server):
    client = make_client(fake_server)

    client.post_heartbeat({"agentVersion": "1.0.0", "diskFreeBytes": 123})
    client.post_logs([{"type": "info", "message": "hello", "createdAt": 1700000000}])
    client.post_media_failure(
        {"mediaId": "m1", "reason": "hash_mismatch", "quarantined": True, "occurredAt": 1700000000}
    )

    assert fake_server.heartbeats == [{"agentVersion": "1.0.0", "diskFreeBytes": 123}]
    # lib/validators.ts の deviceLogsSchema: { logs: [{type, message, createdAt}] }
    assert fake_server.logs_received == [
        {"logs": [{"type": "info", "message": "hello", "createdAt": 1700000000}]}
    ]
    # lib/validators.ts の mediaFailuresSchema: { failures: [{mediaId, reason, quarantined, occurredAt}] }
    assert fake_server.media_failures == [
        {"failures": [{"mediaId": "m1", "reason": "hash_mismatch", "quarantined": True, "occurredAt": 1700000000}]}
    ]


def test_network_unreachable_raises_network_error(fake_server):
    client = make_client(fake_server)
    fake_server.stop()
    with pytest.raises(api_mod.NetworkError):
        client.get_config()


def test_token_never_appears_in_error_messages_or_repr(fake_server):
    secret_token = "super-secret-device-token"
    client = api_mod.DeviceApiClient(fake_server.base_url, secret_token, timeout=5)

    assert secret_token not in repr(client)
    assert secret_token not in str(client)

    try:
        client.get_media("does-not-exist")
    except api_mod.HttpError as exc:
        assert secret_token not in str(exc)
        assert secret_token not in repr(exc)

    fake_server.stop()
    try:
        client.get_config()
    except api_mod.NetworkError as exc:
        assert secret_token not in str(exc)
