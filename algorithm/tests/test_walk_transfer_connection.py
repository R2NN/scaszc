from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'algorithm' / 'tools'))

from build_walk_transfers import matrix  # noqa: E402


class CountingServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.accepted_connections = 0

    def get_request(self):
        self.accepted_connections += 1
        return super().get_request()


class MatrixHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_POST(self):
        length = int(self.headers['Content-Length'])
        request = json.loads(self.rfile.read(length))
        rows = [[{'time': 17, 'distance': 0.2} for _ in request['targets']]
                for _ in request['sources']]
        body = json.dumps({'sources_to_targets': rows}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class WalkTransferConnectionTests(unittest.TestCase):
    def test_repeated_matrices_share_one_tcp_connection(self) -> None:
        server = CountingServer(('127.0.0.1', 0), MatrixHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f'http://127.0.0.1:{server.server_port}/sources_to_targets'
        try:
            for _ in range(3):
                rows = matrix(endpoint, [(55.75, 37.61)], [(55.72, 37.65)])
                self.assertEqual(rows[0][0]['time'], 17)
            self.assertEqual(server.accepted_connections, 1)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
