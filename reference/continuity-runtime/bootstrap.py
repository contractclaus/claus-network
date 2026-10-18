"""Start one durable PostgreSQL/controller process on the explicitly bound Pod."""
import base64, hashlib, json, os, pathlib, signal, subprocess, sys, tempfile, time
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = pathlib.Path('/workspace/claus-continuity')
SOURCE = pathlib.Path(__file__).resolve().parent
MASTER = os.environ.pop('CONTINUITY_MASTER')
envelope = json.loads((ROOT/'config.enc.json').read_text())
key = hashlib.sha256(MASTER.encode()).digest()
config = json.loads(AESGCM(key).decrypt(base64.b64decode(envelope['iv']), base64.b64decode(envelope['ciphertext']), b'claus-continuity-config-v1'))
pod = os.environ.get('RUNPOD_POD_ID')
if not pod:
    raise RuntimeError('explicit_pod_identity_required')
ROOT.mkdir(exist_ok=True, mode=0o700)
from ownership import claim
claim(ROOT,SOURCE,pod,MASTER)
distribution = pathlib.Path('/workspace/db-standby/pg-distribution')
bin_dir = distribution/'usr/lib/postgresql/18/bin'
env = dict(os.environ)
env['LD_LIBRARY_PATH'] = str(distribution/'usr/lib/x86_64-linux-gnu')+':'+str(distribution/'lib/x86_64-linux-gnu')
data = ROOT/'postgres'
if not (data/'PG_VERSION').exists():
    if data.exists() and any(data.iterdir()):
        raise RuntimeError('partial_initialization_requires_original_reconciliation')
    with tempfile.NamedTemporaryFile(mode='w') as password:
        password.write(config['databasePassword']); password.flush()
        subprocess.run([str(bin_dir/'initdb'),'-D',str(data),'-L',str(distribution/'usr/share/postgresql/18'),'-U','claus_control','--encoding=UTF8','--locale=C','--auth-local=scram-sha-256','--auth-host=scram-sha-256','--pwfile='+password.name],env=env,check=True,stdout=subprocess.DEVNULL)
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses='127.0.0.1'\nport=5440\nmax_connections=40\nshared_buffers='256MB'\nfsync=on\nsynchronous_commit=on\nfull_page_writes=on\nwal_level=logical\nmax_wal_senders=16\nmax_replication_slots=16\nmax_logical_replication_workers=12\nmax_worker_processes=20\nwal_keep_size='128MB'\nmax_slot_wal_keep_size='2GB'\nunix_socket_directories='/tmp'\nlog_statement='none'\nlog_min_error_statement='panic'\n")
pg_ctl = [str(bin_dir/'pg_ctl'),'-D',str(data)]
if subprocess.run(pg_ctl+['status'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
    subprocess.run(pg_ctl+['-l',str(ROOT/'postgres.log'),'-w','start'],env=env,check=True,stdout=subprocess.DEVNULL)
import psycopg
connection = dict(host='127.0.0.1',port=5440,user='claus_control',password=config['databasePassword'],dbname='postgres')
with psycopg.connect(**connection,autocommit=True) as c:
    if not c.execute("SELECT 1 FROM pg_database WHERE datname='claus_continuity'").fetchone():
        c.execute('CREATE DATABASE claus_continuity')
connection['dbname']='claus_continuity'
with psycopg.connect(**connection) as c:
    c.execute((SOURCE/'schema.sql').read_text())
def stop(*_):
    subprocess.run(pg_ctl+['-m','fast','-w','stop'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    os._exit(0)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
sys.path.insert(0,str(SOURCE))
from service import serve
serve(config,connection)
