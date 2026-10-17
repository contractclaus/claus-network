import http.client
import json
import threading
import unittest
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
        before = self.engine.calls
        for path, data in [('/v1/embeddings', {'input': []}), ('/v1/embeddings', {'input': 'x' * 2049}), ('/v1/embeddings', {'input': 'hello', 'model': 'arbitrary'}), ('/v1/search', {'query': 'q', 'documents': [{'id': 'x', 'text': 'a'}, {'id': 'x', 'text': 'b'}]})]:
            status, _ = self.call(path, data)
            self.assertEqual(status, 400)
        self.assertEqual(self.engine.calls, before)


if __name__ == '__main__':
    unittest.main()
