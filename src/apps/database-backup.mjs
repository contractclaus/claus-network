import {canonical,copy,digest,integer,requireThat} from '../shared/index.mjs';
export const APP_DATABASE_BACKUP='claus-app-database-backup/1';
export const DATABASE_LIMITS=Object.freeze({rows:100000,bytes:134217728,page:50,pageBytes:524288});
export const databaseOrder=(a,b)=>Buffer.compare(Buffer.from(a.collection),Buffer.from(b.collection))||Buffer.compare(Buffer.from(a.id),Buffer.from(b.id));
export const databaseVersion=rows=>digest(rows.map(({collection,id,revision})=>({collection,id,revision})));

export function createAppDatabaseBackup({storage,identity,now=()=>Date.now()}){
 return async function databaseExport(actor,projectId,{after='',limit=50}={}){
  requireThat(storage,'apps_not_enabled');integer(limit,1,DATABASE_LIMITS.page);
  return storage.transaction(projectId,async tx=>{
   const {who}=await identity.owner(actor,projectId,tx.network);requireThat(await tx.read('meta','app'),'not_found');
   let cursor=null;
   if(after){try{cursor=JSON.parse(Buffer.from(after,'base64url').toString('utf8'));}catch{requireThat(false,'invalid_cursor');}
    requireThat(cursor?.projectId===projectId&&cursor.owner===who.principalId&&cursor.snapshot?.schema===APP_DATABASE_BACKUP&&typeof cursor.collection==='string'&&typeof cursor.id==='string','invalid_cursor');}
   let snapshot=cursor?.snapshot;
   if(!snapshot){const metadata=await tx.databaseMetadata(DATABASE_LIMITS.rows+1);requireThat(metadata.length<=DATABASE_LIMITS.rows,'app_database_backup_too_large');
    const bytes=metadata.reduce((n,r)=>n+r.bytes,0);requireThat(bytes<=DATABASE_LIMITS.bytes,'app_database_backup_too_large');
    snapshot={schema:APP_DATABASE_BACKUP,projectId,version:databaseVersion(metadata),rows:metadata.length,createdAt:now(),authority:'historical-only',financialActions:false};}
   const found=await tx.databaseRows({after:cursor?{collection:cursor.collection,id:cursor.id}:null,limit:limit+1});
   const items=[];let responseBytes=0;
   for(const row of found.slice(0,limit)){const bytes=Buffer.byteLength(canonical(row));if(items.length&&responseBytes+bytes>DATABASE_LIMITS.pageBytes)break;items.push(copy(row));responseBytes+=bytes;}
   const complete=items.length===found.length;
   if(complete){const metadata=await tx.databaseMetadata(DATABASE_LIMITS.rows+1);requireThat(metadata.length===snapshot.rows&&databaseVersion(metadata)===snapshot.version,'app_database_backup_changed');}
   const last=items.at(-1),nextCursor=complete?null:Buffer.from(JSON.stringify({projectId,owner:who.principalId,snapshot,collection:last.collection,id:last.id})).toString('base64url');
   return {snapshot,items,nextCursor,complete,instructionAuthority:false};
  });
 };
}
