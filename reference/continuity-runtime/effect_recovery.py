"""Settle only already-finished originals with independent replication proof."""
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from replication import NAMES

def barriers_ready(connection, identifier, names):
    if not isinstance(names,list) or not names or len(set(names))!=len(names) or any(n not in NAMES for n in names):return False
    for name in names:
        with psycopg.connect(**{**connection,'dbname':'recovery_'+name},connect_timeout=3) as c:
            row=c.execute('SELECT 1 FROM public.claus_continuity_barriers WHERE id=%s AND schema_fingerprint=public.claus_continuity_schema_signature()',(identifier,)).fetchone()
            if not row:return False
    return True

def reconcile(connection):
    with psycopg.connect(**connection,row_factory=dict_row) as c:
        rows=c.execute("SELECT id,result FROM continuity.effects WHERE state='uncertain' AND result->>'executionFinished'='true' ORDER BY updated_at LIMIT 30").fetchall()
    for row in rows:
        try:
            if not barriers_ready(connection,row['id'],row['result'].get('barriers')):continue
            value={**row['result'],'reconciledBy':'independent_replication_barriers'}
            with psycopg.connect(**connection) as c:
                c.execute("UPDATE continuity.effects SET state='completed',result=%s,updated_at=now() WHERE id=%s AND state='uncertain' AND result=%s",(Jsonb(value),row['id'],Jsonb(row['result'])))
        except Exception:pass
