"""Bounded local embedding inference. No runtime downloads, keys, storage or tools."""
from collections import OrderedDict
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import socketserver
import threading
import time

os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('OMP_NUM_THREADS', '1')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent
LOCK = json.loads((ROOT / 'model-lock.json').read_text())
MODEL = LOCK['model']['repository'] + '@' + LOCK['model']['commit']
MAX_BODY = 65536
MAX_TEXT = 2048
MAX_BATCH = 16
DIMENSIONS = 384


class Engine:
    def __init__(self):
        for item in LOCK['model']['files']:
            data = (ROOT / item['path']).read_bytes()
            if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('model_integrity_mismatch')
        self.tokenizer = Tokenizer.from_file(str(ROOT / 'model/tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
        settings = ort.SessionOptions()
        settings.intra_op_num_threads = 1
        settings.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(ROOT / 'model/onnx/model_quantized.onnx'), sess_options=settings, providers=['CPUExecutionProvider'])
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.lock = threading.BoundedSemaphore(1)
        self.cache = OrderedDict()
        self.calls = 0
        self.tokens = 120.0
        self.refill_at = time.monotonic()
        self.rate_lock = threading.Lock()
        self.embed(['Claus Network'])

    def admit(self):
        with self.rate_lock:
            current = time.monotonic()
            self.tokens = min(120.0, self.tokens + (current - self.refill_at) * 2)
            self.refill_at = current
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True

    def embed(self, texts):
        if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_BATCH:
            raise ValueError('input_requires_1_to_16_texts')
        if any(not isinstance(t, str) or not t.strip() or len(t) > MAX_TEXT for t in texts):
            raise ValueError('text_requires_1_to_2048_characters')
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError('inference_busy')
        try:
            keys = [hashlib.sha256(text.encode()).hexdigest() for text in texts]
            missing = list(dict.fromkeys(k for k in keys if k not in self.cache))
            if missing:
                examples = [texts[keys.index(key)] for key in missing]
                encoded = self.tokenizer.encode_batch(examples)
                values = {
                    'input_ids': np.array([v.ids for v in encoded], dtype=np.int64),
                    'attention_mask': np.array([v.attention_mask for v in encoded], dtype=np.int64),
                    'token_type_ids': np.array([v.type_ids for v in encoded], dtype=np.int64),
                }
                hidden = self.session.run(None, {k: v for k, v in values.items() if k in self.input_names})[0]
                mask = values['attention_mask'][:, :, None]
                pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1)
                vectors = pooled / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
                if vectors.shape != (len(missing), DIMENSIONS) or not np.isfinite(vectors).all():
                    raise RuntimeError('model_output_invalid')
                for key, vector in zip(missing, vectors):
                    self.cache[key] = vector.astype(np.float32).tolist()
                self.calls += 1
            answer = [self.cache[key] for key in keys]
            for key in keys:
                self.cache.move_to_end(key)
            while len(self.cache) > 512:
                self.cache.popitem(last=False)
            return answer
        finally:
            self.lock.release()


class Server(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    workers = threading.BoundedSemaphore(24)

    def process_request(self, request, client_address):
        if not self.workers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.workers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.workers.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_):
        pass  # No prompts, query strings or client addresses in logs.

    def reply(self, status, body):
        data = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status)
        for key, value in {'Content-Type': 'application/json', 'Content-Length': str(len(data)), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff'}.items():
            self.send_header(key, value)
        if status == 429:
            self.send_header('Retry-After', '1')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)
        self.close_connection = True

    def do_OPTIONS(self):
        self.reply(200, {})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'status': 'ok', 'model': MODEL, 'dimensions': DIMENSIONS, 'inferenceCalls': self.server.engine.calls})
        if self.path == '/':
            return self.reply(200, {'service': 'Claus Semantic Search', 'model': MODEL, 'dimensions': DIMENSIONS, 'endpoints': ['/health', '/v1/embeddings', '/v1/search'], 'modelLicense': 'Apache-2.0', 'billing': 'No per-request charge; funded bounded CPU lease', 'limits': {'batch': MAX_BATCH, 'textCharacters': MAX_TEXT, 'requestBytes': MAX_BODY}})
        self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path not in ['/v1/embeddings', '/v1/search']:
            return self.reply(404, {'error': 'not_found'})
        if self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'json_content_length_required'})
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not lengths[0].isdigit() or not 1 <= int(lengths[0]) <= MAX_BODY:
            return self.reply(413, {'error': 'request_size_invalid'})
        if not self.server.engine.admit():
            return self.reply(429, {'error': 'rate_limited'})
        try:
            body = self.rfile.read(int(lengths[0]))
            if len(body) != int(lengths[0]):
                raise ValueError('incomplete_request')
            data = json.loads(body)
            if not isinstance(data, dict):
                raise ValueError('object_required')
            if self.path == '/v1/embeddings':
                if data.get('model', MODEL) not in [MODEL, LOCK['model']['repository']]:
                    raise ValueError('model_not_available')
                texts = data.get('input')
                vectors = self.server.engine.embed([texts] if isinstance(texts, str) else texts)
                return self.reply(200, {'object': 'list', 'model': MODEL, 'data': [{'object': 'embedding', 'index': i, 'embedding': v} for i, v in enumerate(vectors)]})
            documents = data.get('documents')
            if not isinstance(documents, list) or not 1 <= len(documents) < MAX_BATCH:
                raise ValueError('documents_requires_1_to_15_items')
            ids = [d.get('id') if isinstance(d, dict) else None for d in documents]
            if any(not isinstance(i, str) or not 1 <= len(i) <= 128 for i in ids) or len(set(ids)) != len(ids):
                raise ValueError('unique_document_ids_required')
            limit = data.get('limit', 5)
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 15:
                raise ValueError('limit_requires_1_to_15')
            vectors = np.asarray(self.server.engine.embed([data.get('query')] + [d.get('text') for d in documents]))
            scores = vectors[1:] @ vectors[0]
            results = sorted([{'id': i, 'score': float(s)} for i, s in zip(ids, scores)], key=lambda v: (-v['score'], v['id']))[:limit]
            self.reply(200, {'model': MODEL, 'results': results})
        except (ValueError, UnicodeError) as error:
            self.reply(400, {'error': str(error) if str(error).replace('_', '').isalnum() else 'invalid_json'})
        except BlockingIOError:
            self.reply(429, {'error': 'inference_busy'})
        except (TimeoutError, OSError):
            self.close_connection = True
        except Exception:
            self.reply(503, {'error': 'inference_unavailable'})


if __name__ == '__main__':
    engine = Engine()
    server = Server(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler)
    server.engine = engine
    server.serve_forever(poll_interval=0.25)
