"""Private durable coordination and model routing. No unknown request is replayed."""
import concurrent.futures, datetime, hashlib, hmac, json, re, secrets, threading, time
import urllib.request, urllib.error, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from translation import translate
from fence import transition_allowed, recovery_ready

CFG = {}; CONNECTION = {}; POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4)
ID = re.compile(r'^[A-Za-z0-9_.:/-]{1,240}$')
def db(): return psycopg.connect(**CONNECTION,row_factory=dict_row,connect_timeout=10)
def digest(v): return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def check_id(v):
    if not isinstance(v,str) or not ID.fullmatch(v): raise ValueError('invalid_original_id')
    return v
def http(url,secret,method='GET',value=None,extra=None,timeout=20):
    headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json',**(extra or {})}
    request=urllib.request.Request(url,data=None if value is None else json.dumps(value,separators=(',',':')).encode(),headers=headers,method=method)
    # Destinations are fixed server configuration, never caller-provided URLs.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*_): return None
    try: response=urllib.request.build_opener(NoRedirect).open(request,timeout=timeout)
    except urllib.error.HTTPError as e: response=e
    raw=response.read(4500000)
    try: body=json.loads(raw)
    except (ValueError,UnicodeDecodeError): body={'error':'provider_unstructured_response'}
    return response.status,body
def event(c,kind,body): c.execute('INSERT INTO continuity.events(kind,body) VALUES(%s,%s)',(kind,Jsonb(body)))
def grant_available(c,amount):
    return c.execute("SELECT id FROM continuity.grants WHERE expires_at>now()+interval '16 minutes' AND amount_micro-allocated_micro>=%s ORDER BY expires_at,id LIMIT 1 FOR UPDATE",(amount,)).fetchone()
def independent_ready(c,amount):
    # Worst-case 900s of H100 Flex ($4.79/hour) plus startup/idle contingency.
    return bool(CFG.get('runpodKey')) and amount>=CFG['minimumInferenceAuthorizationMicro'] and bool(grant_available(c,amount))
def claim_inference(body):
    identifier=check_id(body['id']); request=body['input']; maximum=int(body['maximumMicroUsd'])
    if not 1<=maximum<=500000000: raise ValueError('invalid_authorization')
    if not isinstance(request,dict) or request.get('stream') is True: raise ValueError('request_shape')
    preference=body.get('prefer','primary')
    if preference not in ('primary','independent'): raise ValueError('route_preference')
    fingerprint=digest({'input':request,'maximumMicroUsd':str(maximum),'prefer':preference})
    with db() as c:
        existing=c.execute('SELECT id FROM continuity.inference WHERE id=%s',(identifier,)).fetchone()
        if not existing:
            control=c.execute('SELECT *,lease_until>now() valid FROM continuity.control WHERE id FOR SHARE').fetchone()
            if control['enforce_effects'] and (control['phase']!='active' or not control['valid'] or control['active_instance']!=body.get('instance') or control['epoch']!=body.get('epoch')):raise ValueError('inference_writer_fenced')
        row=c.execute("INSERT INTO continuity.inference(id,input_hash,input,route,state,maximum_micro) VALUES(%s,%s,%s,%s,'queued',%s) ON CONFLICT DO NOTHING RETURNING id",(identifier,fingerprint,Jsonb(request),preference,maximum)).fetchone()
        original=c.execute('SELECT input_hash,state FROM continuity.inference WHERE id=%s',(identifier,)).fetchone()
        if original['input_hash']!=fingerprint: raise ValueError('original_request_conflict')
    if row: POOL.submit(dispatch,identifier)
    return {'id':identifier,'state':original['state'],'originalRetained':True}
