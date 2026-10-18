import {runtimeExport} from '../lib/runtime-export.mjs';
export default async function handler(req,res){
 if(req.method!=='GET'){res.statusCode=405;res.setHeader('allow','GET');res.end();return;}
 const out=runtimeExport(req.headers.authorization);res.statusCode=out.status;for(const [k,v] of out.headers)res.setHeader(k,v);res.end(Buffer.from(await out.arrayBuffer()));
}
