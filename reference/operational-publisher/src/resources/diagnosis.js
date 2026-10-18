const code=v=>typeof v==='string'&&/^[a-z][a-z0-9_:-]{0,150}$/.test(v)?v:null;
export function diagnose({error,httpStatus,state}={}){
 error=code(error);httpStatus=Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?httpStatus:null;
 let category='unclassified',basis='insufficient_evidence',explanation='No specific failure is established by the retained metadata.';
 if(error==='oci_build_capacity_reached'){category='provider-capacity';basis='explicit_admission_code';explanation='The build scheduler refused admission because its available build lanes were occupied.';}
 else if(error&&/^(?:capital_(?:insufficient|budget|capacity|reserve|cash)|operating_budget_|credit_(?:balance|fund|cost)|(?:insufficient|missing)_(?:funds|credit)|quoted_reservation_unavailable|.*(?:budget_exhausted|budget_exceeded|funding_required))/.test(error)){category='budget-or-funding';basis='explicit_admission_code';explanation='The recorded budget, credit or funding admission condition was not satisfied.';}
 else if(error&&/(?:^|_)(?:scope_denied|grant_inactive|unauthorized|permission_denied|credential_binding_mismatch|credential_unavailable|secret_inactive|auth_invalid)(?:$|_)/.test(error)){category='access';basis='explicit_access_code';explanation='The recorded permission or credential condition was not satisfied.';}
 else if(error&&/(?:no_healthy_sellers|rate_limit_exceeded|quota_exceeded|capacity_reached)/.test(error)){category='provider-capacity';basis='explicit_provider_code';explanation='The provider recorded a capacity, quota or rate-limit refusal.';}
 else if(error&&/(?:schema|syntax|arguments_invalid|response_invalid|response_normalization|invalid_source_json|mismatch|build_failed)/.test(error)){category='input-or-code';basis='explicit_validation_code';explanation='The recorded input, build or response validation failed.';}
 else if(httpStatus===401||httpStatus===403){category='access';basis='recorded_http_status';explanation='The responding service rejected authentication or access; the deeper reason is not recorded here.';}
 else if(httpStatus===402){category='budget-or-funding';basis='recorded_http_status';explanation='The responding service required payment or funding; this does not establish whether an earlier payment settled.';}
 else if(httpStatus===429){category='provider-capacity';basis='recorded_http_status';explanation='The responding service applied a rate or capacity limit; a specific internal cause requires its retained error code.';}
 else if(error&&/(?:timeout|transport|socket|unknown|uncertain|unreadable|unfinished|not_received)/.test(error)||['uncertain','unknown','outcome_unknown'].includes(state)){category='transport-or-unresolved';basis='unresolved_outcome';explanation='The original outcome is unresolved. Preserve the original ID and hold; do not repeat the paid action.';}
 else if(httpStatus&&httpStatus>=500){category='provider-service';basis='recorded_http_status';explanation='The responding service reported a server error. Its internal root cause is not established.';}
 return {error,httpStatus,category,basis,explanation,financialDecision:false};
}