def dispatch(identifier):
    try:
        with db() as c:
            row=c.execute("UPDATE continuity.inference SET state='selecting',updated_at=now() WHERE id=%s AND state='queued' RETURNING *",(identifier,)).fetchone()
        if not row: return
        route=row['route']; request=row['input']; maximum=row['maximum_micro']
        if route=='primary':
            try:
                status,admission=http(CFG['primaryUrl']+'/api/admission/'+urllib.parse.quote(identifier,safe='')+'?maximumMicroUsdc='+str(maximum),CFG['primarySecret'])
                primary_ready=status==200 and admission.get('id')==identifier and admission.get('ready') is True
            except Exception: primary_ready=False
            if not primary_ready:
                with db() as c: fallback_ready=independent_ready(c,maximum)
                if fallback_ready: route='independent'
                else:
                    finish(identifier,'not_dispatched',{'error':'no_funded_model_route','dispatchOccurred':False}); return
        if route=='independent':
            converted,context=translate(request,CFG['model'])
            with db() as c:
                grant=grant_available(c,maximum)
                if not CFG.get('runpodKey') or maximum<CFG['minimumInferenceAuthorizationMicro'] or not grant:
                    c.execute("UPDATE continuity.inference SET state='not_dispatched',diagnostic=%s,updated_at=now() WHERE id=%s",(Jsonb({'error':'independent_allowance_unavailable','dispatchOccurred':False}),identifier));return
                c.execute('UPDATE continuity.grants SET allocated_micro=allocated_micro+%s WHERE id=%s',(maximum,grant['id']))
                c.execute("UPDATE continuity.inference SET route='independent',state='dispatching',grant_id=%s,diagnostic=%s,updated_at=now() WHERE id=%s",(grant['id'],Jsonb({'context':context,'requestedModel':request['model']}),identifier))
            status,result=http(CFG['runpodUrl']+'/run',CFG['runpodKey'],'POST',{'input':{'openai_route':'/v1/chat/completions','openai_input':converted},'policy':{'executionTimeout':900000}},timeout=45)
            if status!=200 or not isinstance(result.get('id'),str):
                # Even a provider rejection retains its full authorization until accounted.
                finish(identifier,'uncertain',{'error':'runpod_submission_unconfirmed','httpStatus':status});return
            with db() as c: c.execute("UPDATE continuity.inference SET state='accepted',provider_id=%s,updated_at=now() WHERE id=%s",(result['id'],identifier))
            for _ in range(300):
                if reconcile(identifier): return
                time.sleep(3)
        else:
            with db() as c: c.execute("UPDATE continuity.inference SET state='dispatching',route='primary',provider_id=id,updated_at=now() WHERE id=%s",(identifier,))
            status,result=http(CFG['primaryUrl']+'/api/completion',CFG['primarySecret'],'POST',request,{'Idempotency-Key':identifier,'X-Max-Quote-Micro-USDC':str(maximum),'X-Inference-Reservation':'quoted-v1','X-Inference-Purpose':'continuity'},timeout=650)
            if status==200 and result.get('choices'):
                with db() as c: c.execute("UPDATE continuity.inference SET state='completed',response=%s,updated_at=now() WHERE id=%s",(Jsonb(result),identifier))
            else:
                finish(identifier,'uncertain',{'error':'primary_response_requires_reconciliation','httpStatus':status});reconcile(identifier)
    except (KeyError,ValueError) as e:
        with db() as c:
            c.execute("UPDATE continuity.inference SET state='not_dispatched',diagnostic=%s,updated_at=now() WHERE id=%s AND state IN('queued','selecting')",(Jsonb({'error':str(e)[:100],'dispatchOccurred':False}),identifier))
            c.execute("UPDATE continuity.inference SET state='uncertain',updated_at=now() WHERE id=%s AND state='dispatching'",(identifier,))
    except Exception:
        try:
            with db() as c: c.execute("UPDATE continuity.inference SET state='uncertain',updated_at=now() WHERE id=%s AND state NOT IN ('completed','failed','not_dispatched','accepted')",(identifier,))
        except Exception: pass
def finish(identifier,state,diagnostic):
    with db() as c: c.execute('UPDATE continuity.inference SET state=%s,diagnostic=COALESCE(diagnostic,\'{}\'::jsonb)||%s,updated_at=now() WHERE id=%s AND state NOT IN (\'completed\',\'failed\')',(state,Jsonb(diagnostic),identifier))
