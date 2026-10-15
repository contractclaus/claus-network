export const receiptRoute:any;
export function appReceiptInput(operation:string,input:any):any;
export function readOriginalAppResult(call:(operation:string,input:any)=>Promise<any>,operation:string,input:any):Promise<any>;
