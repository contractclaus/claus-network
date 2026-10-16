import {createHash} from 'node:crypto';
import {once, sql, ConfirmedFailure} from '../store.js';
import {boundedObject, selectTool, type ExternalPolicy} from './providers.js';

type Parameter = {type:'string'|'number'|'integer'|'boolean'; maxLength?:number; minimum?:number; maximum?:number};
export type Adapter = {
  name:string; description:string;
  provider:'web'|'bazaar'|'composio'|'browserbase'; operation:string;
  parameters:Record<string,Parameter>; input:Record<string,unknown>;
};
const own = (v:object,k:string) => Object.prototype.hasOwnProperty.call(v,k);
const canonical = (v:any):any => Array.isArray(v) ? v.map(canonical) : v && typeof v==='object'
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
export const adapterDigest = (value:unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (code:string):never => {throw new ConfirmedFailure(code);};
const name = /^[a-z][a-z0-9_-]{0,63}$/;
const forbidden = new Set(['__proto__','prototype','constructor']);

// Templates are data. They cannot add headers, executable code, credentials,
// permissions or a new provider to the existing gateway.
export function validateAdapter(raw:unknown):Adapter {
  const a=boundedObject(raw,16000);
  if(Object.keys(a).some(k=>!['name','description','provider','operation','parameters','input'].includes(k))
    || typeof a.name!=='string' || !name.test(a.name) || typeof a.description!=='string' || !a.description.trim() || a.description.length>600)
    fail('adapter_definition_invalid');
  const operations:Record<string,string[]>={web:['read'],bazaar:['search','describe'],composio:['call'],browserbase:['browser_open']};
  if(!operations[a.provider]?.includes(a.operation))fail('adapter_operation_invalid');
  boundedObject(a.parameters); boundedObject(a.input);
  if(Object.keys(a.parameters).length>24)fail('adapter_parameters_invalid');
  for(const [key,rawSpec] of Object.entries(a.parameters)) {
    const s=boundedObject(rawSpec);
    if(!name.test(key)||forbidden.has(key)||!['string','number','integer','boolean'].includes(s.type)
      ||Object.keys(s).some(k=>!['type','maxLength','minimum','maximum'].includes(k))
      ||s.maxLength!==undefined&&(s.type!=='string'||!Number.isInteger(s.maxLength)||s.maxLength<1||s.maxLength>8000)
      ||[s.minimum,s.maximum].some(v=>v!==undefined&&(!['number','integer'].includes(s.type)||!Number.isFinite(v)))
      ||s.minimum!==undefined&&s.maximum!==undefined&&s.minimum>s.maximum)fail('adapter_parameters_invalid');
  }
  let nodes=0;
  function check(v:any,depth=0):void {
    if(++nodes>1000||depth>12)fail('adapter_template_too_complex');
    if(!v||typeof v!=='object')return;
    if(own(v,'$param')) {
      if(Object.keys(v).length!==1||typeof v.$param!=='string'||!own(a.parameters,v.$param))fail('adapter_parameter_reference_invalid');
      return;
    }
    for(const [k,child] of Object.entries(v)) {
      if(forbidden.has(k)||/^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(k))fail('adapter_secret_or_key_not_allowed');
      check(child,depth+1);
    }
  }
  check(a.input);
  if(a.provider==='composio'&&(typeof a.input.tool!=='string'||!/^[A-Z][A-Z0-9_]{1,159}$/.test(a.input.tool)||a.input.tool.startsWith('COMPOSIO_')))
    fail('adapter_fixed_tool_required');
  return canonical(a) as Adapter;
}

export function renderAdapter(adapter:Adapter,raw:unknown,policy:ExternalPolicy) {
  const params=boundedObject(raw,16000);
  if(Object.keys(params).length!==Object.keys(adapter.parameters).length
    ||Object.keys(params).some(k=>!own(adapter.parameters,k)))fail('adapter_parameters_invalid');
  for(const [k,s] of Object.entries(adapter.parameters)) {
    const v=params[k];
    if(!own(params,k)||s.type==='string'&&(typeof v!=='string'||v.length>(s.maxLength??8000))
      ||s.type==='boolean'&&typeof v!=='boolean'
      ||['integer','number'].includes(s.type)&&(typeof v!=='number'||!Number.isFinite(v)||s.type==='integer'&&!Number.isSafeInteger(v)
        ||s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum))fail('adapter_parameters_invalid');
  }
  const render=(v:any):any=>Array.isArray(v)?v.map(render):v&&typeof v==='object'
    ? own(v,'$param')?params[v.$param]:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,render(x)])):v;
  const input=render(adapter.input);
  // Every invocation checks today's policy, not the policy when it was saved.
  if(adapter.provider==='composio')selectTool(policy,input.tool,input.arguments??{});
  return {provider:adapter.provider,operation:adapter.operation,input:JSON.stringify(input)};
}

export function adapterAccessible(owner:string,requester:string) {
  return requester==='claus'||owner==='claus'||owner===requester;
}
function scope(owner:string) {
  if(owner!=='claus'&&!/^project:p_[a-f0-9]{32}$/.test(owner))fail('adapter_scope_invalid');
}
export async function saveAdapter(id:string,raw:unknown,principal:string,owner:string,db=sql()) {
  scope(owner);const definition=validateAdapter(raw);
  const hash=adapterDigest({owner,definition}),adapterId='adapter:'+hash;
  return once(id,'external_adapter',{principal,owner,definition},async()=>({adapterId,sha256:hash,owner,definition}),db);
}
export async function getAdapter(id:string,owner:string,db=sql()) {
  scope(owner);if(!/^adapter:[a-f0-9]{64}$/.test(id))fail('adapter_id_invalid');
  const row=(await db`SELECT input,result FROM claus_actions WHERE kind='external_adapter' AND status='completed' AND result->>'adapterId'=${id}
    AND (${owner}='claus' OR input->>'owner'='claus' OR input->>'owner'=${owner}) ORDER BY id LIMIT 1`)[0];
  if(!row||!adapterAccessible(row.input.owner,owner))fail('adapter_not_found');
  const definition=validateAdapter(row.input.definition);
  if('adapter:'+adapterDigest({owner:row.input.owner,definition})!==id)fail('adapter_integrity_failed');
  return {adapterId:id,owner:row.input.owner,definition};
}
export async function listAdapters(owner:string,offset=0,db=sql()) {
  scope(owner);if(!Number.isSafeInteger(offset)||offset<0)fail('adapter_offset_invalid');
  const rows=await db`SELECT DISTINCT result->>'adapterId' AS id,input->>'owner' AS owner,
    input->'definition'->>'name' AS name,input->'definition'->>'description' AS description
    FROM claus_actions WHERE kind='external_adapter' AND status='completed'
    AND (${owner}='claus' OR input->>'owner'='claus' OR input->>'owner'=${owner})
    ORDER BY id LIMIT 21 OFFSET ${offset}`;
  return {adapters:rows.slice(0,20),offset,nextOffset:rows.length>20?offset+20:null,instructionAuthority:false};
}
