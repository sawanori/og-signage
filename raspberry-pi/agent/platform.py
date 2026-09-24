"""mpv・Chromium・HDMI 出力制御・時計を差し替え可能にする小さなインターフェースと、
実機がなくても pytest で検証できるテスト用の偽実装（task_021）。

`RealPlatform` の具体的なコマンド（mpv の起動フラグ、Chromium 再起動、HDMI on/off）は
task_003（Pi OS の GUI 起動方式・画面回転・HDMI 制御方法の確定）が終わるまでの仮値。
該当箇所には "task_003" とコメントしてある。
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Protocol

logger = logging.getLogger(__name__)


class MpvStartError(Exception):
    """mpv の起動に失敗した場合（プロセス起動そのものが失敗したときなど）。"""


class Clock(Protocol):
    """単調増加時計（間隔計測）と壁時計（表示スケジュール判定）の両方を提供する。

    間隔・タイムアウトの計測は `monotonic()` を使う（実装計画 6 節 前提13：
    「動画の間隔や再試行は OS の単調増加時計で測る」）。表示スケジュールの判定だけ
    `wall_time()`（UNIX 秒、Asia/Tokyo 換算は呼び出し側で行う）を使う。
    """

    def monotonic(self) -> float: ...

    def wall_time(self) -> float: ...


class MpvHandle(Protocol):
    """起動済み mpv プロセス 1 本を表す。"""

    def poll(self) -> int | None:
        """まだ実行中なら None、終了していれば終了コード。"""
        ...

    def time_pos(self) -> float | None:
        """現在の再生位置（秒）。取得できなければ None。"""
        ...

    def terminate(self) -> None:
        """強制終了する（べき等であること）。"""
        ...


class Platform(Protocol):
    def start_mpv(self, media_path: Path, *, volume: int) -> MpvHandle: ...

    def restart_chromium(self) -> None: ...

    def hdmi_off(self) -> None: ...

    def hdmi_on(self) -> None: ...

    def exit_agent(self, code: int) -> None:
        """Agent プロセス自体を終了する（systemd に非0終了コードで再起動させる）。"""
        ...


class SystemClock:
    """実機用の時計。"""

    def monotonic(self) -> float:
        return time.monotonic()

    def wall_time(self) -> float:
        return time.time()


class RealMpvHandle:
    """mpv を `--input-ipc-server` の UNIX ソケット JSON IPC で監視する実装。"""

    def __init__(self, process: "subprocess.Popen[bytes]", ipc_path: Path) -> None:
        self._process = process
        self._ipc_path = ipc_path

    def poll(self) -> int | None:
        return self._process.poll()

    def time_pos(self) -> float | None:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(1.0)
                sock.connect(str(self._ipc_path))
                sock.sendall(json.dumps({"command": ["get_property", "time-pos"]}).encode("utf-8") + b"\n")
                data = sock.recv(4096)
            if not data:
                return None
            reply = json.loads(data.decode("utf-8").splitlines()[0])
            if reply.get("error") != "success":
                return None
            value = reply.get("data")
            return float(value) if value is not None else None
        except (OSError, ValueError, IndexError, json.JSONDecodeError):
            return None

    def terminate(self) -> None:
        self._process.terminate()
        try:
            self._process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._process.kill()


class RealPlatform:
    """実機用の実装。

    mpv の起動コマンド・Chromium 再起動コマンド・HDMI 制御コマンドはいずれも
    task_003（Pi OS の GUI 起動方式が Wayland/labwc か X11 か、画面回転の方法、
    HDMI 出力を切る具体的な方法）の結果で確定させる前提の仮値。
    """

    def __init__(self, ipc_dir: Path, *, mpv_binary: str = "mpv", hdmi_output: str = "HDMI-A-1") -> None:
        self._ipc_dir = Path(ipc_dir)
        self._ipc_dir.mkdir(parents=True, exist_ok=True)
        self._mpv_binary = mpv_binary
        self._hdmi_output = hdmi_output

    def start_mpv(self, media_path: Path, *, volume: int) -> MpvHandle:
        ipc_path = self._ipc_dir / f"mpv-{time.time_ns()}.sock"
        # task_003 で確定させるまでの仮のコマンドライン。
        cmd = [
            self._mpv_binary,
            "--fullscreen",
            "--no-osc",
            "--no-input-default-bindings",
            "--really-quiet",
            f"--input-ipc-server={ipc_path}",
            f"--volume={volume}",
            str(media_path),
        ]
        try:
            process = subprocess.Popen(cmd)
        except OSError as exc:
            raise MpvStartError(str(exc)) from exc
        return RealMpvHandle(process, ipc_path)

    def restart_chromium(self) -> None:
        # task_003 で GUI 起動方式が確定するまでの仮のコマンド（ユーザー systemd unit を想定）。
        subprocess.run(["systemctl", "--user", "restart", "chromium-kiosk"], check=False)

    def hdmi_off(self) -> None:
        # task_003 で確定するまでの仮のコマンド（labwc/wlroots 環境を想定）。
        subprocess.run(["wlr-randr", "--output", self._hdmi_output, "--off"], check=False)

    def hdmi_on(self) -> None:
        subprocess.run(["wlr-randr", "--output", self._hdmi_output, "--on"], check=False)

    def exit_agent(self, code: int) -> None:
        # watchdog はバックグラウンドスレッドから呼ぶため、そのスレッドで SystemExit を送出しても
        # プロセス全体は終わらない。systemd に確実に再起動させるため即座にプロセスを終了する。
        os._exit(code)


# ---------------------------------------------------------------- テスト用の偽実装


@dataclasses.dataclass
class FakeMpvHandle:
    """テスト用。`time_pos`・終了コードをテストコードから直接操作できる。"""

    _time_pos: float | None = 0.0
    _exit_code: int | None = None
    terminated: bool = False

    def set_time_pos(self, value: float | None) -> None:
        self._time_pos = value

    def finish(self, exit_code: int = 0) -> None:
        self._exit_code = exit_code

    def poll(self) -> int | None:
        return self._exit_code

    def time_pos(self) -> float | None:
        return self._time_pos

    def terminate(self) -> None:
        self.terminated = True
        if self._exit_code is None:
            self._exit_code = -15


class FakePlatform:
    """テスト用。呼び出しを記録し、`queue_handle` で次の `start_mpv` の戻り値/例外を指定する。"""

    def __init__(self) -> None:
        self.started: list[tuple[Path, int]] = []
        self.chromium_restart_count = 0
        self.hdmi_state = "on"
        self.exit_calls: list[int] = []
        self._next_handles: list[object] = []

    def queue_handle(self, handle: object) -> None:
        """次に `start_mpv` が呼ばれたときに返す `MpvHandle`、または送出する例外を積む。"""
        self._next_handles.append(handle)

    def start_mpv(self, media_path: Path, *, volume: int) -> MpvHandle:
        self.started.append((media_path, volume))
        if not self._next_handles:
            return FakeMpvHandle()
        next_item = self._next_handles.pop(0)
        if isinstance(next_item, Exception):
            raise next_item
        return next_item  # type: ignore[return-value]

    def restart_chromium(self) -> None:
        self.chromium_restart_count += 1

    def hdmi_off(self) -> None:
        self.hdmi_state = "off"

    def hdmi_on(self) -> None:
        self.hdmi_state = "on"

    def exit_agent(self, code: int) -> None:
        self.exit_calls.append(code)


class FakeClock:
    """テスト用。単調増加時計と壁時計を別々に、明示的に進められる。"""

    def __init__(self, monotonic_start: float = 0.0, wall_start: float = 0.0) -> None:
        self._monotonic = monotonic_start
        self._wall = wall_start

    def monotonic(self) -> float:
        return self._monotonic

    def wall_time(self) -> float:
        return self._wall

    def advance(self, seconds: float) -> None:
        self._monotonic += seconds
        self._wall += seconds

    def set_wall(self, wall: float) -> None:
        self._wall = wall

    def set_monotonic(self, value: float) -> None:
        self._monotonic = value
