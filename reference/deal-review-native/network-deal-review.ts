// The shared validator is copied byte-for-byte from the canonical network source.
// @ts-expect-error Shared runtime module has its own checked JSON boundary.
import {validateDealDecision,dealDecisionRequest,DEAL_REVIEW_PROFILE} from './network-deal-core/src/deals/decision.mjs';
// @ts-expect-error Shared runtime crypto adapter is copied exactly from source.
import {verifyDealOracle} from './network-deal-core/adapters/deal-oracle-proof.mjs';
export const isDealReview=(input:any)=>input?.profile===DEAL_REVIEW_PROFILE;
export const reviewCapability=(input:any)=>isDealReview(input)?'networkDealReview':'networkReview';
function pins(){let p;try{p=JSON.parse(process.env.CLAUS_DEAL_PINS??'[]');}catch{throw Error('network_review_disabled');}if(!Array.isArray(p)||p.length>4)throw Error('network_review_disabled');return p;}
export async function validateNativeDealReview(input:any){try{return await validateDealDecision(input,pins(),Date.now(),{verifyOracle:verifyDealOracle});}catch{throw Error('network_review_invalid_input');}}
export const nativeDealReviewRequest=(input:any,config:any)=>dealDecisionRequest(input,config,pins());