def reconcile(identifier):
    with db() as c: row=c.execute('SELECT * FROM continuity.inference WHERE id=%s',(identifier,)).fetchone()
    if not row or row['state'] in ('completed','failed','not_dispatched'): return True
    if not row['provider_id']: return False
    if row['route']=='primary':
        status,b=http(CFG['primaryUrl']+'/api/requests/'+urllib.parse.quote(identifier,safe=''),CFG['primarySecret'])
        if status==200 and b.get('status') in ('completed','failed'):
            with db() as c: c.execute('UPDATE continuity.inference SET state=%s,response=%s,diagnostic=%s,updated_at=now() WHERE id=%s',(b['status'],Jsonb(b.get('response')),Jsonb({'primaryStatus':b}),identifier))
            return True
        return False
    status,b=http(CFG['runpodUrl']+'/status/'+urllib.parse.quote(row['provider_id'],safe=''),CFG['runpodKey'])
    if status!=200: return False
    if b.get('status')=='COMPLETED':
        output=b.get('output'); output=output[-1] if isinstance(output,list) and output else output
        if isinstance(output,str):
            try: output=json.loads(output)
            except ValueError: output=None
        if not isinstance(output,dict) or not output.get('choices'):
            finish(identifier,'failed',{'error':'model_worker_returned_no_completion','providerStatus':b.get('status'),'costUnknown':True});return True
        if output.get('model')!=CFG['model']:
            finish(identifier,'failed',{'error':'actual_model_mismatch','costUnknown':True});return True
        output['routing']={'route':'independent','requestedModel':row['input']['model'],'actualModel':CFG['model'],'provider':'runpod','originalRequestId':identifier,'context':(row['diagnostic'] or {}).get('context')}
        output['receipt']={'kind':'owned_prepaid_allowance','grantId':row['grant_id'],'requestId':identifier,'providerRequestId':row['provider_id'],'authorizedMicroUsd':str(row['maximum_micro']),'actualMicroUsd':None,'basis':'conservative_prepaid_allocation'}
        output['responseStatus']='completed' if output['choices'][0].get('finish_reason') in ('stop','tool_calls') else 'incomplete'
        with db() as c: c.execute("UPDATE continuity.inference SET state='completed',response=%s,diagnostic=diagnostic||%s,updated_at=now() WHERE id=%s",(Jsonb(output),Jsonb({'providerStatus':b['status'],'executionTimeMs':b.get('executionTime'),'delayTimeMs':b.get('delayTime'),'actualCostUnknown':True}),identifier))
        return True
    if b.get('status') in ('FAILED','CANCELLED','TIMED_OUT'):
        finish(identifier,'failed',{'error':'model_worker_'+b['status'].lower(),'costUnknown':True,'executionTimeMs':b.get('executionTime')});return True
    return False
