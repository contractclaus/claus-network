import {DEVELOPMENT_PROFILE,developmentShape} from './development-profile.js';
import {developmentInput,DevelopmentExecution,DEVELOPMENT_LIMITS} from './development-execution.js';
import {sql,once,actionProgress,settleAction,ConfirmedFailure,journal} from './store.js';
import {projectById,saveProject,projectCheckpoint} from './archive.js';
import {digest} from './config.js';
import {createNetworkAccess} from './network-access.js';
import {importRelease} from './development-source.js';
const access=createNetworkAccess();

const execution=new DevelopmentExecution();
async function applyCheckpoint(action:any,result:any){
 const project=action.progress.project;
 if(!result.checkpointSnapshotId)return {...result,projectId:project.id,projectVersion:project.version,actionId:action.id};
 const current=await projectById(project.id);
 if(current?.snapshot_id===result.checkpointSnapshotId)return {...result,checkpointApplied:true,projectId:project.id,projectVersion:current.version,actionId:action.id};
 if(current?.version!==project.version)return {...result,checkpointApplied:false,reason:'project_changed_preserved_as_branch',projectId:project.id,projectVersion:current?.version??null,actionId:action.id};
 try{const saved=await projectCheckpoint(project.id,project.version,result.checkpointSnapshotId,result.exitCode);return {...result,checkpointApplied:true,projectId:project.id,projectVersion:saved.version,actionId:action.id};}
 catch(error){if(error instanceof Error&&error.message==='project_checkpoint_conflict')return {...result,checkpointApplied:false,reason:'project_changed_preserved_as_branch',projectId:project.id,actionId:action.id};throw error;}
}
export async function developProject(id:string,args:any){
 const input=developmentInput(args),shape=developmentShape(input),base=process.env.LAB_RESEARCH_SNAPSHOT_ID;if(!base)throw new ConfirmedFailure('development_toolchain_unavailable');
 const db=sql(),hash=digest(input);
 if(input.workId){const work=(await db`SELECT status FROM claus_network_work WHERE id=${input.workId}`)[0];if(!work||!['ready','working','waiting'].includes(work.status))throw new ConfirmedFailure('development_work_inactive');}
 const admit=async()=>{
  const [,rows]=await db.transaction([db`SELECT pg_advisory_xact_lock(746201603)`,db`WITH admitted AS (SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM claus_actions WHERE kind='development' AND status NOT IN ('completed','failed') AND progress->'project'->>'id'=${input.projectId??''}) AND (SELECT count(*) FROM claus_actions WHERE kind IN ('development','development_export') AND status NOT IN ('completed','failed'))<${DEVELOPMENT_LIMITS.active} AND (SELECT coalesce(sum(CASE WHEN kind='development' THEN coalesce((input->>'vcpus')::integer,2) ELSE 2 END),0) FROM claus_actions WHERE kind IN ('development','development_export') AND status NOT IN ('completed','failed'))+${shape.vcpus}<=${DEVELOPMENT_PROFILE.totalVcpus}) INSERT INTO claus_actions(id,kind,input_hash,status,input,visibility) SELECT ${id},'development',${hash},'pending',${JSON.stringify(input)}::jsonb,'private_network' FROM admitted ON CONFLICT DO NOTHING RETURNING id`]);
  if(!rows.length&&!(await db`SELECT id FROM claus_actions WHERE id=${id}`).length)throw new ConfirmedFailure('development_capacity_reached');return rows;
 };
 try{return await once(id,'development',input,async()=>{
  const project=input.projectId?await projectById(input.projectId):await saveProject(id,{title:input.title!,summary:input.purpose!});
  if(!project||input.projectId&&project.version!==input.expectedVersion)throw new ConfirmedFailure('development_project_version_changed');
  const progress:any={project};await actionProgress(id,progress);
  let importedFiles:{path:string;content:string}[]=[];
  if(input.source){let release:any;try{release=await access.call('release_preview',{projectId:input.source.projectId,releaseId:input.source.releaseId});importedFiles=importRelease(input.source,release);}catch{throw new ConfirmedFailure('development_source_unavailable_or_invalid');}progress.source={...input.source,contentHash:release.contentHash,files:importedFiles.length};await actionProgress(id,progress);}
  const result=await execution.run(id,input,project.snapshot_id??base,async value=>{progress.execution=value;await actionProgress(id,progress);},importedFiles);
  if('pending' in result&&result.pending)throw Error('development_continues');
  const saved=await applyCheckpoint({id,progress},result);
  await journal('development','Development command completed; checkpoint outcome recorded',{visibility:'private_network',projectId:project.id,actionId:id,result:saved});
  return saved;
 },db,admit);}catch(error){
  const action=(await db`SELECT id,status,progress FROM claus_actions WHERE id=${id} AND kind='development'`)[0];
  if(action?.status==='uncertain'&&action.progress?.execution?.deferred)return pendingDevelopment(action);
  throw error;
 }
}
export async function reconcileDevelopment(){
 const actions=await sql()`SELECT id,input,progress FROM claus_actions WHERE kind='development' AND status NOT IN ('completed','failed') AND (status='uncertain' AND progress->'execution'->>'phase'='funding' OR progress->'execution'->>'deferred'='true' OR (progress->'execution'->>'deadline')::timestamptz<now()) ORDER BY created_at LIMIT ${DEVELOPMENT_LIMITS.active}`;
 for(const action of actions){if(!action.progress?.project)continue;
  const save=async(value:any)=>actionProgress(action.id,{...action.progress,execution:value});
  const result=await execution.recover(action,save);if(!result)continue;
  await settleAction(action.id,await applyCheckpoint(action,result));
 }
}

