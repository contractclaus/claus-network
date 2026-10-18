import {primaryForwardNode} from './primary-forward.mjs';
import {createHash} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {continuityGate,continuityEnabled,postgresBarriers} from './continuity-gate.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');

// Preserve Node/Vercel response semantics, but release success only after the
// original effect and its database barrier are durable outside the primary.
export function withWebsiteContinuity(handler,{readSideEffects=false,gate,enabled=continuityEnabled}={}){
 return async function websiteHandler(req,res){
  if(await primaryForwardNode('web',req,res))return;
  const writesOnRead=typeof readSideEffects==='function'?readSideEffects(req):readSideEffects;
  if(!enabled()||!writesOnRead&&['GET','HEAD','OPTIONS'].includes(req.method))return handler(req,res);
  const guard=gate??continuityGate({component:'website',writeBarriers:postgresBarriers({website:(query,params)=>neon(process.env.CLUB_DATABASE_URL).query(query,params)})});
  const original={end:res.end,write:res.write,writeHead:res.writeHead,flushHeaders:res.flushHeaders};
  const chunks=[];let size=0,ended=false;
  const append=(chunk,encoding)=>{if(chunk===undefined||chunk===null)return;const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined);size+=b.length;if(size>12600000)throw Error('continuity_response_too_large');chunks.push(b);};
  res.write=function(chunk,encoding,callback){append(chunk,encoding);(typeof encoding==='function'?encoding:callback)?.();return true;};
  res.end=function(chunk,encoding,callback){append(chunk,encoding);ended=true;(typeof encoding==='function'?encoding:callback)?.();return this;};
  res.writeHead=function(status,text,headers){this.statusCode=status;if(typeof text==='string')this.statusMessage=text;for(const[k,v]of Object.entries((typeof text==='object'?text:headers)??{}))this.setHeader(k,v);return this;};
  res.flushHeaders=function(){};
  let failure;
  try{
   const body=req.body===undefined?null:typeof req.body==='string'?req.body:JSON.stringify(req.body),url=new URL(req.url,'https://claus.si');
   await guard({kind:req.method+' '+url.pathname,originalId:req.headers['idempotency-key']??null,input:{method:req.method,path:url.pathname,bodyHash:body===null?null:hash(body)}},async()=>{
    await handler(req,res);if(!ended)throw Error('continuity_response_incomplete');
    return {status:res.statusCode,responseSha256:hash(Buffer.concat(chunks)),bytes:size};
   });
  }catch(e){failure=e;}finally{for(const[k,v]of Object.entries(original))res[k]=v;}
  if(failure){for(const k of res.getHeaderNames?.()??[])res.removeHeader(k);res.statusCode=503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');return res.end(JSON.stringify({error:'original_outcome_unconfirmed',retryOriginalOnly:true}));}
  return res.end(Buffer.concat(chunks));
 };
}
