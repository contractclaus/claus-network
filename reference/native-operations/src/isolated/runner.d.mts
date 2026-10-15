export function validateProgram(program:unknown):string;
export function programHash(program:unknown):string;
export function runAnalysis(program:unknown,input:{kind:string;observedAt:number;subjects:{id:string;[key:string]:unknown}[]}):Promise<{subject:string;priority:'info'|'attention';message:string}[]>;
export function analyzeProjection(program:unknown,input:{kind:string;observedAt:number;subjects:{id:string;[key:string]:unknown}[]}):Promise<any>;
