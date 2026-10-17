import type {LabDatabase} from './lab-db.js';
import {hash} from './lab-schema.js';

// Shared across workers and cold starts. Reserving an attempt precedes the
// external request, so an interrupted request still counts against its limit.
export class ResearchCache {
  constructor(readonly db:LabDatabase,readonly now=()=>new Date()){}
  async read(kind:string,key:string,ttlMs:number,load:()=>Promise<any>,dailyLimit:number|null=null,accountingKind=kind){
    const id=kind+':'+hash(key);
    const entry=await this.db.transaction(async q=>{
      await q.query('SELECT pg_advisory_xact_lock(7439094)');
      const now=this.now(),lease=new Date(now.getTime()+60000);
      const {rows:[old]}=await q.query('SELECT * FROM claus_research_cache WHERE id=$1',[id]);
      if(old&&new Date(old.next_at)>now)return {load:false,result:old.result,error:old.error};
      const {rows:[count]}=await q.query("SELECT count(*)::int AS n FROM claus_research_reads WHERE kind=$1 AND created_at >= $2",[accountingKind,new Date(now.toISOString().slice(0,10)+'T00:00:00Z')]);
      if(dailyLimit!==null&&count.n>=dailyLimit)return {load:false,result:old?.result,error:'daily_read_limit'};
      await q.query('INSERT INTO claus_research_reads(kind,created_at) VALUES($1,$2)',[accountingKind,now]);
      await q.query("INSERT INTO claus_research_cache(id,next_at,error) VALUES($1,$2,'read_in_progress') ON CONFLICT(id) DO UPDATE SET next_at=$2,error='read_in_progress'",[id,lease]);
      return {load:true,lease};
    });
    if(!entry.load)return {available:entry.result!==null&&entry.result!==undefined&&!entry.error,cached:true,stale:!!entry.error,result:entry.result??null,error:entry.error??null};
    try{
      const result=await load();
      const updated=await this.db.query("UPDATE claus_research_cache SET result=$2::jsonb,next_at=$3,error=NULL WHERE id=$1 AND next_at=$4 AND error='read_in_progress' RETURNING id",[id,JSON.stringify(result),new Date(this.now().getTime()+ttlMs),entry.lease]);
      if(!updated.rows.length)return {available:false,cached:false,stale:true,result:null,error:'research_result_superseded'};
      return {available:true,cached:false,stale:false,result,error:null};
    }catch(error){
      const code=error instanceof Error&&/^(?:search|development)_[a-z0-9_]+$/.test(error.message)?error.message:'research_source_unavailable';
      const updated=await this.db.query("UPDATE claus_research_cache SET next_at=$2,error=$3 WHERE id=$1 AND next_at=$4 AND error='read_in_progress' RETURNING id",[id,new Date(this.now().getTime()+900000),code,entry.lease]);
      if(!updated.rows.length)return {available:false,cached:false,stale:true,result:null,error:'research_result_superseded'};
      return {available:false,cached:false,stale:true,result:null,error:code};
    }
  }
}

export async function boundedJSON(response:Response,max=500000){
  if(!response.body)throw Error('research_empty_response');
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('research_response_too_large');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