def inference_status(identifier):
    with db() as c: row=c.execute('SELECT * FROM continuity.inference WHERE id=%s',(identifier,)).fetchone()
    if not row: return None
    return {'id':identifier,'status':row['state'],'route':row['route'],'response':row['response'],'diagnostic':row['diagnostic'],'maximumMicroUsd':str(row['maximum_micro']),'createdAt':row['created_at'],'updatedAt':row['updated_at'],'providerRequestId':row['provider_id']}

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self,*_): pass
    def reply(self,status,body):
        data=json.dumps(body,default=lambda v:v.isoformat() if hasattr(v,'isoformat') else str(v),separators=(',',':')).encode()
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError): pass
    def authenticated(self,operator=False):
        expected=CFG['operatorSecret'] if operator else CFG['runtimeSecret']
        return hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+expected)
    def do_GET(self):
        path=urllib.parse.urlsplit(self.path)
        if path.path=='/v2':
            from pg_websocket import serve
            return serve(self)
        if path.path=='/health':
            try:
                with db() as c: c.execute('SELECT 1')
                return self.reply(200,{'service':'claus-continuity','ready':True,'version':4})
            except Exception: return self.reply(503,{'ready':False})
        if not self.authenticated() and not self.authenticated(True):return self.reply(401,{'error':'unauthorized'})
        try:
            if path.path=='/v1/status':
                with db() as c:
                    control=c.execute('SELECT * FROM continuity.control WHERE id').fetchone()
                    effects=c.execute('SELECT state,count(*)::int count FROM continuity.effects GROUP BY state').fetchall()
                    inference=c.execute('SELECT route,state,count(*)::int count FROM continuity.inference GROUP BY route,state').fetchall()
                    grants=c.execute('SELECT id,amount_micro,allocated_micro,expires_at FROM continuity.grants ORDER BY created_at DESC LIMIT 20').fetchall()
                    replication=c.execute("SELECT name,body,sampled_at,last_error,sampled_at>=now()-interval '60 seconds' fresh FROM continuity.replication_state ORDER BY name").fetchall()
                    checkpoints=c.execute('SELECT name,revision,source_at,saved_at FROM continuity.checkpoints ORDER BY name').fetchall()
                return self.reply(200,{'control':control,'effects':effects,'replication':replication,'inference':inference,'grants':grants,'checkpoints':checkpoints,'independentModel':CFG['model'],'databaseProvider':'runpod','scope':'coordination_and_prepared_recovery'})
            if path.path.startswith('/v1/inference/status/'):
                identifier=urllib.parse.unquote(path.path[len('/v1/inference/status/'):]);check_id(identifier)
                row=inference_status(identifier)
                if row and row['status'] not in ('queued','selecting','completed','failed','not_dispatched'):
                    try: reconcile(identifier);row=inference_status(identifier)
                    except Exception: pass
                return self.reply(200 if row else 404,row or {'error':'original_not_present','noExecutionProof':False})
            if path.path=='/v1/inference/admission':
                query=urllib.parse.parse_qs(path.query);amount=int(query['maximumMicroUsd'][0])
                with db() as c: ready=independent_ready(c,amount)
                return self.reply(200,{'ready':ready,'maximumMicroUsd':str(amount),'rail':'owned_prepaid_allowance'})
            if path.path.startswith('/v1/effects/'):
                identifier=urllib.parse.unquote(path.path[len('/v1/effects/'):]);check_id(identifier)
                with db() as c: row=c.execute('SELECT id,input_hash,kind,instance,epoch,state,result,created_at,updated_at FROM continuity.effects WHERE id=%s',(identifier,)).fetchone()
                return self.reply(200 if row else 404,row or {'error':'original_not_present'})
            return self.reply(404,{'error':'not_found'})
        except Exception as e:return self.reply(409,{'error':type(e).__name__})
    def do_POST(self):
        if self.path=='/sql':return self.sql_proxy()
        operator=self.path in ('/v1/grants','/v1/fence/transition','/v1/fence/drain','/v1/fence/resume','/v1/fence/coverage','/v1/recovery/sql','/v1/recovery/sequences','/v1/fence/enforcement')
        if not self.authenticated(operator):return self.reply(401,{'error':'unauthorized'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=12600000:raise ValueError('request_size')
            b=json.loads(self.rfile.read(length))
            if self.path=='/v1/recovery/sql':
                database=b['database']
                if database not in ('postgres','claus_continuity',*['recovery_'+n for n in ('agent','signer','payments','network','portable','applications','website')]):raise ValueError('database_scope')
                query=b['query']
                if not isinstance(query,str) or len(query)>2000000:raise ValueError('query_size')
                with psycopg.connect(**{**CONNECTION,'dbname':database},autocommit=True,row_factory=dict_row,connect_timeout=10) as c:
                    c.execute("SET statement_timeout='120s'")
                    with psycopg.RawCursor(c) as cur:
                        cur.execute(query,b.get('params'),prepare=False)
                        rows=cur.fetchall() if cur.description else []
                        command=cur.statusmessage
                return self.reply(200,{'rows':rows,'command':command})
            if self.path=='/v1/recovery/sequences':
                with db() as c:
                    active=c.execute('SELECT active_instance FROM continuity.control WHERE id').fetchone()
                    if active['active_instance']!='primary':raise ValueError('recovery_database_is_active')
                from sequences import restore
                return self.reply(200,{'changes':restore(CONNECTION)})
            if self.path=='/v1/inference/start':return self.reply(202,claim_inference(b))
            if self.path=='/v1/grants':
                identifier=check_id(b['id']);amount=int(b['amountMicroUsd']);expiry=datetime.datetime.fromisoformat(b['expiresAt'].replace('Z','+00:00'))
                now=datetime.datetime.now(datetime.timezone.utc)
                if not 1<=amount<=500000000 or not now<expiry<=now+datetime.timedelta(hours=24):raise ValueError('grant_bound')
                if b['source'].get('state')!='committed' or b['source'].get('id')!=identifier or str(b['source'].get('maximum'))!=str(amount):raise ValueError('committed_original_required')
                with db() as c:
                    c.execute('INSERT INTO continuity.grants(id,amount_micro,expires_at,source) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',(identifier,amount,expiry,Jsonb(b['source'])))
                    row=c.execute('SELECT id,amount_micro,expires_at,source FROM continuity.grants WHERE id=%s',(identifier,)).fetchone()
                    if row['amount_micro']!=amount or row['expires_at']!=expiry or row['source']!=b['source']:raise ValueError('original_grant_conflict')
                return self.reply(200,{'id':identifier,'recorded':True,'expiresAt':expiry})
            if self.path=='/v1/fence/enforcement':
                if b.get('enabled') is not True:raise ValueError('disabling_requires_owner_recovery')
                with db() as c:
                    row=c.execute("UPDATE continuity.control SET enforce_effects=true,transition_not_before=CASE WHEN enforce_effects THEN transition_not_before ELSE now()+interval '16 minutes' END WHERE id AND epoch=%s RETURNING epoch,transition_not_before",(b['expectedEpoch'],)).fetchone()
                    if not row:raise ValueError('epoch_changed')
                    event(c,'enforcement_enabled',b)
                return self.reply(200,{'enabled':True,**row})
            if self.path=='/v1/fence/coverage':
                if b['component'] not in ('native','lab','custody','payments','network','website') or not isinstance(b['deployment'],str) or not 1<=len(b['deployment'])<=200:raise ValueError('component_invalid')
                with db() as c:
                    c.execute("INSERT INTO continuity.components(name,deployment) VALUES(%s,%s) ON CONFLICT(name) DO UPDATE SET deployment=excluded.deployment,enrolled_at=now(),last_claim_at=NULL,last_epoch=NULL",(b['component'],b['deployment']))
                    event(c,'component_enrolled',b)
                return self.reply(200,{'component':b['component'],'enrolled':True})
            if self.path in ('/v1/fence/drain','/v1/fence/resume'):
                with db() as c:
                    current=c.execute('SELECT * FROM continuity.control WHERE id FOR UPDATE').fetchone()
                    if current['epoch']!=b['expectedEpoch'] or current['active_instance']!=b['instance']:raise ValueError('epoch_changed')
                    phase='draining' if self.path.endswith('/drain') else 'active'
                    if phase=='active' and current['active_instance']=='primary':
                        for name in ('agent','signer','payments','network','portable','applications','website'):
                            with psycopg.connect(**{**CONNECTION,'dbname':'recovery_'+name},autocommit=True) as target:
                                target.execute('ALTER SUBSCRIPTION claus_independent_recovery ENABLE')
                    c.execute('UPDATE continuity.control SET phase=%s,updated_at=now() WHERE id',(phase,));event(c,'fence_'+phase,b)
                return self.reply(200,{'epoch':current['epoch'],'phase':phase,'leaseUntil':current['lease_until']})
            if self.path=='/v1/barriers/wait':
                identifier=check_id(b['id']);names=b['databases']
                if not isinstance(names,list) or not names or len(names)>7 or len(set(names))!=len(names) or any(n not in ('agent','signer','payments','network','portable','applications','website') for n in names):raise ValueError('database_scope')
                pending=set(names);until=time.monotonic()+15
                while pending and time.monotonic()<until:
                    for name in list(pending):
                        with psycopg.connect(**{**CONNECTION,'dbname':'recovery_'+name},autocommit=True,connect_timeout=3) as c:
                            if c.execute('SELECT 1 FROM public.claus_continuity_barriers WHERE id=%s AND schema_fingerprint=public.claus_continuity_schema_signature()',(identifier,)).fetchone():pending.remove(name)
                    if pending:time.sleep(.15)
                return self.reply(200 if not pending else 503,{'id':identifier,'confirmed':not pending,'pending':sorted(pending)})
            if self.path=='/v1/fence/permit':
                with db() as c:
                    row=c.execute("UPDATE continuity.control SET lease_until=now()+interval '20 seconds',updated_at=now() WHERE id AND phase='active' AND active_instance=%s AND epoch=%s RETURNING epoch,active_instance,lease_until",(b['instance'],int(b['epoch']))).fetchone()
                return self.reply(200,{'allowed':bool(row),**(row or {})})
            if self.path=='/v1/fence/transition':
                # This intentionally refuses takeover until every original has a terminal record.
                with db() as c:
                    current=c.execute('SELECT *,lease_until<now() expired,transition_not_before<now() legacy_drained FROM continuity.control WHERE id FOR UPDATE').fetchone()
                    if not current['enforce_effects'] or not current['legacy_drained']:raise ValueError('legacy_executions_not_drained')
                    pending=c.execute("SELECT 1 FROM continuity.effects WHERE state IN('claimed','uncertain') UNION ALL SELECT 1 FROM continuity.inference WHERE state NOT IN('completed','failed','not_dispatched') LIMIT 1").fetchone()
                    coverage=c.execute('SELECT name FROM continuity.components WHERE last_claim_at>=enrolled_at AND last_epoch=%s',(current['epoch'],)).fetchall()
                    transition_allowed(current,b['expectedEpoch'],bool(pending),[r['name'] for r in coverage],b['instance'])
                    recovery=c.execute("SELECT name,body,last_error,sampled_at>=now()-interval '60 seconds' fresh FROM continuity.replication_state").fetchall()
                    if not recovery_ready(recovery):raise ValueError('fresh_applied_recovery_state_required')
                    if b['instance'] not in ('primary','standby'):raise ValueError('instance_invalid')
                    if b['instance']=='standby':
                        # Freeze the replicas before allowing a new writer. An old
                        # primary must never stream writes over replacement state.
                        for name in ('agent','signer','payments','network','portable','applications','website'):
                            with psycopg.connect(**{**CONNECTION,'dbname':'recovery_'+name},autocommit=True) as target:
                                target.execute('ALTER SUBSCRIPTION claus_independent_recovery DISABLE')
                        from sequences import restore
                        restore(CONNECTION)
                    c.execute("UPDATE continuity.control SET epoch=epoch+1,active_instance=%s,phase='active',updated_at=now() WHERE id",(b['instance'],));event(c,'fence_transition',b)
                return self.reply(200,{'epoch':current['epoch']+1,'activeInstance':b['instance']})
            if self.path=='/v1/effects/claim':
                identifier=check_id(b['id']); fingerprint=b['inputHash']
                if not re.fullmatch('[a-f0-9]{64}',fingerprint):raise ValueError('input_hash')
                with db() as c:
                    current=c.execute("SELECT * FROM continuity.control WHERE id AND phase='active' AND active_instance=%s AND epoch=%s AND lease_until>now() FOR SHARE",(b['instance'],int(b['epoch']))).fetchone()
                    if not current:raise ValueError('instance_fenced')
                    token=secrets.token_urlsafe(32)
                    row=c.execute("INSERT INTO continuity.effects(id,input_hash,kind,instance,epoch,token,input,state) VALUES(%s,%s,%s,%s,%s,%s,%s,'claimed') ON CONFLICT DO NOTHING RETURNING id",(identifier,fingerprint,b['kind'],b['instance'],current['epoch'],token,Jsonb(b['input']))).fetchone()
                    component=b['input'].get('component') if isinstance(b['input'],dict) else None
                    if component:c.execute('UPDATE continuity.components SET last_claim_at=now(),last_epoch=%s WHERE name=%s',(current['epoch'],component))
                    original=c.execute('SELECT input_hash,state,result FROM continuity.effects WHERE id=%s',(identifier,)).fetchone()
                    if original['input_hash']!=fingerprint:raise ValueError('original_effect_conflict')
                return self.reply(200,{'id':identifier,'execute':bool(row),'state':original['state'],'result':original['result'],**({'token':token,'epoch':current['epoch']} if row else {})})
            if self.path=='/v1/effects/settle':
                identifier=check_id(b['id']);state=b['state']
                if state not in ('completed','failed','uncertain'):raise ValueError('effect_state')
                with db() as c:
                    row=c.execute("UPDATE continuity.effects SET state=%s,result=%s,updated_at=now() WHERE id=%s AND token=%s AND state IN('claimed','uncertain') RETURNING id",(state,Jsonb(b.get('result')),identifier,b['token'])).fetchone()
                    if not row:
                        old=c.execute('SELECT state,result FROM continuity.effects WHERE id=%s AND token=%s',(identifier,b['token'])).fetchone()
                        if not old or old['state']!=state or old['result']!=b.get('result'):raise ValueError('effect_settlement_conflict')
                return self.reply(200,{'id':identifier,'state':state})
            if self.path=='/v1/checkpoints':
                name=check_id(b['name']);revision=int(b['revision']);fingerprint=digest(b['body'])
                with db() as c:
                    row=c.execute('INSERT INTO continuity.checkpoints(name,revision,input_hash,body,source_at) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(name) DO UPDATE SET revision=EXCLUDED.revision,input_hash=EXCLUDED.input_hash,body=EXCLUDED.body,source_at=EXCLUDED.source_at,saved_at=now() WHERE continuity.checkpoints.revision<EXCLUDED.revision RETURNING revision',(name,revision,fingerprint,Jsonb(b['body']),b['sourceAt'])).fetchone()
                    if not row:
                        old=c.execute('SELECT revision,input_hash FROM continuity.checkpoints WHERE name=%s',(name,)).fetchone()
                        if old['revision']!=revision or old['input_hash']!=fingerprint:raise ValueError('checkpoint_revision_conflict')
                return self.reply(200,{'name':name,'revision':revision,'hash':fingerprint})
            return self.reply(404,{'error':'not_found'})
        except (ValueError,KeyError,TypeError) as e:return self.reply(409,{'error':str(e)[:120]})
        except Exception as e:return self.reply(503,{'error':type(e).__name__,'retryMutation':False})

    def sql_proxy(self):
        try:
            url=urllib.parse.urlsplit(self.headers.get('Neon-Connection-String',''))
            database=url.path.lstrip('/')
            if url.scheme not in ('postgres','postgresql') or not database.startswith('recovery_'):raise ValueError('database_scope')
            # The initial recovery interface exposes only this read-only role.
            # Application-role write activation requires a separate fenced release.
            if urllib.parse.unquote(url.username or '')!='claus_recovery_reader':raise ValueError('reader_required')
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=12600000:raise ValueError('request_size')
            body=json.loads(self.rfile.read(length));queries=body.get('queries',[body])
            if not isinstance(queries,list) or not 1<=len(queries)<=200:raise ValueError('query_count')
            conn={**CONNECTION,'dbname':database,'user':'claus_recovery_reader','password':urllib.parse.unquote(url.password or '')}
            results=[]
            with psycopg.connect(**conn,connect_timeout=10) as c:
                c.execute("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='30s'")
                c.execute('SELECT 1')
                for query in queries:
                    with psycopg.RawCursor(c) as cur:
                        cur.execute(query['query'],query.get('params',[]),prepare=True)
                        result=cur.pgresult
                        fields=[{'name':result.fname(i).decode(),'dataTypeID':result.ftype(i),'format':'text'} for i in range(result.nfields)]
                        rows=[[None if result.get_value(r,col) is None else result.get_value(r,col).decode() for col in range(result.nfields)] for r in range(result.ntuples)]
                        results.append({'fields':fields,'rows':rows,'rowCount':cur.rowcount,'command':(cur.statusmessage or '').split(' ')[0]})
            return self.reply(200,{'results':results} if 'queries' in body else results[0])
        except Exception as e:return self.reply(400,{'message':'Recovery query rejected','code':getattr(e,'sqlstate',None) or 'RECOVERY_QUERY_REJECTED'})

def serve(config,connection):
    CFG.update(config);CONNECTION.update(connection)
    with db() as c:
        # Selecting has made no outbound POST. Dispatching may have, so never resend it.
        c.execute("UPDATE continuity.inference SET state='queued' WHERE state='selecting'")
        c.execute("UPDATE continuity.inference SET state='uncertain' WHERE state='dispatching'")
        queued=c.execute("SELECT id FROM continuity.inference WHERE state='queued'").fetchall()
    from replication import start as start_replication
    start_replication(connection)
    for row in queued:POOL.submit(dispatch,row['id'])
    ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
