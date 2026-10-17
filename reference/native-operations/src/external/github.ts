import {ProviderFailure} from './providers.js';
export async function githubRequest(input:any){
 const secret=process.env.PUBLISHER_SECRET;if(!secret)throw new ProviderFailure('github_not_connected',true);
 const r=await fetch('https://claus-inference.vercel.app/api/github',{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(input)});
 const text=await r.text();if(Buffer.byteLength(text)>4500000)throw new ProviderFailure('github_response_too_large',false);
 const result=JSON.parse(text);if(!r.ok)throw new ProviderFailure(/^github_[a-z_0-9]+$/.test(result.error)?result.error:'github_outcome_unknown',['status','tree','file','pulls','recover'].includes(input.operation)||[401,403,413].includes(r.status)||['github_input_invalid','github_repository_denied','github_ref_required','github_file_invalid','github_description_invalid','github_source_required','github_id_required','github_not_configured'].includes(result.error));
 return result.result;
}
