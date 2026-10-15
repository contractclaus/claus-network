import {textPrefix} from './text.ts';
import {createHash} from 'node:crypto';
import {configuration,once,sql,unresolved,settleAction,ConfirmedFailure} from './store.js';
import {completeRequest} from './model.js';
import {readPublicImage} from './research.js';
import {xRequest} from './x.js';
import {imageReviewChecks,imageReviewVersion,imageReviewQuestion} from './visual-prompts.js';
import {inspectionRequest,incompleteInspection,recoverInspection,visualObservation} from './visual-inspection.js';
import {prepareBrandImage} from './visual-palette.js';
import {loadNftImage,nftIdentity,type NftImageReference} from '../reference/nft-image-reference.mjs';
export {imageReviewQuestion} from './visual-prompts.js';

export function checkedImage(result:any) {
  const v=result?.image;
  if(!v||!['image/png','image/jpeg','image/webp'].includes(v.mime)||typeof v.base64!=='string'||v.base64.length>4200000)throw Error('invalid_generated_image');
  const bytes=Buffer.from(v.base64,'base64');
  if(bytes.length<32||bytes.length>3000000||bytes.toString('base64')!==v.base64||createHash('sha256').update(bytes).digest('hex')!==v.sha256)throw Error('invalid_generated_image');
  return {base64:v.base64 as string,mime:v.mime as string,sha256:v.sha256 as string,bytes:bytes.length};
}
export function imageReview(text:string,minimumVersion=1) {
  try {
    const j=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
    const strict=minimumVersion>=2||j.version!==undefined||j.checks!==undefined;
    const complete=!strict||j.version===imageReviewVersion&&typeof j.approved==='boolean'&&imageReviewChecks.every(k=>typeof j.checks?.[k]==='boolean');
    const passed=!strict||imageReviewChecks.every(k=>j.checks?.[k]===true);
    const description=typeof j.description==='string'?textPrefix(j.description,2000):'';
    const approved=j.approved===true&&complete&&passed&&(!strict||!!description.trim());
    return {approved,status:!complete||strict&&!description.trim()?'incomplete':approved?'approved':'rejected',description,...(strict&&complete?{checks:j.checks,version:imageReviewVersion}:{})};
  }
  catch{return {approved:false,status:'incomplete',description:'Image review did not return a valid verdict. Do not regenerate the image to repair an incomplete review.'};}
}
export function storedImageReview(imageId:string,rows:any[]) {
  const current=rows.find(r=>r.id===imageId+':review:v2:retry:1')??rows.find(r=>r.id===imageId+':review:v2');
  if(current?.status==='completed'&&incompleteInspection(current.result))return imageReview('',2);
  if(current)return imageReview(current.status==='completed'?current.result?.message?.content??'':'',2);
  const legacy=rows.find(r=>r.id===imageId+':review');
  return imageReview(legacy?.status==='completed'?legacy.result?.message?.content??'':'');
}
async function imageRecord(id:string) {
  if(typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(id))throw new ConfirmedFailure('invalid_image_id');
  const [r]=await sql()`SELECT input,result,progress FROM claus_actions WHERE id=${id} AND kind='image' AND status='completed'`;
  if(!r)throw new ConfirmedFailure('generated_image_not_found');
  return {input:r.input,progress:r.progress,image:checkedImage(r.result)};
}
const inspectionServices={complete:completeRequest,read:async(id:string)=>{const [r]=await sql()`SELECT status,result FROM claus_actions WHERE id=${id} AND kind='inference'`;return r?{status:r.status as string,result:r.result}:undefined;}};
export async function reviewGeneratedImage(id:string,dataUrl:string,prompt:string,identity?:NftImageReference) {
  const c=await configuration(),request=inspectionRequest(c.settings,dataUrl,imageReviewQuestion(prompt,identity),true,identity?.dataUrl);
  const review=await recoverInspection(id+':review:v2',request,result=>imageReview(incompleteInspection(result)?'':result.message.content,2),inspectionServices);
  return {approved:false,...review};
}
export async function reviewImage(id:string) {
  const c=await configuration();if(!c.policy.capabilities.images)throw new ConfirmedFailure('image_generation_disabled');
  const r=await imageRecord(id);
  if(typeof r.input?.prompt!=='string')throw new ConfirmedFailure('original_image_request_required');
  const identity=r.input.identityId===undefined?undefined:await loadNftImage(r.input.identityId);
  return {imageId:id,sha256:r.image.sha256,review:await reviewGeneratedImage(id,`data:${r.image.mime};base64,${r.image.base64}`,r.input.prompt,identity),private:true,published:false};
}
export async function recoveredImageResult(id:string) {
  const r=await imageRecord(id);
  const reviews=await sql()`SELECT id,status,result FROM claus_actions WHERE id IN (${id+':review:v2:retry:1'},${id+':review:v2'},${id+':review'}) AND kind='inference'`;
  return {imageId:id,sha256:r.image.sha256,review:storedImageReview(id,reviews),private:true,published:false};
}
export async function prepareGeneratedResult(result:any) {
  const source=checkedImage(result);
  try {
    const image=await prepareBrandImage(source.base64);
    return {image,sourceSha256:source.sha256,preparation:'claus-flat-v1',model:result.model,telemetry:result.telemetry};
  }catch{throw new ConfirmedFailure('generated_image_preparation_failed');}
}
export function imageInspectionId(callerId:string,request:unknown) {
  return (callerId.startsWith('club:')?'club:':'')+'vision_'+createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
export async function readImage(id:string,args:{url?:string;imageId?:string;question?:string}) {
  if(!!args.url===!!args.imageId||args.question!==undefined&&(typeof args.question!=='string'||args.question.length>1500))throw new ConfirmedFailure('choose_image_url_or_id');
  let dataUrl:string,source:string;
  if(args.imageId){const r=await imageRecord(args.imageId);dataUrl=`data:${r.image.mime};base64,${r.image.base64}`;source=args.imageId;}
  else {let image;try{image=await readPublicImage(args.url!);}catch{throw new ConfirmedFailure('public_image_unavailable');}dataUrl=image.dataUrl;source=image.url;}
  const c=await configuration(),request=inspectionRequest(c.settings,dataUrl,args.question??'Describe the visible contents, relevant text and relationships clearly. Do not guess the identity, provenance or meaning of things the pixels do not establish.');
  const inspectionId=imageInspectionId(id,request);
  return {source,observedAt:new Date().toISOString(),...await recoverInspection(inspectionId,request,visualObservation,inspectionServices),instructionAuthority:false};
}
export async function generateImage(id:string,prompt:string,identityId?:number) {
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>3000)throw new ConfirmedFailure('invalid_image_prompt');
  if(identityId!==undefined){try{nftIdentity(identityId);}catch{throw new ConfirmedFailure('invalid_nft_identity');}}
  const c=await configuration();if(!c.policy.capabilities.images)throw new ConfirmedFailure('image_generation_disabled');
  let identity:NftImageReference|undefined;
  if(identityId!==undefined){try{identity=await loadNftImage(identityId);}catch{throw new ConfirmedFailure('nft_reference_unavailable');}}
  const request={prompt,...(identityId===undefined?{}:{identityId})};
  const result=await once(id,'image',request,async()=>{
    const r=await fetch(`${process.env.INFERENCE_URL}/api/images`,{method:'POST',headers:{Authorization:`Bearer ${process.env.INFERENCE_SECRET}`,'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(270000)});
    const j=await r.json();if(!r.ok){if(j.payment==='not_signed')throw new ConfirmedFailure('image_request_not_signed');throw Error('image_request_requires_reconciliation');}
    return prepareGeneratedResult(j);
  });
  const image=checkedImage(result);
  const review=await reviewGeneratedImage(id,`data:${image.mime};base64,${image.base64}`,prompt,identity);
  return {imageId:id,sha256:image.sha256,review,...(identity?{reference:{id:identity.id,name:identity.name,sha256:identity.sha256,url:identity.url}}:{}),private:true,published:false};
}
export async function mediaForX(imageId:string|undefined) {
  if(imageId===undefined)return undefined;
  const c=await configuration();if(!c.policy.capabilities.images)throw new ConfirmedFailure('image_generation_disabled');
  const r=await imageRecord(imageId);
  const reviews=await sql()`SELECT id,status,result FROM claus_actions WHERE id IN (${imageId+':review:v2:retry:1'},${imageId+':review:v2'},${imageId+':review'}) AND kind='inference'`;
  if(!storedImageReview(imageId,reviews).approved)throw new ConfirmedFailure('image_review_required');
  const old=r.progress?.xMedia;
  if(old?.id&&Date.parse(old.expiresAt)>Date.now()+60000)return {media_ids:[old.id]};
  // Upload is private. No tweet is submitted until its actual media ID exists.
  // A lost upload response can leave an unused private asset, never a duplicate post.
  let upload:any;
  try {upload=await xRequest('media/upload','POST',{media_category:'tweet_image'},undefined,'image:'+imageId);}catch{throw new ConfirmedFailure('image_upload_unavailable_no_post');}
  if(!/^\d+$/.test(upload.data?.id??'')||!Number.isFinite(upload.data?.expires_after_secs))throw new ConfirmedFailure('image_upload_unavailable_no_post');
  const xMedia={id:upload.data.id,mediaKey:upload.data.media_key,expiresAt:new Date(Date.now()+upload.data.expires_after_secs*1000).toISOString()};
  await sql()`UPDATE claus_actions SET progress=jsonb_build_object('xMedia',${JSON.stringify(xMedia)}::jsonb) WHERE id=${imageId} AND status='completed'`;
  return {media_ids:[xMedia.id]};
}
export async function reconcilePendingImages() {
  for(const a of await unresolved()){
    if(a.kind!=='image')continue;
    try {
      const r=await fetch(`${process.env.INFERENCE_URL}/api/requests/${encodeURIComponent(a.id)}`,{headers:{Authorization:`Bearer ${process.env.INFERENCE_SECRET}`},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(r.status===404&&Date.now()-Date.parse(a.created_at)>300000){await settleAction(a.id,{error:'image_not_reserved',payment:'not_signed'},'failed');continue;}
      if(!r.ok)continue;const j=await r.json();
      if(j.status==='completed'){
        try{await settleAction(a.id,await prepareGeneratedResult(j.response));}
        catch(error){if(error instanceof ConfirmedFailure)await settleAction(a.id,{error:error.message,sourceAvailable:true},'failed');else throw error;}
      }
      else if(j.status==='failed'&&['not_signed','not_settled','settled'].includes(j.outcome?.payment))await settleAction(a.id,{error:'image_generation_failed',payment:j.outcome.payment},'failed');
    }catch{/* Keep an unknown paid result reserved. */}
  }
}
