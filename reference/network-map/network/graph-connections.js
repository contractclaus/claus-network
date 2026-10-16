// Supplement the first registry paint. One reader, bounded batches, original
// cursor on retry, and short-lived evidence; failure never hides the registry.
export function createConnectionLoader({request,onChange,visible=()=>!document.hidden,now=Date.now,schedule=setTimeout,cancel=clearTimeout}) {
  const records=new Map();let cursor=null,seen=new Set(),cursors=new Set(),controller=null,timer=null,stopped=false,nextAt=0;
  const publish=state=>{
    for(const [id,value] of records)if(now()-value.at>180000)records.delete(id);
    onChange([...records.values()].map(v=>v.page),state);
  };
  async function refresh() {
    if(stopped||controller||!visible())return;
    if(now()<nextAt){cancel(timer);timer=schedule(refresh,nextAt-now());return;}
    cancel(timer);controller=new AbortController();let complete=false,failed=false;
    try {
      for(let count=0;count<3;count++) {
        const {data}=await request('/surface-data?view=full'+(cursor?'&after='+encodeURIComponent(cursor):''),{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
        if(controller.signal.aborted)return;
        if(data?.schemaVersion!=='1.0'||!Array.isArray(data.nodes)||!Array.isArray(data.edges)||data.nextCursor!=null&&typeof data.nextCursor!=='string')throw Error('invalid_connections');
        const next=data.nextCursor||null;
        if(next&&(next===cursor||cursors.has(next)))throw Error('repeated_connections_cursor');
        for(const node of data.nodes)if(node.kind==='project'){
          seen.add(node.id);
          const coverage=data.connectionCoverage?.find(c=>c.projectId===node.id);
          if(coverage?.state==='unavailable')continue;
          records.set(node.id,{at:now(),page:{schemaVersion:'1.0',nodes:[],edges:data.edges.filter(e=>e.source===node.id),resources:(data.resources??[]).filter(r=>r.projectId===node.id)}});
        }
        if(next)cursors.add(next);cursor=next;
        if(!cursor){for(const id of records.keys())if(!seen.has(id))records.delete(id);seen=new Set();cursors=new Set();complete=true;}
        publish(complete?'available':'partial');
        if(complete)break;
      }
    }catch{failed=true;publish('unavailable');}
    finally{controller=null;nextAt=now()+(failed?15000:complete?60000:1000);if(!stopped&&visible())timer=schedule(refresh,nextAt-now());}
  }
  return {refresh,pause(){cancel(timer);controller?.abort();},stop(){stopped=true;cancel(timer);controller?.abort();records.clear();}};
}
