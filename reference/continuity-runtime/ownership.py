"""One-use, source-bound handoff after the old owned Pod is terminated."""
import base64, fcntl, hashlib, hmac, json, os, pathlib, time

def claim(root, source, pod, master):
    owner=root/'postgres-owner.json'
    with (root/'postgres-owner.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        prior=json.loads(owner.read_text()) if owner.exists() else None
        if prior and prior.get('pod')==pod:return
        if not prior and (root/'postgres'/'PG_VERSION').exists():raise RuntimeError('existing_database_owner_missing')
        evidence=None
        if prior:
            envelope=json.loads(os.environ.pop('CONTINUITY_OWNERSHIP_HANDOFF','{}'))
            payload=base64.b64decode(envelope['payload'],validate=True)
            signature=hmac.new(hashlib.sha256(master.encode()).digest(),payload,hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature,envelope['signature']):raise RuntimeError('handoff_signature_invalid')
            evidence=json.loads(payload)
            manifest_hash=hashlib.sha256((source/'manifest.json').read_bytes()).hexdigest()
            if evidence.get('fromPod')!=prior.get('pod') or evidence.get('terminal') is not True or evidence.get('manifest')!=manifest_hash or not time.time()<evidence['expiresAt']<=time.time()+1800:
                raise RuntimeError('old_pod_must_be_fenced_before_storage_reassignment')
        record={'pod':pod,'createdAt':time.time(),'previousPod':prior.get('pod') if prior else None,'handoff':evidence}
        temp=root/('postgres-owner.'+pod+'.tmp')
        with temp.open('x') as out:json.dump(record,out);out.flush();os.fsync(out.fileno())
        os.replace(temp,owner)
        fd=os.open(root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
