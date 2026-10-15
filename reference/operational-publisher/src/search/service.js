import {searchRequest,SearchError} from './policy.js';
import {createSearchProvider} from './provider.js';
export function createSearch({repository,provider=createSearchProvider()}){
 return {
  status:()=>repository.status(),
  async search(input){
   const request=searchRequest(input);
   await repository.reserve(request);
   let result;
   try{result=await provider(request);}
   catch(e){await repository.finish(request.id,'failed').catch(()=>{});throw e instanceof SearchError?e:new SearchError('search_provider_unavailable');}
   // A missing completion acknowledgement must never trigger another provider request.
   await repository.finish(request.id,'completed').catch(()=>{});
   return result;
  }
 };
}
