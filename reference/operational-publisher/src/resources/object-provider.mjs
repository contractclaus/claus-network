import * as S from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
const fail=c=>{throw Error('resource_storage_'+c);};
const absent=e=>e?.$metadata?.httpStatusCode===404||['NoSuchBucket','NoSuchKey','NotFound','NoSuchUpload'].includes(e?.name);
export function objectProvider({environment=process.env,client}={}){
 const configured=()=>/^[a-f0-9]{32}$/.test(environment.RESOURCE_R2_ACCOUNT_ID??'')&&!!environment.RESOURCE_R2_ACCESS_KEY&&!!environment.RESOURCE_R2_SECRET_KEY;
 const storage=()=>{if(!configured()&&!client)fail('not_connected');return client??=new S.S3Client({region:'auto',endpoint:'https://'+environment.RESOURCE_R2_ACCOUNT_ID+'.r2.cloudflarestorage.com',credentials:{accessKeyId:environment.RESOURCE_R2_ACCESS_KEY,secretAccessKey:environment.RESOURCE_R2_SECRET_KEY},maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});};
 const bucket=b=>{if(!/^claus-owned-[a-f0-9]{24}$/.test(b))fail('bucket_scope_invalid');return b;};
 const key=k=>{if(!/^objects\/obj_[a-f0-9]{24}$/.test(k))fail('object_scope_invalid');return k;};
 async function send(Command,args,{missing=false,signal}={}){try{return await storage().send(new Command({...args,...(args.Bucket?{Bucket:bucket(args.Bucket)}:{}),...(args.Key?{Key:key(args.Key)}:{})}),{abortSignal:signal??AbortSignal.timeout(30000)});}catch(e){if(missing&&absent(e))return null;const error=Error('resource_storage_provider_'+(e?.$metadata?.httpStatusCode??'unavailable'));error.status=e?.$metadata?.httpStatusCode;throw error;}}
 return {
  configured,
  async bucket(name){const result=await send(S.HeadBucketCommand,{Bucket:name},{missing:true});if(!result)return null;const life=await send(S.GetBucketLifecycleConfigurationCommand,{Bucket:name},{missing:true});return {name,rules:life?.Rules??[]};},
  async createBucket(name){await send(S.CreateBucketCommand,{Bucket:name});return {name};},
  async lifecycle(name,days){await send(S.PutBucketLifecycleConfigurationCommand,{Bucket:name,LifecycleConfiguration:{Rules:[{ID:'claus-owned-retention',Status:'Enabled',Filter:{Prefix:'objects/'},Expiration:{Days:days},AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}}]}});},
  async head(Bucket,Key){const r=await send(S.HeadObjectCommand,{Bucket,Key},{missing:true});return r?{bytes:r.ContentLength,etag:r.ETag,metadata:r.Metadata,modifiedAt:r.LastModified?.toISOString()}:null;},
  async uploads(Bucket,Key){let marker,uploadMarker;const matches=[];do{const p=await send(S.ListMultipartUploadsCommand,{Bucket,Prefix:key(Key),KeyMarker:marker,UploadIdMarker:uploadMarker,MaxUploads:1000});matches.push(...(p.Uploads??[]).filter(u=>u.Key===Key).map(u=>u.UploadId));if(!p.IsTruncated)break;marker=p.NextKeyMarker;uploadMarker=p.NextUploadIdMarker;}while(marker);if(matches.length>1)fail('multiple_original_uploads');return matches[0]??null;},
  async begin(Bucket,Key,metadata){return (await send(S.CreateMultipartUploadCommand,{Bucket,Key,Metadata:metadata,ContentType:'application/octet-stream',CacheControl:'private, no-store'})).UploadId;},
  async parts(Bucket,Key,UploadId,marker=0){const r=await send(S.ListPartsCommand,{Bucket,Key,UploadId,PartNumberMarker:marker,MaxParts:1000},{missing:true});return r?{items:(r.Parts??[]).map(p=>({number:p.PartNumber,bytes:p.Size,etag:p.ETag})),next:r.IsTruncated?r.NextPartNumberMarker:null}:null;},
  async upload(Bucket,Key,UploadId,PartNumber,bytes){const command=new S.UploadPartCommand({Bucket:bucket(Bucket),Key:key(Key),UploadId,PartNumber,ContentLength:bytes});const url=await getSignedUrl(storage(),command,{expiresIn:900,signableHeaders:new Set(['content-length'])});if(!new URL(url).searchParams.get('X-Amz-SignedHeaders')?.split(';').includes('content-length'))fail('unsigned_size');return {url,method:'PUT',headers:{'content-length':String(bytes)},expiresAt:Date.now()+900000};},
  async complete(Bucket,Key,UploadId,parts){return send(S.CompleteMultipartUploadCommand,{Bucket,Key,UploadId,MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.number,ETag:p.etag}))}});},
  async range(Bucket,Key,etag,start,end,signal){const r=await send(S.GetObjectCommand,{Bucket,Key,IfMatch:etag,Range:'bytes='+start+'-'+end},{signal});if(r.ContentRange!=='bytes '+start+'-'+end+'/'+(end+1)&&!r.ContentRange?.startsWith('bytes '+start+'-'+end+'/'))fail('range_mismatch');return r;},
  async download(Bucket,Key,etag){return {url:await getSignedUrl(storage(),new S.GetObjectCommand({Bucket:bucket(Bucket),Key:key(Key),IfMatch:etag,ResponseContentType:'application/octet-stream',ResponseCacheControl:'private, no-store'}),{expiresIn:900}),method:'GET',headers:{'if-match':etag},expiresAt:Date.now()+900000};},
  async remove(Bucket,Key,UploadId){if(UploadId)await send(S.AbortMultipartUploadCommand,{Bucket,Key,UploadId},{missing:true});await send(S.DeleteObjectCommand,{Bucket,Key});return {removed:!await this.head(Bucket,Key)};},
  async removeBucket(Bucket){const contents=await send(S.ListObjectsV2Command,{Bucket,MaxKeys:1},{missing:true});if(!contents)return {removed:true};if((contents.KeyCount??contents.Contents?.length??0)>0)fail('bucket_not_empty');const uploads=await send(S.ListMultipartUploadsCommand,{Bucket,MaxUploads:1});if(uploads.Uploads?.length)fail('bucket_uploads_pending');await send(S.DeleteBucketCommand,{Bucket});return {removed:true};}
 };
}
