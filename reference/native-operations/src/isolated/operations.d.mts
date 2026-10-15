export const PROGRAM_READS: readonly string[];
export const PROGRAM_WRITES: readonly string[];
export function bindProgramOperation(value:any,options:any):any;
export function runNetworkProgram(options:any):Promise<any>;
export function isolateProgramActions(actions:any[]):{held:any[];blocking:any[]};
export function reconcileProgramActions(actions:any[],resume:(args:{id:string})=>Promise<any>):Promise<any[]>;
