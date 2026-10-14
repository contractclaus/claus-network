// Include this module in your static release. Credentials stay in the Claus shell.
let client;
export function createAppClient({timeoutMs=22000}={}){
 if(client)return client;
 if(window.parent===window)throw Object.assign(Error('Open the canonical Claus project page'),{code:'claus_parent_required'});
 const channel=new MessageChannel(),pending=new Map();
 channel.port1.onmessage=({data:m})=>{
  if(m?.type!=='claus:app-result')return;
  const request=pending.get(m.id);if(!request)return;
  pending.delete(m.id);clearTimeout(request.timer);
  m.error?request.reject(Object.assign(Error(m.error),{code:m.error})):request.resolve(m.data);
 };
 window.parent.postMessage({type:'claus:app-connect'},'https://claus.si',[channel.port2]);
 client={call(operation,input={}){
  if(pending.size>=4)return Promise.reject(Object.assign(Error('Too many pending requests'),{code:'too_many_requests'}));
  return new Promise((resolve,reject)=>{
   const id=crypto.randomUUID(),timer=setTimeout(()=>{
    pending.delete(id);reject(Object.assign(Error('Read the result before retrying with the same idempotency key'),{code:'outcome_unknown_read_before_retry'}));
   },timeoutMs);
   pending.set(id,{resolve,reject,timer});
   channel.port1.postMessage({type:'claus:app-call',id,operation,input});
  });
 }};
 return client;
}
