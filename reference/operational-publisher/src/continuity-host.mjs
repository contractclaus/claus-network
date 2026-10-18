import {createHash} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {continuityGate,postgresBarriers,continuityMiddleware} from './continuity-gate.mjs';
const bindings={"signer":"DATABASE_URL","website":"WEBSITE_DATABASE_URL","agent":"NATIVE_CONFIGURATION_DATABASE_URL","applications":"RESOURCE_DATABASE_URL"};
export function hostContinuity(kind,originalId,input,run){const databases=Object.fromEntries(Object.entries(bindings).filter(([,key])=>process.env[key]).map(([name,key])=>[name,(sql,params)=>neon(process.env[key]).query(sql,params)]));return continuityGate({component:'custody',writeBarriers:postgresBarriers(databases)})({kind,originalId,input},run);}
export const hostMiddleware=mutating=>continuityMiddleware({mutating,gate:(context,run)=>hostContinuity(context.kind,context.originalId,context.input,run)});
export async function responseRecord(response){const bytes=Buffer.from(await response.clone().arrayBuffer());return {status:response.status,responseSha256:createHash('sha256').update(bytes).digest('hex'),contentType:response.headers.get('content-type'),...(bytes.length<=1000000?{body:bytes.toString('base64'),encoding:'base64'}:{bytes:bytes.length,responseOmitted:true})};}
