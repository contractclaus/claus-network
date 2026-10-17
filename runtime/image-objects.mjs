import {createR2Objects} from '../adapters/r2-objects.mjs';
import {createImageArchive,MAX_IMAGE_BYTES} from '../src/infrastructure/image-archive.mjs';

export async function imageArchive(env=process.env){
 const [accountId,bucket,accessKeyId,secretAccessKey]=['CLAUS_R2_ACCOUNT_ID','CLAUS_R2_BUCKET','CLAUS_R2_ACCESS_KEY_ID','CLAUS_R2_SECRET_ACCESS_KEY'].map(k=>env[k]);
 if(![accountId,bucket,accessKeyId,secretAccessKey].some(Boolean))return createImageArchive({objects:null});
 if(![accountId,bucket,accessKeyId,secretAccessKey].every(Boolean))throw Error('r2_configuration_incomplete');
 return createImageArchive({objects:await createR2Objects({accountId,bucket,accessKeyId,secretAccessKey,maxBytes:MAX_IMAGE_BYTES,timeoutMs:15000})});
}
