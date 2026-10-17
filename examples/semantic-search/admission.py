"""One-use, body-bound tickets signed by the existing Claus network issuer."""
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DOMAIN = b'claus-semantic-admission/2\n'


class AdmissionError(Exception):
    def __init__(self, status, code, retry_after=1):
        self.status, self.code = status, code
        self.retry_after = retry_after


def decode(value):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('encoding')
    raw = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    if base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
        raise ValueError('encoding')
    return raw


class Admission:
    def __init__(self, config=None, clock=time.time, monotonic=time.monotonic):
        config = config or json.loads((Path(__file__).parent / 'admission-key.json').read_text())
        self.key = Ed25519PublicKey.from_public_bytes(decode(config['publicKey']))
        self.service = config['service']
        self.clock, self.monotonic = clock, monotonic
        self.lock = threading.Lock()
        self.wall, self.tick = self.clock(), self.monotonic()
        self.callers = {}
        # One host-wide budget bounds aggregate work even when a caller can
        # register many owners. The burst admits a full 64-unit batch; refill
        # leaves headroom beneath the measured two-CPU inference throughput.
        self.capacity = {'tokens': 96, 'at': self.tick}

    def now_ms(self):
        # Anchor to the synchronized wall clock once; measure elapsed time with
        # the steady clock. Neither a transient forward sample nor a backward
        # correction can poison future admission or reopen an expired window.
        return int((self.wall + max(0, self.monotonic() - self.tick)) * 1000)

    def verify_header(self, header, path):
        try:
            if not isinstance(header, str) or len(header) > 1800 or not header.startswith('Claus '):
                raise ValueError('header')
            payload, signature = header[6:].split('.')
            raw, sig = decode(payload), decode(signature)
            self.key.verify(sig, DOMAIN + raw)
            claims = json.loads(raw)
            now = self.now_ms()
            if (set(claims) != {'v', 'aud', 'sub', 'owner', 'path', 'bodyHash', 'iat', 'exp', 'nonce'}
                    or claims['v'] != 2 or claims['aud'] != self.service or claims['path'] != path
                    or type(claims['iat']) is not int or type(claims['exp']) is not int
                    or claims['exp'] - claims['iat'] != 20000
                    or claims['iat'] > now + 2000 or claims['exp'] <= now
                    or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,160}', claims['sub'])
                    or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,160}', claims['owner'])
                    or not re.fullmatch(r'[a-f0-9]{64}', claims['bodyHash'])
                    or not re.fullmatch(r'[a-f0-9]{32}', claims['nonce'])):
                raise ValueError('claims')
        except (ValueError, TypeError, KeyError, AttributeError, InvalidSignature):
            raise AdmissionError(401, 'admission_required') from None
        return claims

    @staticmethod
    def refill(bucket, tick, burst, rate):
        bucket['tokens'] = min(burst, bucket['tokens'] + max(0, tick - bucket['at']) * rate)
        bucket['at'] = tick

    def begin(self, header, path, body=None):
        claims = self.verify_header(header, path)
        if body is not None:
            self.verify_body(claims, body)
        return self.reserve(claims)

    def reserve(self, claims):
        # Only verified claims reach this internal receive reservation. A
        # ticket pays for one receive attempt, including a body timeout.
        now = self.now_ms()
        if claims['exp'] <= now:
            raise AdmissionError(401, 'admission_required')
        with self.lock:
            tick = self.monotonic()
            self.callers = {k: v for k, v in self.callers.items() if v['active'] or tick - v['at'] < 60}
            previous = self.callers.get(claims['owner'])
            if previous is None and len(self.callers) >= 2048:
                raise AdmissionError(503, 'admission_capacity')
            previous = previous or {'tokens': 120, 'at': tick, 'active': False, 'used': {}}
            used = {k: v for k, v in previous['used'].items() if v > tick}
            if claims['nonce'] in used:
                raise AdmissionError(401, 'admission_used')
            tokens = min(120, previous['tokens'] + max(0, tick - previous['at']) * 2)
            # 120 initial tokens + 2/s through the maximum 22-second window.
            # Replay storage is reserved per owner, never borrowed from peers.
            if previous['active'] or tokens < 1 or len(used) >= 164:
                raise AdmissionError(429, 'caller_busy')
            self.refill(self.capacity, tick, 96, 8)
            if self.capacity['tokens'] < 1:
                raise AdmissionError(429, 'service_cost_budget')
            used[claims['nonce']] = tick + (claims['exp'] - now) / 1000
            self.capacity['tokens'] -= 1
            self.callers[claims['owner']] = {'tokens': tokens - 1, 'at': tick, 'active': True,
                                             'nonce': claims['nonce'], 'used': used}
        return claims

    def charge(self, claims, cost):
        # begin already charged one unit. Each additional unit represents up
        # to 64 padded, truncated batch positions, shared by all of an owner's
        # projects. Expensive requests cannot bypass the sustainable budget.
        if type(cost) is not int or not 1 <= cost <= 64:
            raise ValueError('inference_cost_invalid')
        with self.lock:
            caller = self.callers[claims['owner']]
            tick = self.monotonic()
            self.refill(caller, tick, 120, 2)
            self.refill(self.capacity, tick, 96, 8)
            if not caller['active'] or caller['nonce'] != claims['nonce']:
                raise AdmissionError(429, 'caller_cost_budget')
            # The next attempt spends a new receive unit, so its wait covers
            # the full cost rather than only this attempt's remaining cost.
            retry_after = max(1, math.ceil((cost - caller['tokens']) / 2),
                              math.ceil((cost - self.capacity['tokens']) / 8))
            if caller['tokens'] < cost - 1:
                raise AdmissionError(429, 'caller_cost_budget', retry_after)
            if self.capacity['tokens'] < cost - 1:
                raise AdmissionError(429, 'service_cost_budget', retry_after)
            caller['tokens'] -= cost - 1
            self.capacity['tokens'] -= cost - 1
        refunded = False

        def refund():
            nonlocal refunded
            with self.lock:
                if not refunded:
                    tick = self.monotonic()
                    self.refill(caller, tick, 120, 2)
                    self.refill(self.capacity, tick, 96, 8)
                    caller['tokens'] = min(120, caller['tokens'] + cost - 1)
                    self.capacity['tokens'] = min(96, self.capacity['tokens'] + cost - 1)
                    refunded = True

        return refund

    def verify_body(self, claims, body):
        if hashlib.sha256(body).hexdigest() != claims['bodyHash'] or claims['exp'] <= self.now_ms():
            raise AdmissionError(401, 'admission_body_mismatch')

    def finish(self, claims):
        with self.lock:
            caller = self.callers.get(claims['owner'])
            if caller and caller['nonce'] == claims['nonce']:
                caller['active'] = False
