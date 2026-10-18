"""Source metadata and a fixed committed marker prove applied replication progress."""
import datetime, json, secrets, threading, time
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
NAMES=('agent','signer','payments','network','portable','applications','website')

def observe(connection):
    with psycopg.connect(**connection,row_factory=dict_row) as control:
        active=control.execute('SELECT active_instance FROM continuity.control WHERE id').fetchone()
        if active['active_instance']!='primary':return
    for name in NAMES:
        try:
            with psycopg.connect(**{**connection,'dbname':'recovery_'+name},row_factory=dict_row,connect_timeout=5) as target:
                subscription=target.execute("SELECT oid,subconninfo FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND subname='claus_independent_recovery'").fetchone()
                if not subscription: continue
                relations=target.execute("SELECT srsubstate,count(*)::int count FROM pg_subscription_rel WHERE srsubid=%s GROUP BY srsubstate",(subscription['oid'],)).fetchall()
                target_signature=target.execute('SELECT public.claus_continuity_schema_signature() AS value').fetchone()['value']
                progress=target.execute('SELECT received_lsn,latest_end_lsn,latest_end_time FROM pg_stat_subscription WHERE subid=%s AND relid IS NULL',(subscription['oid'],)).fetchone()
                nonce=secrets.token_hex(16)
                with psycopg.connect(subscription['subconninfo'],options='-c statement_timeout=10000',connect_timeout=5,row_factory=dict_row) as source:
                    signature=source.execute('SELECT public.claus_continuity_schema_signature() AS value').fetchone()['value']
                    sequences=source.execute("SELECT schemaname,sequencename,sequenceowner,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname NOT LIKE 'pg_%' ORDER BY 1,2").fetchall()
                    checkpoint=source.execute('SELECT public.claus_continuity_checkpoint(%s) AS value',(nonce,)).fetchone()['value']
                sampled=datetime.datetime.fromisoformat(checkpoint['sourceAt'])
                until=time.monotonic()+5
                applied=None
                # A committed, published marker proves application of preceding
                # source commits. A live receiver or matching schema alone cannot.
                while time.monotonic()<until:
                    target.commit()
                    applied=target.execute('SELECT source_at FROM public.claus_continuity_checkpoint WHERE id AND nonce=%s',(nonce,)).fetchone()
                    if applied:break
                    time.sleep(.1)
                ready=bool(applied) and bool(relations) and all(r['srsubstate']=='r' for r in relations) and signature==target_signature
                body={'state':'current' if ready else 'replication_or_schema_pending','sampledAt':sampled.isoformat(),'appliedCheckpoint':{'nonce':nonce,'sourceAt':sampled.isoformat()} if applied else None,'schemaFingerprint':signature,'targetFingerprint':target_signature,'relations':relations,'sequences':sequences,'progress':json.loads(json.dumps(progress,default=str))}
                with psycopg.connect(**connection) as control:
                    control.execute("INSERT INTO continuity.replication_state(name,body,sampled_at) VALUES(%s,%s,%s) ON CONFLICT(name) DO UPDATE SET body=excluded.body,sampled_at=excluded.sampled_at,last_error=NULL",(name,Jsonb(body),sampled))
        except Exception as error:
            # Preserve the last successful evidence. An outage is never a
            # reason to overwrite it with an apparently empty source.
            try:
                with psycopg.connect(**connection) as control:
                    control.execute("INSERT INTO continuity.replication_state(name,body,last_error) VALUES(%s,'{}'::jsonb,%s) ON CONFLICT(name) DO UPDATE SET last_error=excluded.last_error",(name,type(error).__name__))
            except Exception: pass

def start(connection):
    def loop():
        while True:
            observe(connection)
            from effect_recovery import reconcile
            reconcile(connection)
            time.sleep(30)
    threading.Thread(target=loop,name='replication-checkpoints',daemon=True).start()
