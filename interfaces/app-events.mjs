// Cursors are acknowledged by the consumer. Persist nextCursor only after
// processing a batch; a crashed consumer then replays instead of losing events.
export async function* subscribeAppEvents(client,{projectId,after='',signal,pollMs=3000,maxPollMs=30000,waitMs=15000,wait=delay}={}){
 if(typeof projectId!=='string'||!projectId||!Number.isInteger(pollMs)||pollMs<1000||!Number.isInteger(maxPollMs)||maxPollMs<pollMs||maxPollMs>60000||!Number.isInteger(waitMs)||waitMs<0||waitMs>15000)throw Error('invalid_subscription');
 let pause=pollMs;
 while(!signal?.aborted){
  try{
   const batch=await client.call('app_events',{projectId,...(after?{after}:{}),limit:100,waitMs},{signal});
   if(!Array.isArray(batch.items)||typeof batch.nextCursor!=='string')throw Error('invalid_event_response');
   if(batch.items.length||batch.nextCursor!==after)yield {...batch,previousCursor:after};
   after=batch.nextCursor;
   pause=batch.items.length?pollMs:Math.min(maxPollMs,Math.ceil(pause*1.5));
   if(!batch.hasMore&&(!waitMs||batch.items.length))await wait(pause,signal);
  }catch(error){
   if(signal?.aborted)return;
   if(error.status===401||error.status===403||error.status===400||error.code==='invalid_cursor'||error.message==='invalid_event_response')throw error;
   if(error.status&&error.status!==429&&error.status<500)throw error;
   pause=Math.min(maxPollMs,Math.max(pollMs,pause*2));await wait(pause,signal);
  }
 }
}
function delay(ms,signal){return new Promise(resolve=>{if(signal?.aborted){resolve();return;}const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();},timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});});}

export async function* exportApplication(client,{projectId,signal}={}){
 let after,version;
 do{const page=await client.call('app_export',{projectId,...(after?{after}:{})},{signal});
  if(page.schemaVersion!=='claus-app-export/1'||!Array.isArray(page.items)||version&&version!==page.contentVersion)throw Error('app_export_changed');
  version=page.contentVersion;yield page;after=page.nextCursor;
 }while(after&&!signal?.aborted);
}
