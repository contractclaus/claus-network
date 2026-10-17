// Connections, a tool grant and working provider credentials are separate facts.
export function externalAccessState(configuration:any,connections:any){
 const known=Array.isArray(connections?.items),items=known?connections.items:[];
 const names=[...new Set<string>([...(configuration.composio?.connectToolkits??[]),...(configuration.composio?.readToolkits??[])])];
 return {observedAt:new Date().toISOString(),accountsComplete:known&&!connections.nextCursor,
  tools:names.map(toolkit=>{const rows=items.filter((a:any)=>a.toolkit===toolkit),active=rows.filter((a:any)=>a.status==='ACTIVE');
   const dedicated=toolkit==='github'&&configuration.github?.configured;
   return {toolkit,state:dedicated?'dedicated_access':!known?'unknown':active.length===1?'connected':active.length>1?'selection_required':connections.nextCursor?'incomplete_inventory':rows.length?'reconnect_required':'owner_login_required',accountIds:rows.map((a:any)=>a.id),route:dedicated?'external_tools provider=github':active.length===1?'canonical read tools; writes still require an explicit grant':null,next:dedicated?'Use the existing custody-backed GitHub broker; do not require a duplicate OAuth account.':!known||connections.nextCursor?'Finish reading original account status before creating a connection.':active.length?'Use the original active account and current tool scope.':'The account owner must complete the provider login; never invent or silently substitute an identity.'};}),
  browser:{configured:configuration.browser?.configured===true,scope:'Persisted browser context and allowed origins; this does not grant every website account.'},
  paid:{configured:configuration.paidServices?.configured===true,scope:'Existing approved services and budget only; catalog listings are not spending authority.'},
  authorityChanged:false};
}
