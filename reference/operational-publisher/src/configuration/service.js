import {neon} from '@neondatabase/serverless';
import {validateConfiguration,digest} from './validation.js';
export function configurationService(db=neon(process.env.NATIVE_CONFIGURATION_DATABASE_URL)){
 return {
  async read(revision){
   if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw Error('configuration_invalid_revision');
   const rows=revision===undefined?await db`SELECT revision,hash,content FROM claus_config ORDER BY revision DESC LIMIT 1`:await db`SELECT revision,hash,content FROM claus_config WHERE revision=${revision}`;
   if(!rows[0])throw Error('configuration_not_found');return rows[0];
  },
  async update(body){
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['configuration','expectedRevision'].includes(key)))throw Error('configuration_invalid_request');
   const {configuration,expectedRevision}=body;
   if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw Error('configuration_invalid_revision');
   try{validateConfiguration(configuration);}catch{throw Error('configuration_invalid');}const hash=digest(configuration);
   const rows=await db`WITH current AS (SELECT revision,hash,parent_revision FROM claus_config ORDER BY revision DESC LIMIT 1),
    inserted AS (INSERT INTO claus_config(parent_revision,content,hash)
     SELECT ${expectedRevision},${JSON.stringify(configuration)}::jsonb,${hash}
     WHERE (SELECT revision FROM current)=${expectedRevision} AND (SELECT hash FROM current)<>${hash}
     ON CONFLICT(parent_revision) DO NOTHING RETURNING revision,hash),
    recorded AS (INSERT INTO claus_journal(kind,summary,data)
     SELECT 'configuration','Owner configuration updated',jsonb_build_object('revision',revision,'custodian','fixed-configuration') FROM inserted RETURNING id)
    SELECT revision,hash,false AS unchanged FROM inserted
    UNION ALL SELECT revision,hash,true AS unchanged FROM current WHERE hash=${hash} AND (revision=${expectedRevision} OR parent_revision=${expectedRevision})`;
   if(!rows[0])throw Error('configuration_conflict');return rows[0];
  }
 };
}
