import {textPrefix} from './text.js';
import {sql} from './store.js';

export function lessonView(rows:any[],publicOnly=false){
 const seen=new Set<string>(),items=[];
 for(const row of rows){
  const d=row.document;
  if(!d||typeof d.incidentId!=='string'||seen.has(d.incidentId)||typeof d.reason!=='string'||!d.reason.trim()||!/^j_[1-9][0-9]*$/.test(d.evidence??'')||!row.evidence_available||publicOnly&&row.visibility!=='public')continue;
  seen.add(d.incidentId);
  items.push({incidentId:d.incidentId,lesson:textPrefix(d.reason,1000),evidence:d.evidence,recoveredAt:d.recoveredAt??null,observedAt:row.observed_at,visibility:row.visibility});
  if(items.length===6)break;
 }
 return {items,instructionAuthority:false,meaning:'Your recorded recovery lessons with original evidence. They are experience, not new policy, proof of current health or permission. Inspect the original evidence before applying one to a different problem.'};
}

export async function operatingLessons(publicOnly=false,database:any=sql){
 const rows=await database()`SELECT * FROM (
  SELECT DISTINCT ON (m.document->>'incidentId') m.id,m.document,m.observed_at,j.visibility,true AS evidence_available
  FROM claus_network_measurements m JOIN claus_journal j ON j.id::text=substring(m.document->>'evidence' from 3)
  WHERE m.subject LIKE 'lesson:%' AND jsonb_typeof(m.document->'incidentId')='string'
   AND jsonb_typeof(m.document->'reason')='string' AND length(btrim(m.document->>'reason'))>0
   AND (m.document->>'evidence') ~ '^j_[1-9][0-9]*$' AND (NOT ${publicOnly} OR j.visibility='public')
  ORDER BY m.document->>'incidentId',m.id DESC
 ) lessons ORDER BY id DESC LIMIT 6`;
 return lessonView(rows,publicOnly);
}
