from __future__ import annotations

import asyncio
import json
from pathlib import Path

from aiohttp import web


CLI = Path('/tmp/valhalla_route_cli')
CONFIG = Path('/tmp/valhalla-generated.json')
RUNTIME_REVISION = 'valhalla-3.8.3-runtime-schema-v1'
# ExactRoutingOracle times out its HTTP request after 30 seconds. Keep the
# bridge timeout below that limit so a wedged worker cannot hold the single
# serialized worker and make all following requests time out as well.
ROUTE_TIMEOUT_SECONDS = 25


class ValhallaBridge:
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        self._process = await asyncio.create_subprocess_exec(
            str(CLI),
            str(CONFIG),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=2 * 1024 * 1024,
        )

    async def close(self) -> None:
        if self._process is None:
            return
        self._process.terminate()
        await self._process.wait()
        self._process = None

    async def _restart(self) -> None:
        """Replace a dead worker before retrying one real routing request."""
        if self._process is not None and self._process.returncode is None:
            self._process.terminate()
            await self._process.wait()
        self._process = None
        await self.start()

    async def healthy(self) -> bool:
        """Return whether the bridge has a live Valhalla worker."""
        async with self._lock:
            if self._process is None or self._process.returncode is not None:
                try:
                    await self.start()
                except OSError:
                    return False
            return self._process is not None and self._process.returncode is None

    async def route(self, request: web.Request) -> web.Response:
        payload = await request.json()
        line = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        async with self._lock:
            response_line = b''
            for attempt in range(2):
                if self._process is None or self._process.returncode is not None:
                    await self.start()
                process = self._process
                assert process is not None
                assert process.stdin is not None
                assert process.stdout is not None
                try:
                    process.stdin.write(line)
                    await process.stdin.drain()
                    deadline = asyncio.get_running_loop().time() + ROUTE_TIMEOUT_SECONDS
                    candidate = b''
                    # The local Valhalla CLI emits startup diagnostics on stdout
                    # before its first JSON response. Consume only those lines;
                    # no route is invented if no JSON response arrives.
                    while asyncio.get_running_loop().time() < deadline:
                        remaining = deadline - asyncio.get_running_loop().time()
                        response = await asyncio.wait_for(
                            process.stdout.readline(),
                            timeout=remaining,
                        )
                        if not response:
                            break
                        try:
                            parsed = json.loads(response)
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            continue
                        if isinstance(parsed, dict):
                            candidate = response
                            break
                except (BrokenPipeError, ConnectionError, asyncio.TimeoutError):
                    if attempt == 0:
                        await self._restart()
                        continue
                    raise web.HTTPServiceUnavailable(
                        text='Valhalla worker is unavailable after restart'
                    )
                if not candidate:
                    if attempt == 0:
                        await self._restart()
                        continue
                    raise web.HTTPBadGateway(
                        text='Valhalla worker returned no response after restart'
                    )
                response_line = candidate
                break
        if not response_line:
            raise web.HTTPBadGateway(text='Valhalla worker returned no JSON response')
        return web.Response(body=response_line, content_type='application/json')


async def status(request: web.Request) -> web.Response:
    bridge: ValhallaBridge = request.app['bridge']
    if not await bridge.healthy():
        raise web.HTTPServiceUnavailable(text='Valhalla worker is not running')
    return web.json_response({
        'status': 'ok',
        'runtime_revision': RUNTIME_REVISION,
    })


async def create_app() -> web.Application:
    bridge = ValhallaBridge()
    await bridge.start()
    app = web.Application(client_max_size=2 * 1024 * 1024)
    app['bridge'] = bridge
    app.router.add_post('/route', bridge.route)
    app.router.add_get('/status', status)

    async def cleanup(_: web.Application) -> None:
        await bridge.close()

    app.on_cleanup.append(cleanup)
    return app


if __name__ == '__main__':
    web.run_app(create_app(), host='0.0.0.0', port=8002, access_log=None)
