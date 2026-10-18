import {resourceStore} from '../resources/store.mjs';
import {publisherRepository} from '../publisher/repository.js';

export function queueLoad({store,workStatus=id=>publisherRepository().workStatus(id),now=Date.now}={}){
 return async input=>{
  if(!input||Object.keys(input).length!==2||!/^res_[a-f0-9]{24}$/.test(input.queueId??'')||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??''))throw Error('infrastructure_queue_load_invalid');
  store??=resourceStore();const q=await store.get('queue',input.queueId);
  if(!q||q.workId!==input.workId)throw Error('infrastructure_queue_load_scope');
  const load=await store.queueLoad(q.id);
  if(!Number.isSafeInteger(load.backlog)||!Number.isSafeInteger(load.busy)||load.backlog<0||load.busy<0)throw Error('infrastructure_queue_load_unavailable');
  return {queueId:q.id,workId:q.workId,backlog:load.backlog,busy:load.busy,enabled:q.enabled&&['ready','working','waiting'].includes(await workStatus(q.workId)),observedAt:now(),authority:'custody-queue-state',meaning:'Eligible delivery backlog and unresolved/accepted activity. HTTP acceptance remains busy until separately resolved; it is not job completion.'};
 };
}
