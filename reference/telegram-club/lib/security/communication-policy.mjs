// Conversation is not a financial execution channel. This deterministic guard
// supplements scoped signers; it does not try to prove arbitrary text safe.
export function normalizedCommunication(value) {
 let text=String(value??'');
 for(let i=0;i<2;i++) {
  text=text.replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi,(all,hex,dec)=>{const n=parseInt(hex??dec,hex?16:10);return n<=0x10ffff?String.fromCodePoint(n):all;});
  try{text=decodeURIComponent(text);}catch{}
 }
 return text.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu,'').toLowerCase();
}
export function executionAccount(value) {
 const name=normalizedCommunication(value).replace(/[^a-z0-9_]/g,'');
 // The official Club access bot is a first-party membership link, not a signer.
 if(name==='contractclausbot')return false;
 return /^(?:bankr|clanker)(?:bot|_bot|agent|_agent)?$/.test(name)||/bot$/.test(name);
}
function handles(text) {
 return [...text.matchAll(/@\s*[~*`]*\s*([a-z0-9_]{1,64})|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/([a-z0-9_]{1,64})/g)].map(m=>m[1]??m[2]);
}
export function outgoingActionRisk(value,{reply=false,recipient,participants=[]}={}) {
 const text=normalizedCommunication(value),named=handles(text);
 if([recipient,...participants,...named].some(x=>x&&executionAccount(x)))return 'social_execution_account_forbidden';
 if(/\b(?:ethereum|solana|wc):|\btg:\/\/[^\s]*(?:start|send|text)=|\b(?:eth_sendtransaction|eth_signtypeddata(?:_v4)?|personal_sign|wallet_sendcalls)\b/.test(text))return 'social_wallet_payload_forbidden';
 if(/(?:x\.com|twitter\.com)\/(?:intent|share)\b[^\s]*(?:text|url)=/.test(text))return 'social_execution_link_forbidden';
 const action=/\b(?:launch|deploy|create|mint|issue|launche|erstell\w*)\b[\s\S]{0,100}\b(?:coin|token|ticker|contract|nft|meme)\b|\b(?:send|transfer|pay|tip|withdraw|bridge|swap|buy|sell|sende|senden|überweis\w*|kaufe|verkaufe)\b[\s\S]{0,100}(?:\b(?:eth|usdc|usdt|btc|sol|claus|coin|token|funds|money|balance|wallet|him|her|geld|ihn|ihm|sie)\b|0x[a-f0-9]{40}|\$\s*\d)|\b(?:approve|permit2?|setapprovalforall|sign|signier\w*)\b[\s\S]{0,100}\b(?:transaction|typed.?data|permit|allowance|spender|wallet|message|signature|vertrag)\b|\b(?:fees?|royalties|proceeds)\s+(?:go\s+)?to\b/.test(text);
 const addressed=named.length>0;
 const opening=text.replace(/^[\s\p{P}]+/u,'').replace(/^(?:(?:hey|please|ok(?:ay)?|yes|then|now|bitte)[\s,]+)+/u,'');
 const command=/^(?:launch|deploy|create|mint|issue|send|transfer|pay|tip|withdraw|bridge|swap|buy|sell|approve|permit|sign|sende|kaufe|verkaufe)\b/u.test(opening);
 const payment=/\b(?:send|transfer|pay|tip|withdraw)\b[\s\S]{0,80}(?:\$\s*\d|\d+(?:\.\d+)?\s*(?:eth|usdc|usdt|btc|sol|claus)\b)|\b(?:fees?|royalties|proceeds)\s+(?:go\s+)?to\s+(?:him|her|me|you|0x|@)|\b(?:approve|permit)\b[\s\S]{0,60}\b(?:unlimited|infinite|max|spender)\b/.test(text);
 if(action&&(addressed||reply&&command)||payment&&(addressed||command))return 'social_execution_command_forbidden';
 if((addressed||reply)&&/\b(?:approve|permit2?|sign|setapprovalforall)\b[\s\S]{0,80}0x[a-f0-9]{40,}/.test(text))return 'social_wallet_payload_forbidden';
 if(addressed&&/0x[a-f0-9]{130,}|\b(?:fees?|royalties)\b[\s\S]{0,80}@/.test(text))return 'social_wallet_payload_forbidden';
 return null;
}
export function assertConversationOnly(text,context) {
 const reason=outgoingActionRisk(text,context);
 if(reason)throw Object.assign(Error(reason),{definite:true,status:409});
}
