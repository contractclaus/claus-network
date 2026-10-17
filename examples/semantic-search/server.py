"""Bounded local embedding inference. No runtime downloads, keys, storage or tools."""
from admission import Admission, AdmissionError
import hashlib
import io
from http.server import BaseHTTPRequestHandler, HTTPServer
from http.client import parse_headers, HTTPException
import json
import os
from pathlib import Path
import signal
import selectors
import socket
import socketserver
import threading
import time

os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('OMP_NUM_THREADS', '2')
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
        settings.intra_op_num_threads = 2
        settings.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(ROOT / 'model/onnx/model_quantized.onnx'), sess_options=settings, providers=['CPUExecutionProvider'])
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.lock = threading.BoundedSemaphore(1)
        self.state_lock = threading.Lock()
        self.inference_started = None
        self.warmed = False
        self.embed(['Claus Network'])
        self.warmed = True

    def ready(self):
        with self.state_lock:
            return self.warmed and (self.inference_started is None or
                                   time.monotonic() - self.inference_started < REQUEST_DEADLINE)

    def embed(self, texts, meter=None):
        if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_BATCH:
            raise ValueError('input_requires_1_to_16_texts')
        if any(not isinstance(t, str) or not t.strip() or len(t) > MAX_TEXT for t in texts):
            raise ValueError('text_requires_1_to_2048_characters')
        for text in texts:
            text.encode('utf-8')  # Reject JSON-escaped lone surrogates before inference.
        # Tokenization is bounded by MAX_BATCH/MAX_TEXT and consumes no model
        # worker. Empty normalized texts must not acquire a mean embedding.
        examples = list(dict.fromkeys(texts))
        encoded = self.tokenizer.encode_batch(examples)
        if any(not any(i not in (0, 101, 102) for i in value.ids) for value in encoded):
            raise ValueError('text_requires_content_tokens')
        if not self.lock.acquire(timeout=3):
            raise BlockingIOError('inference_busy')
        refund = None
        try:
            # Busy callers spend only the admission unit. Reserve the model
            # cost only once the worker is ours, and return it on failure.
            if meter is not None:
                refund = meter(max(1, (sum(sum(v.attention_mask) for v in encoded) + 63) // 64))
            with self.state_lock:
                self.inference_started = time.monotonic()
            # Reuse is confined to this request; another caller's input cannot
            # influence a cache hit, timing shortcut or public inference counter.
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
            refund = None
            return [answers[text] for text in texts]
        except BaseException:
            if refund is not None:
                refund()
            raise
        finally:
            with self.state_lock:
                self.inference_started = None
            self.lock.release()


class Server(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = False
    allow_reuse_address = True
    request_deadline = REQUEST_DEADLINE
    header_deadline = 1
    body_deadline = 2
    response_timeout = 1
    max_pending_headers = 256
    max_header_bytes = 8192
    request_queue_size = 1024
    accept_batch = 64

    def __init__(self, *args, **kwargs):
        self.workers = threading.BoundedSemaphore(24)
        self.health_workers = threading.BoundedSemaphore(2)
        self.admission = Admission()
        self.headers = selectors.DefaultSelector()
        self.pending_headers = {}
        self.request_prefixes = {}
        self.request_expiry = {}
        self.request_pools = {}
        super().__init__(*args, **kwargs)

    def server_activate(self):
        super().server_activate()
        self.socket.setblocking(False)

    def _handle_request_noblock(self):
        # Drain a bounded burst instead of one accept per selector cycle.
        # Serve readable headers between bursts so arrivals cannot starve them.
        self.service_actions()
        for index in range(self.accept_batch):
            try:
                request, address = self.get_request()
            except OSError:
                break
            if not self.verify_request(request, address):
                self.shutdown_request(request)
                continue
            try:
                self.process_request(request, address)
            except Exception:
                self.handle_error(request, address)
                self.shutdown_request(request)
            except BaseException:
                self.shutdown_request(request)
                raise
            if index % 16 == 15:
                self.service_actions()

    def process_request(self, request, client_address):
        # Incomplete requests never occupy application workers, even when
        # their headers contain a valid admission ticket.
        if len(self.pending_headers) >= self.max_pending_headers:
            # Anonymous arrivals cannot evict signature-verified requests.
            oldest = next((sock for sock, entry in self.pending_headers.items()
                           if entry[3] is None), None)
            if oldest is None:
                self.reject_connection(request, 503)
                return
            self.remove_pending(oldest)
            self.reject_connection(oldest, 503)
        request.setblocking(False)
        now = time.monotonic()
        self.pending_headers[request] = (client_address, bytearray(), now, None)
        self.headers.register(request, selectors.EVENT_READ)

    def serve_forever(self, poll_interval=0.02):
        super().serve_forever(poll_interval=min(poll_interval, 0.02))

    def reject_connection(self, request, status):
        reason = BaseHTTPRequestHandler.responses[status][0]
        retry = 'Retry-After: 1\r\n' if status in (408, 429, 503) else ''
        response = (f'HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n'
                    f'Connection: close\r\n{retry}\r\n').encode()
        try:
            request.setblocking(False)
            request.send(response)
        except OSError:
            pass
        self.shutdown_request(request)

    def remove_pending(self, request):
        self.headers.unregister(request)
        return self.pending_headers.pop(request)

    def service_actions(self):
        for key, _ in self.headers.select(timeout=0):
            request = key.fileobj
            address, prefix, accepted_at, target = self.pending_headers[request]
            deadline = self.header_deadline if target is None else self.body_deadline
            if time.monotonic() - accepted_at >= min(deadline, self.request_deadline):
                self.remove_pending(request)
                self.reject_connection(request, 408)
                continue
            try:
                bound = self.max_header_bytes + 1 if target is None else target
                data = request.recv(bound - len(prefix))
            except BlockingIOError:
                continue
            except OSError:
                data = b''
            if not data:
                self.remove_pending(request)
                self.shutdown_request(request)
                continue
            prefix.extend(data)
            if target is None:
                boundary = prefix.find(b'\r\n\r\n')
                if boundary < 0 or boundary + 4 > self.max_header_bytes:
                    if len(prefix) > self.max_header_bytes:
                        self.remove_pending(request)
                        self.reject_connection(request, 431)
                    continue
                # Use the same standard-library header parser as Handler.
                # Validate framing before reserving an inference worker.
                try:
                    first_line, _, header_bytes = bytes(prefix[:boundary]).partition(b'\r\n')
                    # BaseHTTPRequestHandler otherwise accepts arbitrary
                    # whitespace. Reject noncanonical lines before dispatch,
                    # so its method cannot differ from our body/health routing.
                    parts = first_line.split(b' ')
                    if (len(parts) != 3 or any(not part for part in parts)
                            or any(byte < 33 or byte > 126 for part in parts for byte in part)
                            or parts[2] not in (b'HTTP/1.0', b'HTTP/1.1')):
                        raise ValueError(400)
                    headers = parse_headers(io.BytesIO(header_bytes + b'\r\n\r\n'))
                    body_size = 0
                    if parts[0] == b'POST':
                        if headers.get('Transfer-Encoding') or headers.get_content_type() != 'application/json':
                            raise ValueError(415)
                        lengths = headers.get_all('Content-Length', [])
                        if (len(lengths) != 1 or not 1 <= len(lengths[0]) <= 5
                                or not lengths[0].isascii() or not lengths[0].isdigit()
                                or not 1 <= int(lengths[0]) <= MAX_BODY):
                            raise ValueError(413)
                        body_size = int(lengths[0])
                        authorizations = headers.get_all('Authorization', [])
                        self.admission.verify_header(authorizations[0] if len(authorizations) == 1 else None,
                                                     parts[1].decode('ascii'))
                    target = boundary + 4 + body_size
                except (ValueError, HTTPException, AdmissionError) as error:
                    status = error.status if isinstance(error, AdmissionError) else error.args[0] if isinstance(error, ValueError) and error.args and isinstance(error.args[0], int) else 400
                    self.remove_pending(request)
                    self.reject_connection(request, status)
                    continue
                self.pending_headers[request] = (address, prefix, accepted_at, target)
                expectation = headers.get('Expect', '').lower()
                if expectation:
                    if expectation != '100-continue':
                        self.remove_pending(request)
                        self.reject_connection(request, 417)
                        continue
                    if len(prefix) < target:
                        interim = b'HTTP/1.1 100 Continue\r\n\r\n'
                        try:
                            if request.send(interim) != len(interim):
                                raise OSError('incomplete_interim_response')
                        except OSError:
                            self.remove_pending(request)
                            self.shutdown_request(request)
                            continue
            if len(prefix) >= target:
                self.remove_pending(request)
                request.setblocking(True)
                self.dispatch_request(request, address, bytes(prefix[:target]), accepted_at)
        now = time.monotonic()
        for request, (_, _, accepted_at, target) in list(self.pending_headers.items()):
            deadline = self.header_deadline if target is None else self.body_deadline
            if now - accepted_at >= min(deadline, self.request_deadline):
                self.remove_pending(request)
                self.reject_connection(request, 408)

    def dispatch_request(self, request, client_address, prefix, accepted_at):
        line = prefix.split(b'\r\n', 1)[0]
        health = line in (b'GET /health HTTP/1.1', b'HEAD /health HTTP/1.1',
                          b'GET /health HTTP/1.0', b'HEAD /health HTTP/1.0')
        pool = self.health_workers if health else self.workers
        if not pool.acquire(blocking=False):
            self.reject_connection(request, 503)
            return
        self.request_prefixes[request] = prefix
        self.request_expiry[request] = accepted_at + self.request_deadline
        self.request_pools[request] = pool
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_prefixes.pop(request, None)
            self.request_expiry.pop(request, None)
            self.request_pools.pop(request).release()
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

        remaining = max(0, self.request_expiry.pop(request) - time.monotonic())
        deadline = threading.Timer(remaining, expire)
        deadline.daemon = True
        try:
            deadline.start()
            super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            self.request_prefixes.pop(request, None)
            self.request_pools.pop(request).release()

    def server_close(self):
        for request in list(self.pending_headers):
            self.remove_pending(request)
            self.shutdown_request(request)
        self.headers.close()
        super().server_close()

    def handle_error(self, request, client_address):
        # Malformed/disconnected clients must not expose addresses or requests.
        pass


class PrefixedReader:
    """Replay pre-read bytes through the standard HTTP parser, without reparsing."""
    def __init__(self, prefix, source):
        self.prefix, self.source = io.BytesIO(prefix), source

    def readline(self, size=-1):
        head = self.prefix.readline(size)
        if head.endswith(b'\n') or size >= 0 and len(head) == size:
            return head
        return head + self.source.readline(-1 if size < 0 else size - len(head))

    def read(self, size=-1):
        head = self.prefix.read(size)
        if size >= 0 and len(head) == size:
            return head
        return head + self.source.read(-1 if size < 0 else size - len(head))

    def close(self):
        self.prefix.close()
        self.source.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def handle_expect_100(self):
        # Already handled before buffering the body, without a worker slot.
        return True

    def version_string(self):
        return 'Claus'

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {'error':'http_error','status':code})

    def setup(self):
        super().setup()
        self.rfile = PrefixedReader(self.server.request_prefixes.pop(self.connection, b''), self.rfile)
        self.connection.settimeout(5)

    def log_message(self, *_):
        pass  # No prompts, query strings or client addresses in logs.

    def reply(self, status, body):
        data = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
        self.connection.settimeout(self.server.response_timeout)
        self.send_response(status)
        for key, value in {'Content-Type': 'application/json', 'Content-Length': str(len(data)), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff'}.items():
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
            ready = self.server.engine.ready()
            return self.reply(200 if ready else 503, {'status': 'ok' if ready else 'unavailable', 'model': MODEL, 'dimensions': DIMENSIONS})
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
        claims = None
        try:
            headers = self.headers.get_all('Authorization', [])
            claims = self.server.admission.begin(headers[0] if len(headers) == 1 else None, self.path)
            body = self.rfile.read(int(lengths[0]))
            if len(body) != int(lengths[0]):
                raise ValueError('incomplete_request')
            self.server.admission.verify_body(claims, body)
            try:
                data = json.loads(body)
            except RecursionError:
                raise ValueError('invalid_json') from None
            if not isinstance(data, dict):
                raise ValueError('object_required')
            if self.path == '/v1/embeddings':
                if data.get('model', MODEL) not in [MODEL, LOCK['model']['repository']]:
                    raise ValueError('model_not_available')
                texts = data.get('input')
                vectors = self.server.engine.embed([texts] if isinstance(texts, str) else texts,
                                                  meter=lambda cost: self.server.admission.charge(claims, cost))
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
            vectors = np.asarray(self.server.engine.embed([data.get('query')] + [d.get('text') for d in documents],
                                                        meter=lambda cost: self.server.admission.charge(claims, cost)))
            scores = np.clip(vectors[1:] @ vectors[0], -1.0, 1.0)
            results = sorted([{'id': i, 'score': float(s)} for i, s in zip(ids, scores)], key=lambda v: (-v['score'], v['id']))[:limit]
            self.reply(200, {'model': MODEL, 'results': results})
        except AdmissionError as error:
            self.reply(error.status, {'error': error.code})
        except (ValueError, UnicodeError) as error:
            self.reply(400, {'error': str(error) if str(error).replace('_', '').isalnum() else 'invalid_json'})
        except BlockingIOError:
            self.reply(429, {'error': 'inference_busy'})
        except (TimeoutError, OSError):
            self.close_connection = True
        except Exception:
            self.reply(503, {'error': 'inference_unavailable'})
        finally:
            if claims is not None:
                self.server.admission.finish(claims)


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
