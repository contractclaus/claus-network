import {createR2Objects} from '../adapters/r2-objects.mjs';
import {SITE_LIMITS} from '../src/shared/index.mjs';

export async function sourceObjects(env = process.env) {
  const values = [env.CLAUS_R2_ACCOUNT_ID, env.CLAUS_R2_BUCKET,
    env.CLAUS_R2_ACCESS_KEY_ID, env.CLAUS_R2_SECRET_ACCESS_KEY];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) throw Error('source_storage_unconfigured');
  const [accountId, bucket, accessKeyId, secretAccessKey] = values;
  return createR2Objects({accountId, bucket, accessKeyId, secretAccessKey,
    maxBytes:SITE_LIMITS.fileBytes, timeoutMs:6000});
}
