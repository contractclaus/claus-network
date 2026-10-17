export const BUILD_LIMITS=Object.freeze({modelReservation:'2000000',modelBudget:'6000000',dailyModelBudget:'14000000',modelRequests:3,testRuns:3,dailyTestRuns:6,seconds:90,sandboxSeconds:130,files:24,bytes:100000,stdoutBytes:14000,stderrBytes:4000,versions:12});

// Claus is funded by the custody payer; public member entitlements are separate.
export function buildAllowances(scope:string){return scope==='claus'?{...BUILD_LIMITS,modelBudget:null,dailyModelBudget:null,modelRequests:null,testRuns:null,dailyTestRuns:null,versions:null}:BUILD_LIMITS;}
