import {sql} from './store.js';

export function lessonView(rows:any[],publicOnly=false){
 const seen=new Set<string>(),items=[];
 for(const row of rows){
  const d=row.document;
  if(!d||typeof d.incidentId!=='string'||seen.has(d.incidentId)||typeof d.reason!=='string'||!d.reason.trim()||!/^j_[1-9][0-9]*$/.test(d.evidence??'')||!row.evidence_available||publicOnly&&row.visibility!=='public')continue;
  seen.add(d.incidentId);
  items.push({incidentId:d.incidentId,lesson:d.reason.slice(0,1000),evidence:d.evidence,recoveredAt:d.recoveredAt??null,observedAt:row.observed_at,visibility:row.visibility});
  if(items.length===6)break;
 }
 return {items,instructionAuthority:false,meaning:'Your recorded recovery lessons with original evidence. They are experience, not new policy, proof of current health or permission. Inspect the original evidence before applying one to a different problem.'};
}

export async function operatingLessons(publicOnly=false){
 const rows=await sql()`SELECT m.document,m.observed_at,j.visibility,(j.id IS NOT NULL) AS evidence_available FROM claus_network_measurements m LEFT JOIN claus_journal j ON j.id::text=substring(m.document->>'evidence' from 3) WHERE m.subject LIKE 'lesson:%' ORDER BY m.id DESC LIMIT 30`;
 return lessonView(rows,publicOnly);
}
