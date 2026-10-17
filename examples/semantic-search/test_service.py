import base64
import hashlib
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from admission import Admission, AdmissionError, DOMAIN
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
from server import Engine, Handler, Server, MODEL, DIMENSIONS


KEY = Ed25519PrivateKey.generate()
CONFIG = {'publicKey': base64.urlsafe_b64encode(KEY.public_key().public_bytes_raw()).decode().rstrip('='), 'service': 'prj_de70d4aa-0804-4a94-8097-7a9a34f0a28a'}

def ticket(path, body, subject='test-caller', now=None, **changes):
    at = int(time.time() * 1000) if now is None else now
    c = dict(v=2, aud=CONFIG['service'], sub=subject, owner=subject, path=path, bodyHash=hashlib.sha256(body).hexdigest(), iat=at, exp=at+20000, nonce=os.urandom(16).hex())
    c.update(changes)
    raw = json.dumps(c, separators=(',', ':')).encode()
    enc = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
    return 'Claus '+enc(raw)+'.'+enc(KEY.sign(DOMAIN+raw))

class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine()
        cls.server = Server(('127.0.0.1', 0), Handler)
        cls.server.engine = cls.engine
        cls.server.admission = Admission(CONFIG)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.server.admission = Admission(CONFIG)

    def call(self, path, payload):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        body = json.dumps(payload).encode()
        conn.request('POST', path, body, {'Content-Type': 'application/json', 'Authorization': ticket(path, body)})
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
            for path, data in [('/v1/embeddings', {'input': []}), ('/v1/embeddings', {'input': 'x' * 2049}), ('/v1/embeddings', {'input': 'a\ud800'}), ('/v1/embeddings', {'input': 'hello', 'model': 'arbitrary'}), ('/v1/search', {'query': 'a\ud800', 'documents': [{'id': 'x', 'text': 'a'}]}), ('/v1/search', {'query': 'q', 'documents': [{'id': 'x', 'text': 'a'}, {'id': 'x', 'text': 'b'}]})]:
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
        server.admission = Admission(CONFIG)
        server.request_deadline = 0.4
        server.workers = threading.BoundedSemaphore(1)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02})
        worker.start()
        try:
            for start in [b'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ', b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nAuthorization: '+ticket('/v1/embeddings', b'a'*1000).encode()+b'\r\n\r\n']:
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
                        closed = conn.recv(4096)
                        self.assertTrue(closed == b'' or closed.startswith(b'HTTP/1.1 408 '))
                        if closed:
                            try:
                                self.assertEqual(conn.recv(4096), b'')
                            except ConnectionResetError:
                                pass
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

    def test_idle_connections_do_not_occupy_health_or_inference_workers(self):
        sockets = [socket.create_connection(('127.0.0.1', self.server.server_port), timeout=2)
                   for _ in range(24)]
        try:
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
            started = time.monotonic()
            conn.request('GET', '/health')
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            self.assertLess(time.monotonic() - started, 1)
            conn.close()
            self.assertEqual(self.call('/v1/embeddings', {'input':'still available'})[0],200)
        finally:
            for sock in sockets: sock.close()

    def test_slow_authenticated_bodies_leave_model_capacity_free(self):
        sockets=[]
        body=b'{"input":"slow caller"}'
        try:
            for index in range(24):
                conn=socket.create_connection(('127.0.0.1',self.server.server_port),timeout=2)
                sockets.append(conn)
                authorization=ticket('/v1/embeddings',body,'slow-owner-'+str(index)).encode()
                conn.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\nAuthorization: '+authorization+b'\r\n\r\n'+body[:1])
            until=time.monotonic()+1
            while len(self.server.pending_headers)<24 and time.monotonic()<until:
                time.sleep(0.01)
            self.assertGreaterEqual(len(self.server.pending_headers),24)
            started=time.monotonic()
            status,result=self.call('/v1/embeddings',{'input':'a complete legitimate request'})
            self.assertEqual(status,200)
            self.assertEqual(len(result['data'][0]['embedding']),DIMENSIONS)
            self.assertLess(time.monotonic()-started,1)
        finally:
            for conn in sockets:conn.close()

    def test_large_complete_body_and_conflicting_framing(self):
        status,result=self.call('/v1/embeddings',{'input':'complete','padding':'x'*20000})
        self.assertEqual(status,200)
        self.assertEqual(len(result['data'][0]['embedding']),DIMENSIONS)
        for framing,status in [(b'Content-Length: 2\r\nContent-Length: 3',413),(b'Transfer-Encoding: chunked\r\nContent-Length: 2',415)]:
            with self.subTest(framing=framing), socket.create_connection(('127.0.0.1',self.server.server_port),timeout=2) as conn:
                conn.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'+framing+b'\r\n\r\n{}')
                self.assertIn(str(status).encode(),conn.recv(4096).split(b'\r\n',1)[0])

    def test_expect_continue_does_not_wait_for_unsent_body(self):
        body=b'{"input":"send after continue"}'
        authorization=ticket('/v1/embeddings',body,'expect-caller').encode()
        with socket.create_connection(('127.0.0.1',self.server.server_port),timeout=2) as conn:
            conn.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\nAuthorization: '+authorization+b'\r\n\r\n')
            response=b''
            while b'\r\n\r\n' not in response:
                response+=conn.recv(4096)
            self.assertEqual(response,b'HTTP/1.1 100 Continue\r\n\r\n')
            conn.sendall(body)
            final=http.client.HTTPResponse(conn)
            final.begin()
            self.assertEqual(final.status,200)
            self.assertEqual(len(json.loads(final.read())['data'][0]['embedding']),DIMENSIONS)

    def test_saturated_idle_header_queue_admits_health_and_signed_work(self):
        server = Server(('127.0.0.1', 0), Handler)
        server.engine = self.engine
        server.admission = Admission(CONFIG)
        server.max_pending_headers = 16
        server.header_deadline = 5
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        idle = []
        try:
            idle = [socket.create_connection(('127.0.0.1', server.server_port), timeout=2)
                    for _ in range(server.max_pending_headers)]
            until = time.monotonic() + 2
            while len(server.pending_headers) < server.max_pending_headers and time.monotonic() < until:
                time.sleep(0.01)
            self.assertEqual(len(server.pending_headers), server.max_pending_headers)
            for path in ['/health', '/v1/embeddings']:
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                if path == '/health':
                    connection.request('GET', path)
                else:
                    body = b'{"input":"progress despite idle connections"}'
                    connection.request('POST', path, body, {'Content-Type':'application/json', 'Authorization':ticket(path, body)})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                result = json.loads(response.read())
                if path != '/health':
                    self.assertEqual(len(result['data'][0]['embedding']), DIMENSIONS)
                connection.close()
                self.assertLessEqual(len(server.pending_headers), server.max_pending_headers)
        finally:
            for connection in idle:
                connection.close()
            server.shutdown()
            server.server_close()
            worker.join()

    def test_busy_application_pool_reserves_health_and_returns_http_overload(self):
        held = 0
        try:
            for _ in range(24):
                self.assertTrue(self.server.workers.acquire(blocking=False))
                held += 1
            for path, expected in [('/health',200), ('/',503)]:
                conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
                conn.request('GET',path)
                response=conn.getresponse()
                self.assertEqual(response.status,expected)
                response.read()
                conn.close()
        finally:
            for _ in range(held): self.server.workers.release()

    def test_protocol_errors_are_json_without_interpreter_disclosure(self):
        conn=http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        conn.request('PUT','/v1/embeddings')
        response=conn.getresponse()
        self.assertEqual(response.status,501)
        self.assertEqual(response.getheader('Server'),'Claus')
        self.assertEqual(response.getheader('Content-Type'),'application/json')
        self.assertEqual(json.loads(response.read()),{'error':'http_error','status':501})
        conn.close()

    def test_excessive_json_depth_is_a_client_error(self):
        body=b'['*60000
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        conn.request('POST','/v1/embeddings',body,{'Content-Type':'application/json','Authorization':ticket('/v1/embeddings',body)})
        response=conn.getresponse()
        self.assertEqual(response.status,400)
        self.assertEqual(json.loads(response.read()),{'error':'invalid_json'})
        conn.close()

    def test_non_utf8_json_does_not_infer(self):
        with patch.object(self.engine.session, 'run', wraps=self.engine.session.run) as infer:
            for encoding in ('utf-16', 'utf-32'):
                body=json.dumps({'input':'hello'}).encode(encoding)
                conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
                conn.request('POST','/v1/embeddings',body,{'Content-Type':'application/json','Authorization':ticket('/v1/embeddings',body)})
                response=conn.getresponse()
                self.assertEqual(response.status,400)
                self.assertEqual(json.loads(response.read()),{'error':'invalid_json'})
                conn.close()
            infer.assert_not_called()


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.now = 1700000000
        self.a = Admission(CONFIG, clock=lambda: self.now, monotonic=lambda: self.now)
        self.body = b'{}'
    def issue(self, subject='caller', **kw):
        return ticket(kw.pop('path','/v1/search'), self.body, subject, now=self.now*1000, **kw)
    def test_rejects_unsigned_forged_wrong_target_and_expired(self):
        for header in [None, 'Claus forged.ticket', self.issue(aud='other'), self.issue(exp=self.now*1000-1), self.issue(path='/v1/embeddings')]:
            with self.assertRaises(AdmissionError): self.a.begin(header, '/v1/search')
    def test_body_binding_and_one_use(self):
        h=self.issue(); c=self.a.begin(h, '/v1/search')
        with self.assertRaises(AdmissionError): self.a.verify_body(c, b'{"different":true}')
        self.a.finish(c)
        with self.assertRaises(AdmissionError): self.a.begin(h, '/v1/search')
    def test_one_caller_cannot_exhaust_another(self):
        c=self.a.begin(self.issue('busy'), '/v1/search'); self.a.finish(c)
        self.a.callers['busy']['tokens'] = 1
        c=self.a.begin(self.issue('busy'), '/v1/search'); self.a.finish(c)
        with self.assertRaises(AdmissionError) as caught: self.a.begin(self.issue('busy'), '/v1/search')
        self.assertEqual(caught.exception.status,429)
        c=self.a.begin(self.issue('other'), '/v1/search'); self.a.verify_body(c,self.body); self.a.finish(c)
    def test_one_active_request_per_principal(self):
        c=self.a.begin(self.issue(), '/v1/search')
        with self.assertRaises(AdmissionError): self.a.begin(self.issue(), '/v1/search')
        other=self.a.begin(self.issue('other'), '/v1/search'); self.a.finish(other); self.a.finish(c)
    def test_capacity_never_evicts_live_replay_protection(self):
        original=self.issue()
        claims=self.a.begin(original,'/v1/search'); self.a.finish(claims)
        used=self.a.callers['caller']['used']
        used.update({str(i):self.now+20 for i in range(163)})
        with self.assertRaises(AdmissionError) as caught:self.a.begin(self.issue(),'/v1/search')
        self.assertEqual(caught.exception.status,429)
        self.assertEqual(len(self.a.callers['caller']['used']),164)
        with self.assertRaises(AdmissionError) as replay:self.a.begin(original,'/v1/search')
        self.assertEqual(replay.exception.code,'admission_used')
        other=self.a.begin(self.issue('other'),'/v1/search'); self.a.finish(other)

    def test_many_owners_cannot_fill_another_owners_replay_storage(self):
        for owner in range(35):
            claims=self.a.begin(self.issue('owner-'+str(owner)),'/v1/search')
            self.a.finish(claims)
            self.a.callers[claims['owner']]['used'].update({str(i):self.now+20 for i in range(119)})
        victim=self.a.begin(self.issue('victim'),'/v1/search')
        self.a.verify_body(victim,self.body)
        self.a.finish(victim)
        self.assertEqual(sum(len(v['used']) for v in self.a.callers.values()),4201)

    def test_agents_share_owner_concurrency_and_capacity(self):
        c=self.a.begin(self.issue('agent-1',owner='same-owner'),'/v1/search')
        for i in range(2,10):
            with self.assertRaises(AdmissionError) as caught:
                self.a.begin(self.issue('agent-'+str(i),owner='same-owner'),'/v1/search')
            self.assertEqual(caught.exception.status,429)
        other=self.a.begin(self.issue('unrelated',owner='other-owner'),'/v1/search')
        self.a.finish(other)
        self.a.finish(c)
        self.a.callers['same-owner']['tokens'] = 1
        c=self.a.begin(self.issue('agent-10',owner='same-owner'),'/v1/search'); self.a.finish(c)
        with self.assertRaises(AdmissionError) as caught:
            self.a.begin(self.issue('another-new-agent',owner='same-owner'),'/v1/search')
        self.assertEqual(caught.exception.status,429)
        self.assertEqual(set(self.a.callers),{'same-owner','other-owner'})

    def test_global_budget_bounds_aggregate_work_and_refunds_both_buckets(self):
        first=self.a.begin(self.issue('first'),'/v1/search')
        refund=self.a.charge(first,64)
        self.assertEqual(self.a.capacity['tokens'],32)
        self.a.finish(first)
        second=self.a.begin(self.issue('second'),'/v1/search')
        with self.assertRaises(AdmissionError) as error:self.a.charge(second,64)
        self.assertEqual(error.exception.code,'service_cost_budget')
        self.assertEqual(self.a.callers['second']['tokens'],119)
        refund();refund()
        self.assertEqual(self.a.capacity['tokens'],94)
        self.assertEqual(self.a.callers['first']['tokens'],119)
        self.a.charge(second,64)
        self.assertEqual(self.a.capacity['tokens'],31)
        self.a.finish(second)

    def test_global_receive_rate_prevents_unbounded_owner_churn(self):
        for i in range(96):
            c=self.a.begin(self.issue('owner'+str(i)),'/v1/search');self.a.finish(c)
        with self.assertRaises(AdmissionError) as error:self.a.begin(self.issue('overflow'),'/v1/search')
        self.assertEqual(error.exception.code,'service_cost_budget')
        self.assertEqual(len(self.a.callers),96)
        self.now += 1
        for i in range(8):
            c=self.a.begin(self.issue('refill'+str(i)),'/v1/search');self.a.finish(c)
        with self.assertRaises(AdmissionError):self.a.begin(self.issue('overflow'),'/v1/search')

    def test_charge_credits_refill_earned_while_waiting(self):
        c=self.a.begin(self.issue(),'/v1/search')
        self.a.callers['caller']['tokens']=0
        self.a.capacity['tokens']=0
        self.now += 3
        self.a.charge(c,5)
        self.assertEqual(self.a.callers['caller']['tokens'],2)
        self.assertEqual(self.a.capacity['tokens'],20)
        self.a.finish(c)

    def test_complete_body_mismatch_does_not_consume_ticket_or_budget(self):
        h=self.issue()
        with self.assertRaises(AdmissionError):self.a.begin(h,'/v1/search',b'{"wrong":true}')
        self.assertEqual(self.a.callers,{})
        self.assertEqual(self.a.capacity['tokens'],96)
        c=self.a.begin(h,'/v1/search',self.body)
        self.a.finish(c)

    def test_advertised_budget_wait_admits_a_fresh_attempt(self):
        for owner_tokens, host_tokens in ((0, 95), (119, 0)):
            self.setUp()
            c=self.a.begin(self.issue(),'/v1/search')
            self.a.callers['caller']['tokens']=owner_tokens
            self.a.capacity['tokens']=host_tokens
            with self.assertRaises(AdmissionError) as error:self.a.charge(c,64)
            wait=error.exception.retry_after
            self.assertGreaterEqual(wait,1)
            self.a.finish(c)
            self.now += wait
            fresh=self.a.begin(self.issue(),'/v1/search')
            self.a.charge(fresh,64)
            self.a.finish(fresh)
    def test_old_ticket_without_owner_is_not_accepted(self):
        with self.assertRaises(AdmissionError):
            self.a.begin(self.issue(v=1),'/v1/search')

    def test_clock_corrections_cannot_reopen_used_or_expired_tickets(self):
        wall, mono = [self.now], [0.0]
        a = Admission(CONFIG, clock=lambda: wall[0], monotonic=lambda: mono[0])
        h = self.issue()
        c = a.begin(h, '/v1/search'); a.finish(c)
        wall[0] += 25
        with self.assertRaises(AdmissionError): a.begin(h, '/v1/search')
        wall[0] -= 25
        mono[0] += 26
        with self.assertRaises(AdmissionError): a.begin(h, '/v1/search')
        fresh = ticket('/v1/search',self.body,now=int((wall[0]+51)*1000))
        wall[0] += 51
        mono[0] = 51  # Real elapsed time; wall-clock samples are not elapsed time.
        c = a.begin(fresh,'/v1/search'); a.finish(c)

    def test_transient_forward_clock_sample_cannot_poison_fresh_tickets(self):
        wall, mono = [self.now], [0.0]
        a = Admission(CONFIG, clock=lambda: wall[0], monotonic=lambda: mono[0])
        used = self.issue()
        claims = a.begin(used, '/v1/search'); a.finish(claims)
        wall[0] += 60
        a.now_ms()
        wall[0] -= 60
        for elapsed in (0, 39, 41):
            mono[0] = elapsed
            wall[0] = self.now + elapsed
            fresh = ticket('/v1/search', self.body, now=int(wall[0] * 1000))
            claims = a.begin(fresh, '/v1/search')
            a.verify_body(claims, self.body)
            a.finish(claims)
            with self.assertRaises(AdmissionError):
                a.begin(used, '/v1/search')


class ReviewRegressionTest(ServiceTest):
    def test_review_request_line_and_anonymous_body_admission(self):
        body = b'{"input":"hello"}'
        for line, expected in [(b'POST\t/v1/embeddings HTTP/1.1', b'400'),
                               (b' POST /v1/embeddings HTTP/1.1', b'400'),
                               (b'POST /v1/embeddings HTTP/1.1', b'401')]:
            with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as conn:
                conn.sendall(line+b'\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n')
                self.assertIn(expected, conn.recv(4096).split(b'\r\n', 1)[0])
        self.assertEqual(self.server.workers._value, 24)

    def test_review_content_tokens_and_bounded_scores(self):
        for text in ['\u200b', '\x00', '\ufeff', '\x01\x02\x03']:
            self.assertEqual(self.call('/v1/embeddings', {'input': text})[0], 400)
        status, result = self.call('/v1/search', {'query':'Claus Network','documents':[{'id':'same','text':'Claus Network'}]})
        self.assertEqual(status, 200)
        self.assertTrue(-1 <= result['results'][0]['score'] <= 1)

    def test_review_readiness_detects_hung_inference(self):
        with self.engine.state_lock:
            self.engine.inference_started = time.monotonic() - 20
        try:
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
            conn.request('GET', '/health'); response = conn.getresponse()
            self.assertEqual(response.status, 503); response.read(); conn.close()
        finally:
            with self.engine.state_lock:
                self.engine.inference_started = None
        self.assertTrue(self.engine.ready())

    def test_review_cost_budget_is_per_owner_and_consumed_before_inference(self):
        tick = [0]
        meter = Admission(CONFIG, monotonic=lambda:tick[0])
        body=b'{"input":"hello"}'
        first=meter.begin(ticket('/v1/embeddings',body,subject='large'),'/v1/embeddings')
        meter.charge(first,64); meter.finish(first)
        second=meter.begin(ticket('/v1/embeddings',body,subject='large'),'/v1/embeddings')
        with self.assertRaises(AdmissionError) as error:
            meter.charge(second,64)
        self.assertEqual(error.exception.code,'caller_cost_budget');meter.finish(second)
        other=meter.begin(ticket('/v1/embeddings',body,subject='other'),'/v1/embeddings')
        with self.assertRaises(AdmissionError) as error:meter.charge(other,64)
        self.assertEqual(error.exception.code,'service_cost_budget')
        tick[0] += 2
        meter.charge(other,64);meter.finish(other)

    def test_review_busy_worker_preserves_inference_budget(self):
        self.server.admission = Admission(CONFIG, monotonic=lambda:0)
        payload = {'input': [('word%d ' % i) * 250 for i in range(16)]}
        with patch.object(self.engine.lock, 'acquire', return_value=False), \
             patch.object(self.engine.session, 'run', wraps=self.engine.session.run) as run:
            status, result = self.call('/v1/embeddings', payload)
        self.assertEqual((status, result['error']), (429, 'inference_busy'))
        self.assertEqual(self.server.admission.callers['test-caller']['tokens'], 119)
        run.assert_not_called()

    def test_review_failed_inference_refunds_budget(self):
        self.server.admission = Admission(CONFIG, monotonic=lambda:0)
        payload = {'input': [('word%d ' % i) * 250 for i in range(16)]}
        with patch.object(self.engine.session, 'run', side_effect=RuntimeError('test_failure')):
            status, result = self.call('/v1/embeddings', payload)
        self.assertEqual((status, result['error']), (503, 'inference_unavailable'))
        self.assertEqual(self.server.admission.callers['test-caller']['tokens'], 119)
        self.assertTrue(self.engine.ready())

    def test_review_successful_inference_charges_token_cost(self):
        self.server.admission = Admission(CONFIG, monotonic=lambda:0)
        status, result = self.call('/v1/embeddings', {'input': [('word%d ' % i) * 250 for i in range(16)]})
        self.assertEqual(status, 200)
        self.assertEqual(len(result['data']), 16)
        self.assertEqual(self.server.admission.callers['test-caller']['tokens'], 56)

    def test_review_anonymous_connections_preserve_verified_bodies(self):
        server = Server(('127.0.0.1', 0), Handler)
        server.engine, server.admission = self.engine, Admission(CONFIG)
        server.max_pending_headers = 4
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        sockets = []
        body = b'{"input":"protected signed request"}'
        def wait_for(predicate):
            until = time.monotonic() + 1
            while not predicate() and time.monotonic() < until:
                time.sleep(0.005)
            self.assertTrue(predicate())
        try:
            for i in range(2):
                conn = socket.create_connection(server.server_address, timeout=2)
                sockets.append(conn)
                authorization = ticket('/v1/embeddings', body, subject='protected-%d' % i)
                conn.sendall(('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAuthorization: %s\r\n\r\n' % (len(body), authorization)).encode() + body[:5])
            wait_for(lambda: len(server.pending_claims) == 2)
            newcomer = socket.create_connection(server.server_address, timeout=2)
            sockets.append(newcomer)
            authorization = ticket('/v1/embeddings', body, subject='over-body-capacity')
            newcomer.sendall(('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAuthorization: %s\r\n\r\n' % (len(body), authorization)).encode())
            self.assertIn(b'503', newcomer.recv(1024).split(b'\r\n')[0])
            with socket.create_connection(server.server_address, timeout=2) as complete:
                authorization = ticket('/v1/embeddings',body,subject='complete-victim')
                complete.sendall(('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAuthorization: %s\r\n\r\n' % (len(body),authorization)).encode()+body)
                self.assertIn(b'200',complete.recv(1024).split(b'\r\n')[0])
            health = http.client.HTTPConnection(*server.server_address, timeout=2)
            health.request('GET', '/health')
            response = health.getresponse()
            self.assertEqual(response.status, 200)
            response.read(); health.close()
            for _ in range(4):
                sockets.append(socket.create_connection(server.server_address, timeout=2))
            wait_for(lambda: len(server.pending_headers) == 4)
            self.assertEqual(len(server.pending_claims), 2)
            sockets[0].sendall(body[5:])
            self.assertIn(b'200', sockets[0].recv(1024).split(b'\r\n')[0])
        finally:
            for conn in sockets:
                conn.close()
            server.shutdown()
            server.server_close()

    def test_review_pending_owner_and_nonce_are_bounded_and_released(self):
        server = self.server
        body = b'{"input":"receive reservation"}'
        authorization = ticket('/v1/embeddings', body, subject='pending-owner')
        def headers(auth):
            return ('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAuthorization: %s\r\n\r\n' % (len(body), auth)).encode()
        first = socket.create_connection(server.server_address, timeout=2)
        first.sendall(headers(authorization) + body[:1])
        try:
            until = time.monotonic() + 1
            while 'pending-owner' not in server.pending_owners and time.monotonic() < until:
                time.sleep(0.005)
            self.assertIn('pending-owner', server.pending_owners)
            for auth in [authorization, ticket('/v1/embeddings', body, subject='pending-owner')]:
                with socket.create_connection(server.server_address, timeout=2) as duplicate:
                    duplicate.sendall(headers(auth))
                    self.assertIn(b'429', duplicate.recv(1024).split(b'\r\n')[0])
            self.assertEqual(sum(c['owner'] == 'pending-owner' for c in list(server.pending_claims.values())), 1)
            self.assertEqual(self.call('/v1/embeddings', {'input': 'other owner stays available'})[0], 200)
        finally:
            first.close()
        until = time.monotonic() + 1
        while 'pending-owner' in server.pending_owners and time.monotonic() < until:
            time.sleep(0.005)
        self.assertNotIn('pending-owner', server.pending_owners)
        with socket.create_connection(server.server_address, timeout=2) as retry:
            retry.sendall(headers(authorization) + body)
            self.assertIn(b'401', retry.recv(1024).split(b'\r\n')[0])
        with socket.create_connection(server.server_address, timeout=2) as retry:
            retry.sendall(headers(ticket('/v1/embeddings',body,subject='pending-owner')) + body)
            self.assertIn(b'200', retry.recv(1024).split(b'\r\n')[0])

    def test_review_receive_timeout_releases_reservations(self):
        server = self.server
        prior = server.body_deadline
        server.body_deadline = 0.05
        body = b'{"input":"timeout reservation"}'
        auth = ticket('/v1/embeddings', body, subject='timed-out-owner')
        try:
            with socket.create_connection(server.server_address, timeout=2) as conn:
                conn.sendall(('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAuthorization: %s\r\n\r\n' % (len(body), auth)).encode())
                self.assertIn(b'408', conn.recv(1024).split(b'\r\n')[0])
            self.assertNotIn('timed-out-owner', server.pending_owners)
            self.assertFalse(any(c['owner'] == 'timed-out-owner' for c in list(server.pending_claims.values())))
            self.assertFalse(any(owner == 'timed-out-owner' for owner, _ in server.pending_nonces.copy()))
            with socket.create_connection(server.server_address, timeout=2) as replay:
                replay.sendall(('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAuthorization: %s\r\n\r\n' % (len(body),auth)).encode())
                self.assertIn(b'401',replay.recv(1024).split(b'\r\n')[0])
        finally:
            server.body_deadline = prior

    def test_review_mixed_lengths_pay_for_padded_tensor(self):
        self.server.admission = Admission(CONFIG, monotonic=lambda:0)
        long = 'alpha beta gamma delta ' * 70
        status, _ = self.call('/v1/embeddings', {'input': [long] + ['word%d' % i for i in range(15)]})
        self.assertEqual(status, 200)
        self.assertEqual(self.server.admission.callers['test-caller']['tokens'], 56)

    def test_review_deduplication_charges_only_executed_rows(self):
        self.server.admission = Admission(CONFIG, monotonic=lambda:0)
        status, _ = self.call('/v1/embeddings', {'input': ['alpha beta gamma delta ' * 70] * 16})
        self.assertEqual(status, 200)
        self.assertEqual(self.server.admission.callers['test-caller']['tokens'], 116)

if __name__ == '__main__':
    unittest.main()
