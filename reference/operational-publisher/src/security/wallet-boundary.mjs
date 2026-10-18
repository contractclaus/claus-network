// Generic Dev-wallet authority was revoked. Fixed-purpose custody services
// remain separate; a role/configuration change cannot reopen these routes.
export function revokedWalletMutation(method,path){
 let decoded;try{decoded=decodeURIComponent(path);}catch{return false;}
 return method==='POST'&&/^\/api\/wallet\/(?:prepare|execute|replace|sign)\/?$/.test(decoded);
}
