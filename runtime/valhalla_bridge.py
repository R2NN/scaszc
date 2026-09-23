from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

from aiohttp import web


CLI = Path('/tmp/valhalla_route_cli')
CONFIG = Path('/tmp/valhalla-generated.json')
RUNTIME_REVISION = 'valhalla-3.8.3-runtime-schema-v2'
BRIDGE_REVISION = 'worker-pool-v8'
ROUTE_TIMEOUT_SECONDS = 25
MATRIX_TIMEOUT_SECONDS = 60
QUEUE_TIMEOUT_SECONDS = 10


def tile_revision() -> str:
    """Identify the mounted tile snapshot without hashing a large archive."""
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
    tile_path = Path(config['mjolnir']['tile_extract'])
    metadata = tile_path.stat()
    config_hash = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
    identity = f'{tile_path}:{metadata.st_size}:{metadata.st_mtime_ns}:{config_hash}'
    return hashlib.sha256(identity.encode('utf-8')).hexdigest()


class ValhallaWorker:
    """One persistent actor; only one request may use its stdio at a time."""

    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        if self.process is not None and self.process.returncode is None:
            return
        self.process = await asyncio.create_subprocess_exec(
            str(CLI),
            str(CONFIG),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=2 * 1024 * 1024,
        )

    async def close(self) -> None:
        process = self.process
        self.process = None
        if process is not None and process.returncode is None:
            process.terminate()
            await process.wait()

    async def restart(self) -> None:
        await self.close()
        await self.start()

    async def query(self, line: bytes, *, timeout_seconds: float = ROUTE_TIMEOUT_SECONDS) -> bytes:
        for attempt in range(2):
            if self.process is None or self.process.returncode is not None:
                await self.start()
            process = self.process
            assert process is not None
            assert process.stdin is not None
            assert process.stdout is not None
            try:
                process.stdin.write(line)
                await process.stdin.drain()
                deadline = asyncio.get_running_loop().time() + timeout_seconds
                while asyncio.get_running_loop().time() < deadline:
                    remaining = deadline - asyncio.get_running_loop().time()
                    response = await asyncio.wait_for(
                        process.stdout.readline(), timeout=remaining
                    )
                    if not response:
                        break
                    try:
                        parsed = json.loads(response)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        # The local CLI may print startup diagnostics first.
                        continue
                    if isinstance(parsed, dict):
                        return response
            except (BrokenPipeError, ConnectionError, asyncio.TimeoutError):
                pass
            if attempt == 0:
                await self.restart()
        raise web.HTTPServiceUnavailable(
            text='Valhalla worker returned no JSON response after restart'
        )


class ValhallaBridge:
    """Route independent requests to an explicitly bounded pool of actors."""

    def __init__(self, workers: int) -> None:
        if workers < 1:
            raise ValueError('Valhalla worker count must be positive')
        self.workers = [ValhallaWorker() for _ in range(workers)]
        self.available: asyncio.Queue[ValhallaWorker] = asyncio.Queue()
        self.requests_total = 0
        self.failed_requests = 0
        self.queue_wait_seconds = 0.0
        self.execution_seconds = 0.0

    async def start(self) -> None:
        try:
            for worker in self.workers:
                await worker.start()
                self.available.put_nowait(worker)
        except OSError:
            await self.close()
            raise

    async def close(self) -> None:
        await asyncio.gather(*(worker.close() for worker in self.workers))

    async def healthy(self) -> bool:
        return any(
            worker.process is not None and worker.process.returncode is None
            for worker in self.workers
        )

    async def route(self, request: web.Request) -> web.Response:
        payload = await request.json()
        line = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        self.requests_total += 1
        queued_at = time.perf_counter()
        try:
            worker = await asyncio.wait_for(
                self.available.get(), timeout=QUEUE_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError as error:
            self.failed_requests += 1
            raise web.HTTPServiceUnavailable(text='Valhalla worker pool is busy') from error
        self.queue_wait_seconds += time.perf_counter() - queued_at
        execution_started = time.perf_counter()
        try:
            timeout_seconds = (
                MATRIX_TIMEOUT_SECONDS
                if request.path == '/sources_to_targets'
                else ROUTE_TIMEOUT_SECONDS
            )
            response_line = await worker.query(line, timeout_seconds=timeout_seconds)
        except Exception:
            self.failed_requests += 1
            raise
        finally:
            self.execution_seconds += time.perf_counter() - execution_started
            self.available.put_nowait(worker)
        return web.Response(body=response_line, content_type='application/json')


async def status(request: web.Request) -> web.Response:
    bridge: ValhallaBridge = request.app['bridge']
    if not await bridge.healthy():
        raise web.HTTPServiceUnavailable(text='Valhalla workers are not running')
    return web.json_response({
        'status': 'ok',
        'runtime_revision': RUNTIME_REVISION,
        'bridge_revision': BRIDGE_REVISION,
        'tile_revision': tile_revision(),
        'worker_count': len(bridge.workers),
        'available_workers': bridge.available.qsize(),
        'requests_total': bridge.requests_total,
        'failed_requests': bridge.failed_requests,
        'queue_wait_seconds': round(bridge.queue_wait_seconds, 3),
        'execution_seconds': round(bridge.execution_seconds, 3),
    })


async def create_app() -> web.Application:
    worker_count = int(os.environ.get('VALHALLA_BRIDGE_WORKERS', '6'))
    bridge = ValhallaBridge(worker_count)
    await bridge.start()
    app = web.Application(client_max_size=2 * 1024 * 1024)
    app['bridge'] = bridge
    app.router.add_post('/route', bridge.route)
    app.router.add_post('/sources_to_targets', bridge.route)
    app.router.add_get('/status', status)

    async def cleanup(_: web.Application) -> None:
        await bridge.close()

    app.on_cleanup.append(cleanup)
    return app


if __name__ == '__main__':
    web.run_app(create_app(), host='0.0.0.0', port=8002, access_log=None)
