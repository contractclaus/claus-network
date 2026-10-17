"""One-use, body-bound tickets signed by the existing Claus network issuer."""
import base64
import hashlib
import json
from pathlib import Path
import re
import threading
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DOMAIN = b'claus-semantic-admission/1\n'


class AdmissionError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


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
        self.used, self.callers = {}, {}

    def begin(self, header, path):
        try:
            if not isinstance(header, str) or len(header) > 1800 or not header.startswith('Claus '):
                raise ValueError('header')
            payload, signature = header[6:].split('.')
            raw, sig = decode(payload), decode(signature)
            self.key.verify(sig, DOMAIN + raw)
            claims = json.loads(raw)
            now = int(self.clock() * 1000)
            if (set(claims) != {'v', 'aud', 'sub', 'path', 'bodyHash', 'iat', 'exp', 'nonce'}
                    or claims['v'] != 1 or claims['aud'] != self.service or claims['path'] != path
                    or type(claims['iat']) is not int or type(claims['exp']) is not int
                    or claims['exp'] - claims['iat'] != 20000
                    or claims['iat'] > now + 2000 or claims['exp'] <= now
                    or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,160}', claims['sub'])
                    or not re.fullmatch(r'[a-f0-9]{64}', claims['bodyHash'])
                    or not re.fullmatch(r'[a-f0-9]{32}', claims['nonce'])):
                raise ValueError('claims')
        except (ValueError, TypeError, KeyError, AttributeError, InvalidSignature):
            raise AdmissionError(401, 'admission_required') from None
        with self.lock:
            tick = self.monotonic()
            self.used = {k: v for k, v in self.used.items() if v > now}
            self.callers = {k: v for k, v in self.callers.items() if v['active'] or tick - v['at'] < 60}
            if claims['nonce'] in self.used:
                raise AdmissionError(401, 'admission_used')
            previous = self.callers.get(claims['sub'])
            if len(self.used) >= 4096 or (previous is None and len(self.callers) >= 2048):
                raise AdmissionError(503, 'admission_capacity')
            previous = previous or {'tokens': 120, 'at': tick, 'active': False}
            tokens = min(120, previous['tokens'] + max(0, tick - previous['at']) * 2)
            if previous['active'] or tokens < 1:
                raise AdmissionError(429, 'caller_busy')
            self.used[claims['nonce']] = claims['exp']
            self.callers[claims['sub']] = {'tokens': tokens - 1, 'at': tick, 'active': True}
        return claims

    def verify_body(self, claims, body):
        if hashlib.sha256(body).hexdigest() != claims['bodyHash'] or claims['exp'] <= int(self.clock() * 1000):
            raise AdmissionError(401, 'admission_body_mismatch')

    def finish(self, claims):
        with self.lock:
            self.callers[claims['sub']]['active'] = False
