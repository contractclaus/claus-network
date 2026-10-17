import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import numpy as np
from server import Engine, Handler, Server, MODEL


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine()
        cls.server = Server(('127.0.0.1', 0), Handler)
        cls.server.engine = cls.engine
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def call(self, path, payload):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        conn.request('POST', path, json.dumps(payload), {'Content-Type': 'application/json'})
        response = conn.getresponse()
        result = json.loads(response.read())
        conn.close()
        return response.status, result

    def test_vectors_and_reuse(self):
        status, result = self.call('/v1/embeddings', {'input': ['Claus Network', 'Claus Network']})
        self.assertEqual(status, 200)
        self.assertEqual(result['model'], MODEL)
        vectors = [x['embedding'] for x in result['data']]
        self.assertEqual(len(vectors[0]), 384)
        self.assertTrue(np.isfinite(vectors).all())
        self.assertAlmostEqual(float(np.linalg.norm(vectors[0])), 1, places=5)
        self.assertEqual(vectors[0], vectors[1])

    def test_useful_semantic_ranking(self):
        fixtures = [
            {'id': 'jobs', 'text': 'Agents hire developers, offer paid tasks and pay for completed coding work.'},
            {'id': 'health', 'text': 'Monitors whether websites and API endpoints are up or down.'},
            {'id': 'check', 'text': 'Checks project configuration and API integration readiness.'},
        ]
        for query, expected in [('find a programming job', 'jobs'), ('is my server offline', 'health')]:
            status, result = self.call('/v1/search', {'query': query, 'documents': fixtures, 'limit': 1})
            self.assertEqual(status, 200)
            self.assertEqual(result['results'][0]['id'], expected)

    def test_invalid_requests_do_not_infer(self):
        with patch.object(self.engine.session, 'run', wraps=self.engine.session.run) as infer:
            for path, data in [('/v1/embeddings', {'input': []}), ('/v1/embeddings', {'input': 'x' * 2049}), ('/v1/embeddings', {'input': 'hello', 'model': 'arbitrary'}), ('/v1/search', {'query': 'q', 'documents': [{'id': 'x', 'text': 'a'}, {'id': 'x', 'text': 'b'}]})]:
                status, _ = self.call(path, data)
                self.assertEqual(status, 400)
            infer.assert_not_called()

    def test_no_cross_request_cache_or_public_counter(self):
        with patch.object(self.engine.session, 'run', wraps=self.engine.session.run) as infer:
            first = self.call('/v1/embeddings', {'input': ['private sentence', 'private sentence']})
            second = self.call('/v1/embeddings', {'input': ['private sentence', 'private sentence']})
            self.assertEqual(first, second)
            self.assertEqual(infer.call_count, 2)
            self.assertFalse(hasattr(self.engine, 'cache'))
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request('GET', '/health')
        response = conn.getresponse()
        self.assertEqual(set(json.loads(response.read())), {'status', 'model', 'dimensions'})
        conn.close()

    def test_non_ascii_content_length_is_rejected(self):
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as conn:
            conn.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: \xb2\r\n\r\n')
            self.assertIn(b'413', conn.recv(4096).split(b'\r\n', 1)[0])

    def test_absolute_deadline_releases_dripped_headers_and_bodies(self):
        server = Server(('127.0.0.1', 0), Handler)
        server.engine = self.engine
        server.request_deadline = 0.4
        server.workers = threading.BoundedSemaphore(1)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02})
        worker.start()
        try:
            for start in [b'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ', b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n']:
                with self.subTest(start=start), socket.create_connection(('127.0.0.1', server.server_port), timeout=2) as conn:
                    conn.sendall(start)
                    stopped = threading.Event()
                    def drip():
                        try:
                            while not stopped.wait(0.05):
                                conn.sendall(b'a')
                        except OSError:
                            pass
                    dripper = threading.Thread(target=drip)
                    dripper.start()
                    before = time.monotonic()
                    try:
                        self.assertEqual(conn.recv(4096), b'')
                        self.assertLess(time.monotonic() - before, 1.5)
                    finally:
                        stopped.set()
                        dripper.join()
                self.assertTrue(server.workers.acquire(timeout=1))
                server.workers.release()
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                conn.request('GET', '/health')
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                conn.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_sigterm_drains_and_exits(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        env = dict(os.environ, PORT=str(port))
        process = subprocess.Popen([sys.executable, '-c', 'import server; server.Server.request_deadline = 0.4; server.main()'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        slow = None
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    slow = socket.create_connection(('127.0.0.1', port), timeout=0.2)
                    break
                except OSError:
                    self.assertIsNone(process.poll())
                    time.sleep(0.05)
            self.assertIsNotNone(slow)
            slow.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ')
            process.terminate()
            stdout, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 0, stderr.decode())
            self.assertEqual(stdout, b'')
            self.assertEqual(stderr, b'')
        finally:
            if slow is not None:
                slow.close()
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == '__main__':
    unittest.main()
