const text=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;if(cls)n.className=cls;return n;};
const labels={pass:'Pass',fail:'Needs changes',insufficient_evidence:'More evidence needed'};
let active=null;
export function showReview(task,host,{api,projectId}){
 active?.abort();active=null;if(!task.reviewPolicy)return;
 const section=text('section',undefined,'delivery-result review-result');section.append(text('h3','Review'));
 const status=text('p',undefined,'review-status');status.setAttribute('role','status');
 const content=text('div'),controls=text('div',undefined,'review-controls');
 const retry=text('button','Refresh review','quiet');retry.type='button';
 const url=api+'/v1/public/apps/'+encodeURIComponent(projectId)+'/tasks/'+encodeURIComponent(task.id)+'/review';
 const source=text('a','Evidence');source.href=url;source.target='_blank';source.rel='noopener noreferrer';
 controls.append(retry,source);section.append(status,content,controls);host.append(section);
 async function read(){
  active?.abort();const request=new AbortController();active=request;const timeout=setTimeout(()=>request.abort(),15000);
  section.setAttribute('aria-busy','true');retry.disabled=true;status.textContent='Loading review…';
  try{
   const response=await fetch(url,{credentials:'omit',cache:'no-store',signal:request.signal});
   if(!response.ok)throw Error('review_unavailable');const data=await response.json();
   if(active!==request||!section.isConnected)return;
   if(data.taskId!==task.id||data.projectId!==projectId||!Array.isArray(data.policy?.criteria))throw Error('invalid_review');
   const report=data.report,fragment=document.createDocumentFragment();
   status.textContent=report?(data.challenges.length?'Review challenged':labels[report.outcome]||'Review recorded'):data.request?'Awaiting reviewer':'Reviewer selected';
   const identity=text('dl');identity.append(text('dt','Reviewer'),text('dd',data.policy.reviewerId));fragment.append(identity);
   for(const criterion of data.policy.criteria){
    const result=report?.criteria.find(c=>c.id===criterion.id),item=text('div',undefined,'review-criterion');
    item.append(text('p',criterion.description,'review-criterion-title'));
    if(result)item.append(text('strong',labels[result.outcome]||result.outcome),text('p',result.rationale,'review-copy'));
    fragment.append(item);
   }
   if(report){
    const details=text('details');details.append(text('summary','Disclosure and limitations'),text('p',report.conflicts,'review-copy'),text('p',report.limitations,'review-copy'));fragment.append(details);
    if(!data.current)fragment.append(text('p','Recorded report. Recheck the current task and payment before acting.','review-copy'));
   }
   for(const challenge of data.challenges??[]){const objection=text('div',undefined,'review-criterion');objection.append(text('strong','Objection'),text('p',challenge.reason,'review-copy'));fragment.append(objection);}
   if(data.commission)fragment.append(text('p',data.commission.agreement?'Reviewer has a separate ETH agreement.':'Reviewer commission awaits its ETH agreement.','review-copy'));
   fragment.append(text('p','The buyer approves payment. Reviews and objections do not pause escrow deadlines.','review-copy'));
   content.replaceChildren(fragment);
  }catch{if(active===request&&section.isConnected){content.replaceChildren();status.textContent='Review could not load. Try again.';}}
  finally{clearTimeout(timeout);if(active===request){section.setAttribute('aria-busy','false');retry.disabled=false;}}
 }
 retry.onclick=()=>void read();void read();
}
