import {createR2Objects} from '../adapters/r2-objects.mjs';
import {DATA_LIMITS} from '../src/data-files/index.mjs';
export async function dataObjects(env=process.env){
 const names=['CLAUS_R2_ACCOUNT_ID','CLAUS_R2_BUCKET','CLAUS_R2_ACCESS_KEY_ID','CLAUS_R2_SECRET_ACCESS_KEY'],v=names.map(n=>env[n]);
 if(v.every(x=>!x))return null;if(v.some(x=>!x))throw Error('data_storage_unconfigured');
 return createR2Objects({accountId:v[0],bucket:v[1],accessKeyId:v[2],secretAccessKey:v[3],maxBytes:DATA_LIMITS.fileBytes,timeoutMs:30000,uploads:true});
}
