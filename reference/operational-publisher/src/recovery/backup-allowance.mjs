import {createHmac} from 'node:crypto';
import {authorized} from '../policy.js';
import {resourceStore} from '../resources/store.mjs';
import {resourceBudget} from '../resources/budget.mjs';
import {publisherRepository} from '../publisher/repository.js';
const slotMs=6*3600000,maximumPerSlot=400000;
export function backupAllowance({store,budget,secret,now=Date.now}){
 return async slot=>{
  const time=now(),current=Math.floor(time/slotMs);
  if(!Number.isSafeInteger(slot)||slot<current||slot>current+3)throw Error('backup_slot_invalid');
  const id='database-recovery-slot-v2-'+slot;
  const saved=(await store.put('backup-allowance',id,{version:2,id,slot,slotStart:slot,slots:1,maximumPerSlot,maximum:maximumPerSlot,validFrom:new Date(slot*slotMs).toISOString(),expiresAt:new Date((slot+1)*slotMs).toISOString(),createdAt:new Date(time).toISOString(),purpose:'Seven-database read-only encrypted recovery; maximum one attempt in this six-hour slot; retained for 30 days.'})).value;
  if(saved.version!==2||saved.slot!==slot||saved.maximum!==maximumPerSlot||saved.slots!==1)throw Error('backup_allowance_conflict');
  await budget('reserve',id,String(saved.maximum),'storage');
  await budget('commit',id,String(saved.maximum),'storage');
  return {allowance:saved,signature:createHmac('sha256',secret()).update(JSON.stringify(saved)).digest('hex')};
 };
}
export function installBackupAllowance(app){
 let issue;
 app.post('/api/recovery-backup/allowance',async c=>{
  if(process.env.SERVICE_ROLE!=='operator'||process.env.PUBLISHER_ENABLED!=='true')return c.json({error:'backup_disabled'},403);
  if(!authorized(c.req.header('authorization'),process.env.RECOVERY_BACKUP_SECRET))return c.json({error:'unauthorized'},401);
  try{
   if(!(await publisherRepository().settings()).enabled)return c.json({error:'backup_disabled'},403);
   const raw=await c.req.text();if(raw.length>128)return c.json({error:'backup_input_invalid'},400);
   const v=JSON.parse(raw);
   if(v&&Object.keys(v).join()==='requestId'&&/^bkp_[a-f0-9]{24}$/.test(v.requestId)){
    const allowance=await resourceStore().get('backup-allowance',v.requestId);
    if(allowance?.version!==3||allowance.id!==v.requestId||allowance.attempts!==1||allowance.maximum!==400000||!(Date.parse(allowance.expiresAt)>Date.now()))return c.json({error:'backup_allowance_unavailable'},409);
    return c.json({allowance,signature:createHmac('sha256',process.env.RECOVERY_BACKUP_SECRET).update(JSON.stringify(allowance)).digest('hex')});
   }
   if(!v||Object.keys(v).join()!=='slot')return c.json({error:'backup_input_invalid'},400);
   issue??=backupAllowance({store:resourceStore(),budget:resourceBudget(),secret:()=>process.env.RECOVERY_BACKUP_SECRET});
   return c.json(await issue(v.slot));
  }catch{return c.json({error:'backup_allowance_unavailable'},409);}
 });
}