function pendingDevelopment(a:any){const e=a.progress?.execution??{},observation=e.recoveryObservation;
 if(observation?.state==='stopped_outcome_unknown')return {actionId:a.id,state:observation.state,pending:false,outcome:'unknown',projectId:a.progress?.project?.id,phase:e.phase,deadline:e.deadline,shape:e.shape,funding:e.funding,recovery:observation,next:'The original VM is stopped and its command receipt is unavailable. Repeated status reads cannot recover this receipt. Preserve the original uncertain action and its cost; do not repeat its command. The retained filesystem snapshot may be inspected in a separate scoped workspace without replaying the original operation. A snapshot does not prove command success.'};
 return {actionId:a.id,state:'running_or_reconciling',pending:true,projectId:a.progress?.project?.id,phase:e.phase,deadline:e.deadline,shape:e.shape,funding:e.funding,next:'Read this original actionId with development_status. Do not repeat the command.'};}
export async function developmentStatus(args:any){
 if(!args||Object.keys(args).join()!=='actionId'||typeof args.actionId!=='string'||!args.actionId.startsWith('development:')||args.actionId.length>250)throw Error('development_status_invalid');
 let a=(await sql()`SELECT id,status,input,progress,result FROM claus_actions WHERE id=${args.actionId} AND kind='development'`)[0];if(!a)throw Error('development_action_missing');
 if(['completed','failed'].includes(a.status))return {actionId:a.id,state:a.status,result:a.result};
 if(a.status==='uncertain'&&a.progress?.execution?.phase==='funding'||a.progress?.execution?.deferred||Date.parse(a.progress?.execution?.deadline??'')<Date.now()){
  const result=await execution.recover(a,value=>actionProgress(a.id,{...a.progress,execution:value}));
  if(result){await settleAction(a.id,await applyCheckpoint(a,result));a=(await sql()`SELECT id,status,progress,result FROM claus_actions WHERE id=${args.actionId}`)[0];return {actionId:a.id,state:a.status,result:a.result};}
  a=(await sql()`SELECT id,status,progress,result FROM claus_actions WHERE id=${args.actionId}`)[0];
 }
 return pendingDevelopment(a);
}
