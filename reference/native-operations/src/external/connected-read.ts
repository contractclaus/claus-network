import {providerJson,ProviderFailure,type ExternalPolicy} from './providers.js';
// Account owners still perform OAuth. Only the provider's canonical read-only
// catalogue is eligible; web pages and model-supplied annotations cannot grant it.
export async function connectedReadPolicy(policy:ExternalPolicy,slug:string,request:typeof fetch=fetch):Promise<ExternalPolicy>{
 if(policy.composio?.tools[slug])return policy;
 const scope=policy.composio;
 if(!scope||!scope.readToolkits?.length||!process.env.COMPOSIO_API_KEY||typeof slug!=='string'||!/^([A-Z][A-Z0-9_]{1,159})$/.test(slug)||/^(COMPOSIO_)|(?:SECRET|PASSWORD|CREDENTIAL|TOKEN|API_KEY|PRIVATE_KEY|EXECUTE|SCRIPT|EVAL|PAYMENT|BILLING)/.test(slug))throw new ProviderFailure('external_tool_not_authorized',true);
 const headers={'x-api-key':process.env.COMPOSIO_API_KEY};
 const definition=await providerJson('https://backend.composio.dev/api/v3.1/tools/'+encodeURIComponent(slug),{headers},true,request);
 const toolkit=definition.toolkit?.slug;
 if(definition.slug!==slug||!scope.readToolkits.includes(toolkit)||!definition.tags?.includes('readOnlyHint')||definition.tags.includes('destructiveHint')||definition.is_deprecated)throw new ProviderFailure('external_tool_not_authorized',true);
 const params=new URLSearchParams({user_ids:scope.userId,toolkit_slugs:toolkit,statuses:'ACTIVE',limit:'50'});
 const result=await providerJson('https://backend.composio.dev/api/v3.1/connected_accounts?'+params,{headers},true,request);
 const accounts=(result.items??[]).filter((a:any)=>a.status==='ACTIVE'&&(a.toolkit?.slug??a.toolkit)===toolkit&&(!a.user_id||a.user_id===scope.userId));
 if(result.next_cursor||accounts.length>1)throw new ProviderFailure('external_account_selection_required',true);
 if(accounts.length!==1)throw new ProviderFailure('external_account_login_required',true);
 return {...policy,composio:{...scope,tools:{...scope.tools,[slug]:{toolkit,account:accounts[0].id,effect:'read'}}}};
}
