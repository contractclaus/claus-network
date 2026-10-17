"""Bounded local embedding inference. No runtime downloads, keys, storage or tools."""
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import signal
import socket
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
REQUEST_DEADLINE = 10


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
            # Reuse is confined to this request; another caller's input cannot
            # influence a cache hit, timing shortcut or public inference counter.
            examples = list(dict.fromkeys(texts))
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
            if vectors.shape != (len(examples), DIMENSIONS) or not np.isfinite(vectors).all():
                raise RuntimeError('model_output_invalid')
            answers = dict(zip(examples, vectors.astype(np.float32).tolist()))
            return [answers[text] for text in texts]
        finally:
            self.lock.release()


class Server(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = False
    allow_reuse_address = True
    request_deadline = REQUEST_DEADLINE

    def __init__(self, *args, **kwargs):
        self.workers = threading.BoundedSemaphore(24)
        super().__init__(*args, **kwargs)

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
        # Socket timeouts alone restart on every successful read. Closing the
        # socket at an absolute deadline also bounds dripped headers and bodies.
        def expire():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            request.close()

        deadline = threading.Timer(self.request_deadline, expire)
        deadline.daemon = True
        try:
            deadline.start()
            super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            self.workers.release()

    def handle_error(self, request, client_address):
        # Malformed/disconnected clients must not expose addresses or requests.
        pass


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
            return self.reply(200, {'status': 'ok', 'model': MODEL, 'dimensions': DIMENSIONS})
        if self.path == '/':
            return self.reply(200, {'service': 'Claus Semantic Search', 'model': MODEL, 'dimensions': DIMENSIONS, 'endpoints': ['/health', '/v1/embeddings', '/v1/search'], 'modelLicense': 'Apache-2.0', 'billing': 'No per-request charge; funded bounded CPU lease', 'limits': {'batch': MAX_BATCH, 'textCharacters': MAX_TEXT, 'requestBytes': MAX_BODY}})
        self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path not in ['/v1/embeddings', '/v1/search']:
            return self.reply(404, {'error': 'not_found'})
        if self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'json_content_length_required'})
        lengths = self.headers.get_all('Content-Length', [])
        if (len(lengths) != 1 or not 1 <= len(lengths[0]) <= 5
                or not lengths[0].isascii() or not lengths[0].isdigit()
                or not 1 <= int(lengths[0]) <= MAX_BODY):
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


def main():
    engine = Engine()
    server = Server(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler)
    server.engine = engine
    stopping = threading.Event()

    def stop(_signum, _frame):
        if not stopping.is_set():
            stopping.set()
            # shutdown() must not run in the serve_forever thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
