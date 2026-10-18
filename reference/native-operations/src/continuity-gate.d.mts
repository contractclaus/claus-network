export function continuityEnabled(env?:NodeJS.ProcessEnv):boolean;
export function continuityGate(options:any):<T>(context:{kind:string;originalId?:string|null;input:any},run:()=>Promise<T>)=>Promise<T>;
export function postgresBarriers(databases:Record<string,(query:string,params:any[])=>Promise<any>>):(id:string,epoch:number)=>Promise<string[]>;
export function continuityMiddleware(options:any):(c:any,next:()=>Promise<void>)=>Promise<any>;
