import {neon} from '@neondatabase/serverless';
export function validateOwnerMission(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['id','body','allowChainWrite'].includes(k)))throw Error('mission_invalid');
 const {id,body,allowChainWrite=false}=value;
 if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)||typeof body!=='string'||!body.trim()||body.length>16000||typeof allowChainWrite!=='boolean')throw Error('mission_invalid');
 return {id,body,allowChainWrite};
}
export function missionService(db=neon(process.env.NATIVE_CONFIGURATION_DATABASE_URL)){
 return {
  async read(id){
   if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id))throw Error('mission_invalid');
   const rows=await db`SELECT id,body,chain_write,status,result,created_at,completed_at FROM claus_missions WHERE id=${id}`;
   if(!rows[0])throw Error('mission_not_found');return rows[0];
  },
  async assign(value){
   const {id,body,allowChainWrite}=validateOwnerMission(value);
   // Original request and owner audit are one atomic statement. A lost response
   // reads the same ID; it neither changes authority nor recreates completed work.
   await db`WITH inserted AS (
    INSERT INTO claus_missions(id,body,chain_write) VALUES(${id},${body},${allowChainWrite}) ON CONFLICT DO NOTHING RETURNING id,chain_write
   ) INSERT INTO claus_journal(kind,summary,data,visibility)
    SELECT 'owner_mission','Owner mission admitted',jsonb_build_object('id',id,'chainWrite',chain_write,'custodian','fixed-configuration'),'private_network' FROM inserted`;
   const original=await this.read(id);
   if(original.body!==body||original.chain_write!==allowChainWrite)throw Error('mission_conflict');
   // Existing runtime polling discovers this mission; no lease reset or dispatch.
   return {id:original.id,status:original.status,allowChainWrite:original.chain_write};
  }
 };
}
