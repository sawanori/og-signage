import sys
from pathlib import Path

# raspberry-pi/ をパスに追加する（`raspberry-pi` はハイフンを含みパッケージ名にできないため、
# `agent` パッケージを直接 import できるようにする）。
RASPBERRY_PI_DIR = Path(__file__).resolve().parents[1]
if str(RASPBERRY_PI_DIR) not in sys.path:
    sys.path.insert(0, str(RASPBERRY_PI_DIR))

import pytest

from fake_server import FakeDeviceServer


@pytest.fixture
def fake_server():
    server = FakeDeviceServer()
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    return d
