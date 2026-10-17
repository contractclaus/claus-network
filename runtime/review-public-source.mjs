import {digest,requireThat} from '../src/shared/index.mjs';
import {boundedResponse} from '../adapters/imd.mjs';

// The review host reads only explicitly published snapshots. Storage credentials
// stay with the API; immutable hashes bind the response to the original case.
export async function loadReviewSource(projectId,snapshotId,{request=fetch}={}){
 const id=digest({projectId,id:snapshotId});
 const response=await request('https://claus-network-api.vercel.app/v1/public/sources/'+encodeURIComponent(id),{redirect:'error',signal:AbortSignal.timeout(15000)});
 requireThat(response.ok,'source_unavailable');
 const payload=JSON.parse(await boundedResponse(response,24000000)),value=payload.result??payload;
 requireThat(value.projectId===projectId&&value.snapshotId===snapshotId&&Array.isArray(value.files)&&value.files.length<=256,'source_mismatch');
 requireThat(value.files.every(f=>typeof f.path==='string'&&typeof f.content==='string'&&digest({path:f.path,content:f.content})===f.hash),'source_mismatch');
 requireThat(digest(value.files.map(({path,hash})=>({path,hash})))===snapshotId,'source_mismatch');
 return value.files;
}
