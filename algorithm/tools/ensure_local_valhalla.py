from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).parents[2]
BRIDGE = ROOT / 'runtime' / 'valhalla_bridge.py'
PREPARE_RUNTIME = ROOT / 'runtime' / 'prepare_valhalla_runtime.py'
WSL_DISTRIBUTION = 'docker-desktop'
RUNTIME_REVISION = 'valhalla-3.8.3-runtime-schema-v2'
BRIDGE_REVISION = 'worker-pool-v2'


def _health_url(endpoint: str) -> str:
    return f"{endpoint.rstrip('/')}/status"


def _bridge_status(endpoint: str, timeout_seconds: float) -> dict[str, object] | None:
    """Read the real bridge health response without synthesizing a route."""
    try:
        with urlopen(_health_url(endpoint), timeout=timeout_seconds) as response:
            body = json.loads(response.read().decode('utf-8'))
        return body if response.status == 200 and isinstance(body, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, URLError):
        return None


def _wsl_path(path: Path) -> str:
    """Translate an absolute Windows workspace path to the Docker WSL mount."""
    resolved = path.resolve()
    drive = resolved.drive.rstrip(':').lower()
    if os.name != 'nt' or len(drive) != 1:
        raise RuntimeError(
            'Automatic local Valhalla start is available only from Windows with WSL.'
        )
    suffix = resolved.as_posix().split(':', 1)[1].lstrip('/')
    return f'/mnt/host/{drive}/{suffix}'


def _prepare_wsl_runtime() -> None:
    """Build a bridge executable against the actual installed Valhalla runtime."""
    if not PREPARE_RUNTIME.is_file():
        raise RuntimeError(f'Valhalla runtime preparer is missing: {PREPARE_RUNTIME}')
    check = subprocess.run(
        [
            'wsl.exe', '--distribution', WSL_DISTRIBUTION, '--exec', '/bin/sh', '-lc',
            f'python3 {_wsl_path(PREPARE_RUNTIME)}',
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if check.returncode:
        detail = (check.stderr or check.stdout).strip()
        raise RuntimeError(
            'Docker Desktop WSL cannot prepare a compatible real Valhalla runtime'
            + (f': {detail}' if detail else '')
        )


def _stop_wsl_bridge() -> None:
    """Stop only an older bridge from this workspace before replacing it."""
    bridge_path = shlex.quote(_wsl_path(BRIDGE))
    subprocess.run(
        [
            'wsl.exe', '--distribution', WSL_DISTRIBUTION, '--exec', '/bin/sh', '-lc',
            f'pkill -f {bridge_path} || true',
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def _start_bridge() -> None:
    """Start the actual WSL Valhalla bridge detached from the pipeline process."""
    if not BRIDGE.is_file():
        raise RuntimeError(f'Valhalla bridge is missing: {BRIDGE}')
    _prepare_wsl_runtime()
    _stop_wsl_bridge()
    time.sleep(0.5)
    log_path = ROOT / 'runtime' / 'valhalla-bridge.log'
    command = [
        'wsl.exe', '--distribution', WSL_DISTRIBUTION, '--exec', 'python3',
        _wsl_path(BRIDGE),
    ]
    creationflags = 0
    if os.name == 'nt':
        creationflags = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
        )
    with log_path.open('ab') as log:
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
            close_fds=True,
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Ensure that the local endpoint is backed by real Valhalla routing.'
    )
    parser.add_argument('--endpoint', default='http://127.0.0.1:8002')
    parser.add_argument('--startup-timeout-seconds', type=float, default=30)
    parser.add_argument('--health-timeout-seconds', type=float, default=2)
    args = parser.parse_args()
    if args.startup_timeout_seconds <= 0 or args.health_timeout_seconds <= 0:
        parser.error('Timeouts must be positive')
    current_status = _bridge_status(args.endpoint, args.health_timeout_seconds)
    if (
        current_status is not None
        and current_status.get('runtime_revision') == RUNTIME_REVISION
        and current_status.get('bridge_revision') == BRIDGE_REVISION
    ):
        print(json.dumps({
            'status': 'READY',
            'endpoint': args.endpoint,
            'started': False,
            'runtime_revision': RUNTIME_REVISION,
        }))
        return 0
    try:
        _start_bridge()
    except (OSError, RuntimeError) as error:
        print(json.dumps({'status': 'UNAVAILABLE', 'endpoint': args.endpoint, 'error': str(error)}))
        return 2
    deadline = time.monotonic() + args.startup_timeout_seconds
    while time.monotonic() < deadline:
        ready_status = _bridge_status(args.endpoint, args.health_timeout_seconds)
        if (
            ready_status is not None
            and ready_status.get('runtime_revision') == RUNTIME_REVISION
            and ready_status.get('bridge_revision') == BRIDGE_REVISION
        ):
            print(json.dumps({
                'status': 'READY',
                'endpoint': args.endpoint,
                'started': True,
                'runtime_revision': RUNTIME_REVISION,
            }))
            return 0
        time.sleep(0.25)
    print(json.dumps({
        'status': 'UNAVAILABLE',
        'endpoint': args.endpoint,
        'error': f'Real Valhalla bridge did not become healthy within {args.startup_timeout_seconds} seconds',
    }))
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
