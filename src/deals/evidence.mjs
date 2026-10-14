import {canonical,digest,requireThat,shape,sourceText} from '../shared/index.mjs';

export const DEAL_EVIDENCE_LIMITS=Object.freeze({text:12000,links:8,bytes:16000,projectDaily:8,globalDaily:100,projectTotal:1000});
export const evidenceHash=value=>'0x'+digest(value).slice(7);
export function validateDealEvidence(value){
 shape(value,['version','visibility','kind','text','links']);
 requireThat(value.version===1&&value.visibility==='public'&&['terms','result','dispute'].includes(value.kind),'invalid_deal_evidence');
 sourceText(value.text,DEAL_EVIDENCE_LIMITS.text);requireThat(value.text.trim().length>=20&&Array.isArray(value.links)&&value.links.length<=DEAL_EVIDENCE_LIMITS.links,'invalid_deal_evidence');
 for(const raw of value.links){let u;try{u=new URL(raw);}catch{}requireThat(typeof raw==='string'&&raw.length<=500&&u?.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)&&!u.hostname.endsWith('.local'),'invalid_deal_evidence');}
 requireThat(Buffer.byteLength(canonical(value))<=DEAL_EVIDENCE_LIMITS.bytes,'deal_evidence_too_large');return evidenceHash(value);
}
export function createDealEvidence({store,identity,now=()=>Date.now()}){
 return {
  async publish(actor,projectId,document){const hash=validateDealEvidence(document);return store.transaction(async tx=>{
   await identity.authorize(actor,'deal.evidence',{projectId},tx);const old=await tx.read('deal-evidence',hash);if(old)return {hash,document:old.value.document,public:true};
   const day=Math.floor(now()/86400000);for(const [id,limit]of [[projectId+':'+day,DEAL_EVIDENCE_LIMITS.projectDaily],['global:'+day,DEAL_EVIDENCE_LIMITS.globalDaily],[projectId+':total',DEAL_EVIDENCE_LIMITS.projectTotal]]){const r=await tx.read('deal-evidence-limits',id);requireThat((r?.value.count??0)<limit,'deal_evidence_capacity');await tx.write('deal-evidence-limits',id,{count:(r?.value.count??0)+1},r?.revision??0);}
   await tx.write('deal-evidence',hash,{hash,projectId,document,createdAt:now()},0);return {hash,document,public:true};
  });},
  async read(hash,reader=store){requireThat(/^0x[0-9a-f]{64}$/.test(hash??''),'invalid_deal_evidence');const r=await reader.read('deal-evidence',hash);requireThat(r&&validateDealEvidence(r.value.document)===hash,'not_found');return {hash,document:r.value.document,public:true};},
  async bundle(deal,reader=store){const out={};for(const [kind,field]of [['terms','termsHash'],['result','resultHash'],['dispute','disputeHash']]){const hash=deal[field].toLowerCase();let evidence;try{evidence=await this.read(hash,reader);}catch(e){if(kind!=='dispute'||e.code!=='not_found')throw e;out[kind]={hash,document:null,status:'unavailable'};continue;}if(kind==='dispute'&&evidence.document.kind!==kind){out[kind]={...evidence,status:'wrong_kind'};continue;}requireThat(evidence.document.kind===kind,'deal_evidence_mismatch');out[kind]=evidence;}return out;}
 };
}
