import {createHmac} from 'node:crypto';
import {authorized} from '../policy.js';
import {resourceStore} from '../resources/store.mjs';
import {resourceBudget} from '../resources/budget.mjs';
import {publisherRepository} from '../publisher/repository.js';
const slotMs=6*3600000,slots=28,maximumPerSlot=400000;
export function backupAllowance({store,budget,secret,now=Date.now}){
 return async period=>{
  const time=now(),current=Math.floor(time/(slots*slotMs));
  if(!Number.isSafeInteger(period)||period!==current&&!(period===current+1&&(current+1)*slots*slotMs-time<=86400000))throw Error('backup_period_invalid');
  const id='database-recovery-week-'+period;
  const saved=(await store.put('backup-allowance',id,{version:1,id,period,slotStart:period*slots,slots,maximumPerSlot,maximum:slots*maximumPerSlot,validFrom:new Date(period*slots*slotMs).toISOString(),expiresAt:new Date((period+1)*slots*slotMs).toISOString(),createdAt:new Date(time).toISOString(),purpose:'Seven-database read-only encrypted recovery; maximum one attempt per six-hour slot; retained for 30 days.'})).value;
  if(saved.period!==period||saved.maximum!==slots*maximumPerSlot||saved.slots!==slots)throw Error('backup_allowance_conflict');
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
   const v=JSON.parse(raw);if(!v||Object.keys(v).join()!=='period')return c.json({error:'backup_input_invalid'},400);
   issue??=backupAllowance({store:resourceStore(),budget:resourceBudget(),secret:()=>process.env.RECOVERY_BACKUP_SECRET});
   return c.json(await issue(v.period));
  }catch{return c.json({error:'backup_allowance_unavailable'},409);}
 });
}
