import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabDatabase,LabQuery} from '../lab-db.js';
import {hash} from '../lab-schema.js';
import {buildFiles,buildHash,type BuildFile,type BuildRuntime} from '../builder-schema.js';
import {solidityResult} from '../builder-solidity.js';
import {SOLIDITY_PIN} from '../builder-toolchain.js';
import {packageLicense} from './package-license.js';

export const PACKAGE_LICENSES=['MIT','Apache-2.0','GPL-3.0-only','GPL-3.0-or-later'] as const;
export type PackageLicense=typeof PACKAGE_LICENSES[number];
export type PackagePublisher={username:string};
export type PackagePreviewInput={id:string;revision:number;title:string;description:string;license:PackageLicense};
export type PackagePublishInput=PackagePreviewInput&{expectedManifestHash:string;consent:'public-package-v1'};
export type PackageToolchain=Record<string,string|number>;
export type PackageLicenseDocument=ReturnType<typeof packageLicense>;
export type PackageManifest={
 schemaVersion:1;kind:'claus-public-package';id:string;title:string;description:string;license:PackageLicense;
 author:PackagePublisher;
 source:{revision:number;hash:string;runtime:BuildRuntime;files:{path:string;sha256:string;bytes:number}[]};
 distribution:{licenseDocuments:Omit<PackageLicenseDocument,'content'>[]};
 test:{checksPassed:true;tests:number;failed:0;skipped:0;receiptHash:string;recordedAt:string;timestampKind:'test_requested_at';toolchain?:PackageToolchain};
 review:{status:'not_reviewed'|'needs_changes'|'reviewed'|'declined';recordedAt:string;receiptHash?:string;reviewer?:'CLAUS'};
 securityAudit:false;productionReady:false;
};
export type PublishedPackage={id:string;status:'published';manifest:PackageManifest;manifestHash:string;publishedAt:string;withdrawnAt:null;files?:BuildFile[];licenseDocuments?:PackageLicenseDocument[]};
export type WithdrawnPackage={id:string;status:'withdrawn';withdrawnAt:string};
export type PublicPackage=PublishedPackage|WithdrawnPackage;
export type OwnedPackage={id:string;status:'published'|'withdrawn';manifest:PackageManifest;manifestHash:string;publishedAt:string;withdrawnAt:string|null};

const fail=(reason:string):never=>{throw Error('package_'+reason);};
const record=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=(v:unknown)=>{const d=new Date(v as string);if(!Number.isFinite(d.getTime()))return fail('evidence_invalid');return d.toISOString();};
const scopeCheck=(scope:string)=>{if(!/^member:0x[0-9a-f]{40}$/.test(scope))fail('owner_invalid');};
const projectCheck=(id:string)=>{if(typeof id!=='string'||!/^build_[a-f0-9]{24}$/.test(id))fail('project_invalid');};
const packageCheck=(id:string)=>{if(typeof id!=='string'||!/^pkg_[a-f0-9]{24}$/.test(id))fail('id_invalid');};
function keys(value:unknown,allowed:string[]){
 if(!record(value)||Object.keys(value).length!==allowed.length||allowed.some(k=>!Object.hasOwn(value,k)))fail('input_invalid');
}
function publicText(value:unknown,max:number):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)||
 /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))return fail('text_invalid');
 credentials(value);return value.trim();
}
// A conservative prepublication block, not a claim to detect every secret.
function credentials(value:string){
 if(/ccbuild_[a-f0-9]{64}/i.test(value)||/-----BEGIN [^-]*PRIVATE KEY|\bBearer\s+[A-Za-z0-9_.-]{16,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,})\b/i.test(value)||
 /\b(?:api[_-]?key|private[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|mnemonic|seed[_-]?phrase|recovery[_-]?phrase)["']?\s*[:=]\s*\S+/i.test(value)||
 /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|https?):\/\/[^\s/]+:[^\s/@]+@/i.test(value)||
 /[?&](?:token|secret|api[_-]?key|password|signature)=[^\s&#]+/i.test(value))fail('credentials_refused');
}
function publicStrings(value:unknown){
 if(typeof value==='string')credentials(value);
 else if(Array.isArray(value))value.forEach(publicStrings);
 else if(record(value))for(const [key,item] of Object.entries(value)){credentials(key);publicStrings(item);}
}
function inputCheck(input:PackagePreviewInput|PackagePublishInput,publish=false){
 keys(input,['id','revision','title','description','license',...(publish?['expectedManifestHash','consent']:[])]);
 projectCheck(input.id);
 if(!Number.isSafeInteger(input.revision)||input.revision<1)fail('revision_invalid');
 if(!PACKAGE_LICENSES.includes(input.license))fail('license_invalid');
 const clean={id:input.id,revision:input.revision,title:publicText(input.title,80),description:publicText(input.description,500),license:input.license};
 if(publish&&((input as PackagePublishInput).consent!=='public-package-v1'||!digest((input as PackagePublishInput).expectedManifestHash)))fail('consent_invalid');
 return clean;
}
function publisherCheck(publisher:PackagePublisher){
 keys(publisher,['username']);
 if(typeof publisher.username!=='string'||! /^[A-Za-z0-9_]{1,15}$/.test(publisher.username))fail('publisher_invalid');
 return {username:publisher.username};
}
function sourceFiles(value:unknown,runtime:BuildRuntime,license:PackageLicense){
 publicStrings(value);
 let files:BuildFile[];
 try{files=buildFiles(value,runtime);}catch{ return fail('source_invalid'); }
 // Retain original notices and exact UTF-8 bytes, without adding license text
 // to the tested source tree.
 for(const f of files){
  publicText(f.content,60000);
  if(f.path.split('/').some(p=>/^(?:node_modules|vendor|dependencies)$/i.test(p)))fail('dependencies_refused');
  for(const match of f.content.matchAll(/SPDX-License-Identifier\s*:\s*([^\r\n]*)/gi)){
   const declared=match[1]!.replace(/\s*(?:\*\/|-->)\s*$/,'').trim();
   if(declared!==license)fail('license_conflict');
  }
  if(['package.json','module.json'].includes(f.path)){
   let metadata:any;try{metadata=JSON.parse(f.content);}catch{return fail('source_invalid');}
   if(record(metadata)&&Object.hasOwn(metadata,'license')&&metadata.license!==license)fail('license_conflict');
  }
  if(f.path==='README.md')for(const match of f.content.matchAll(/^\s*(?:[-*]\s+)?(?:\*\*)?License(?:\*\*)?\s*:\s*([^\r\n]+)/gim)){
   const declared=match[1]!.trim().replace(/^(?:\*\*|`)(.*?)(?:\*\*|`)\.?$/,'$1').replace(/\.$/,'');
   if(declared!==license)fail('license_conflict');
  }
 }
 return files;
}
function toolchain(value:unknown):PackageToolchain{
 if(!record(value)||value.schemaVersion!==1) return fail('toolchain_invalid');
 if(Object.entries(SOLIDITY_PIN).some(([key,pin])=>value[key]!==pin))return fail('toolchain_invalid');
 const result:PackageToolchain={schemaVersion:1};
 for(const key of ['foundry','compiler']){
  if(typeof value[key]!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value[key]))fail('toolchain_invalid');
  result[key]=value[key];
 }
 for(const key of ['manifestSha256','forgeSha256','compilerSha256']){
  if(!digest(value[key]))fail('toolchain_invalid');result[key]=value[key];
 }
 for(const key of ['v4CoreCommit','forgeStdCommit','solmateCommit','openzeppelinCommit']){
  if(typeof value[key]!=='string'||! /^[a-f0-9]{40}$/.test(value[key]))fail('toolchain_invalid');result[key]=value[key];
 }
 // No snapshot/session ID, paths, URLs, logs or unknown runner output.
 return result;
}
function publicPackage(row:any,download=false):PublicPackage{
 if(row.withdrawn_at)return {id:row.id,status:'withdrawn',withdrawnAt:date(row.withdrawn_at)};
 return {id:row.id,status:'published',manifest:row.manifest,manifestHash:row.manifest_hash,publishedAt:date(row.published_at),withdrawnAt:null,...(download?{files:row.files,licenseDocuments:row.license_documents}:{})};
}
const packageColumns='id,manifest,manifest_hash,published_at,withdrawn_at';

/** Core authorization is ownership only. The relay MUST supply a freshly
 * authenticated NFT/X browser owner, CSRF/consent and feature-flag checks;
 * models and MCP keys must never call this store's publication mutations.
 * Initialize BuilderStore and ContributionStore before this additive DDL. */
export class PackageStore{
 constructor(readonly db:LabDatabase){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`
 CREATE TABLE IF NOT EXISTS claus_packages(
  id text PRIMARY KEY,project_id text NOT NULL,revision integer NOT NULL,owner_scope text NOT NULL,
  manifest jsonb NOT NULL,manifest_hash text NOT NULL,files jsonb NOT NULL,license_documents jsonb NOT NULL,
  test_receipt jsonb NOT NULL,review_receipt jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),withdrawn_at timestamptz,
  FOREIGN KEY(project_id,revision) REFERENCES claus_build_versions(project_id,revision),UNIQUE(project_id,revision));
 ALTER TABLE claus_packages ADD COLUMN IF NOT EXISTS license_documents jsonb NOT NULL DEFAULT '[]'::jsonb;
 CREATE INDEX IF NOT EXISTS claus_packages_catalogue ON claus_packages(published_at DESC,id) WHERE withdrawn_at IS NULL;
 CREATE INDEX IF NOT EXISTS claus_packages_owner ON claus_packages(owner_scope,project_id);
 CREATE TABLE IF NOT EXISTS claus_package_requests(
  id text PRIMARY KEY,owner_scope text NOT NULL,input_hash text NOT NULL,
  package_id text NOT NULL REFERENCES claus_packages(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE OR REPLACE FUNCTION claus_package_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'package_snapshot_immutable'; END IF;
  IF (to_jsonb(NEW)-'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD)-'withdrawn_at')
   OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
  THEN RAISE EXCEPTION 'package_snapshot_immutable'; END IF;
  RETURN NEW;
 END $guard$;
 DROP TRIGGER IF EXISTS claus_package_snapshot_guard ON claus_packages;
 CREATE TRIGGER claus_package_snapshot_guard BEFORE UPDATE OR DELETE ON claus_packages
  FOR EACH ROW EXECUTE FUNCTION claus_package_snapshot_guard();
 `);}

 private async snapshot(q:LabQuery,scope:string,input:PackagePreviewInput,publisher:PackagePublisher){
  // One statement gives source, receipt and immutable review one MVCC view.
  const row=(await q.query(`SELECT b.runtime,v.files,v.source_hash,v.created_at,
   e.input AS test_input,e.output AS test_output,e.created_at AS test_at,
   c.source_hash AS contribution_hash,c.owner_scope AS contribution_owner,
   r.status AS review_status,r.created_at AS review_at
   FROM claus_builds b JOIN claus_build_versions v ON v.project_id=b.id
   LEFT JOIN LATERAL (SELECT input,output,created_at FROM claus_build_effects
    WHERE project_id=b.id AND revision=v.revision AND kind='test' AND status='completed'
    ORDER BY created_at DESC,id DESC LIMIT 1) e ON true
   LEFT JOIN claus_contributions c ON c.project_id=b.id AND c.revision=v.revision
   LEFT JOIN LATERAL (SELECT status,created_at FROM claus_contribution_reviews
    WHERE contribution_id=c.id ORDER BY created_at DESC,request_id DESC LIMIT 1) r ON true
   WHERE b.id=$1 AND b.owner_scope=$2 AND v.revision=$3`,[input.id,scope,input.revision])).rows[0];
  if(!row)fail('project_missing');
  const runtime:BuildRuntime=row.runtime;if(runtime!=='solidity')fail('runtime_unsupported');
  const files=sourceFiles(row.files,runtime,input.license),sourceHash=buildHash(files);
  if(sourceHash!==row.source_hash)fail('source_hash_mismatch');
  const ti=row.test_input,o=row.test_output;
  if(!record(ti)||!record(o)||ti.sourceHash!==sourceHash||o.sourceHash!==sourceHash||
   (ti.runtime??'javascript')!==runtime||(o.runtime??'javascript')!==runtime||
   o.checksPassed!==true||o.exitCode!==0||!Number.isSafeInteger(o.tests)||o.tests<1||
   o.truncated!==false||o.timedOut!==false||o.outputLimited!==false||
   typeof o.stdout!=='string'||typeof o.stderr!=='string')fail('passed_revision_required');
  let testedFiles:BuildFile[];try{testedFiles=buildFiles(ti.files,runtime);}catch{return fail('evidence_source_mismatch');}
  if(buildHash(testedFiles)!==sourceHash)fail('evidence_source_mismatch');
  // Reparse the actual recorded formats rather than trusting a passing flag.
  const parsed=solidityResult(0,o.stdout,o.stderr);
  if(!parsed.checksPassed||parsed.truncated||parsed.tests!==o.tests||
   o.failed!==0||o.skipped!==0)fail('passed_revision_required');
  let pins:PackageToolchain|undefined;
  if(runtime==='solidity'){
   if(!record(ti.toolchain)||!record(o.toolchain)||hash(ti.toolchain)!==hash(o.toolchain))fail('toolchain_mismatch');
   pins=toolchain(o.toolchain);
  }
  // Builder records reservation time, not a separate completion timestamp.
  const test={checksPassed:true as const,tests:o.tests as number,failed:0 as const,skipped:0 as const,recordedAt:date(row.test_at),timestampKind:'test_requested_at' as const,...(pins?{toolchain:pins}:{})};
  const testReceipt={schemaVersion:1,revision:input.revision,sourceHash,runtime,status:'completed',exitCode:0,
   truncated:false,timedOut:false,outputLimited:false,...test};
  let status:PackageManifest['review']['status']='not_reviewed';
  if(row.contribution_hash&&(row.contribution_hash!==sourceHash||row.contribution_owner!==scope))fail('review_source_mismatch');
  if(row.review_status){
   if(!['needs_changes','reviewed','declined'].includes(row.review_status))fail('review_invalid');status=row.review_status;
  }
  const review={status,recordedAt:date(row.review_at??row.created_at),...(row.review_status?{reviewer:'CLAUS' as const}:{})};
  const reviewReceipt={schemaVersion:1,revision:input.revision,sourceHash,...review};
  const id='pkg_'+hash({kind:'claus-public-package',scope,project:input.id,revision:input.revision}).slice(0,24);
  const licenseDocuments=[packageLicense(input.license)];
  const manifest:PackageManifest={schemaVersion:1,kind:'claus-public-package',id,title:input.title,description:input.description,license:input.license,author:publisher,
   source:{revision:input.revision,hash:sourceHash,runtime,files:files.map(f=>({path:f.path,sha256:hash(f.content),bytes:Buffer.byteLength(f.content)}))},
   distribution:{licenseDocuments:licenseDocuments.map(({content,...metadata})=>metadata)},
   test:{...test,receiptHash:hash(testReceipt)},review:{...review,...(row.review_status?{receiptHash:hash(reviewReceipt)}:{})},securityAudit:false,productionReady:false};
  publicStrings(manifest);publicStrings(licenseDocuments);
  return {manifest,manifestHash:hash(manifest),files,licenseDocuments,testReceipt,reviewReceipt};
 }
 private matches(row:any,input:PackagePreviewInput,publisher:PackagePublisher){
  if(row.manifest.title!==input.title||row.manifest.description!==input.description||row.manifest.license!==input.license||row.manifest.author.username!==publisher.username)fail('revision_already_published');
 }
 async preview(scope:string,input:PackagePreviewInput,publisher:PackagePublisher){
  scopeCheck(scope);input=inputCheck(input);publisher=publisherCheck(publisher);
  const row=(await this.db.query(`SELECT p.manifest,p.manifest_hash,p.files,p.license_documents FROM claus_packages p
   JOIN claus_builds b ON b.id=p.project_id WHERE p.project_id=$1 AND p.revision=$2 AND p.owner_scope=$3 AND b.owner_scope=$3`,[input.id,input.revision,scope])).rows[0];
  if(row){this.matches(row,input,publisher);return {manifest:row.manifest as PackageManifest,manifestHash:row.manifest_hash as string,files:row.files as BuildFile[],licenseDocuments:row.license_documents as PackageLicenseDocument[]};}
  const {manifest,manifestHash,files,licenseDocuments}=await this.snapshot(this.db,scope,input,publisher);return {manifest,manifestHash,files,licenseDocuments};
 }
 private request(requestId:string,scope:string,input:unknown){
  if(typeof requestId!=='string'||! /^[A-Za-z0-9:_-]{1,120}$/.test(requestId))fail('request_invalid');
  return {key:hash({scope,requestId}),inputHash:hash(input)};
 }
 private async replay(q:LabQuery,key:string,inputHash:string,scope:string){
  const r=(await q.query('SELECT input_hash,package_id FROM claus_package_requests WHERE id=$1 AND owner_scope=$2',[key,scope])).rows[0];
  if(!r)return null;if(r.input_hash!==inputHash)fail('request_conflict');
  const p=(await q.query(`SELECT ${packageColumns} FROM claus_packages WHERE id=$1 AND owner_scope=$2`,[r.package_id,scope])).rows[0];
  if(!p)fail('missing');return {package:publicPackage(p)};
 }
 private async receipt(q:LabQuery,key:string,scope:string,inputHash:string,row:any){
  await q.query('INSERT INTO claus_package_requests(id,owner_scope,input_hash,package_id) VALUES($1,$2,$3,$4)',[key,scope,inputHash,row.id]);
  return {package:publicPackage(row)};
 }
 async publish(requestId:string,scope:string,input:PackagePublishInput,publisher:PackagePublisher){
  scopeCheck(scope);const clean=inputCheck(input,true);publisher=publisherCheck(publisher);
  const {key,inputHash}=this.request(requestId,scope,{action:'publish',input,publisher});
  return this.db.transaction(async q=>{
   // Shared database lock covers all owners, caps, requests and withdrawals.
   await q.query('SELECT pg_advisory_xact_lock(6041014)');
   const replay=await this.replay(q,key,inputHash,scope);if(replay)return replay;
   const old=(await q.query('SELECT * FROM claus_packages WHERE project_id=$1 AND revision=$2 AND owner_scope=$3',[clean.id,clean.revision,scope])).rows[0];
   if(old){this.matches(old,clean,publisher);if(old.manifest_hash!==input.expectedManifestHash)fail('manifest_conflict');return this.receipt(q,key,scope,inputHash,old);}
   const snapshot=await this.snapshot(q,scope,clean,publisher);
   if(snapshot.manifestHash!==input.expectedManifestHash)fail('manifest_conflict');
   // now() is transaction-start time and can predate a wait across midnight.
   // Capture the database clock after the lock, and use that same UTC day and
   // timestamp for both quota accounting and the immutable publication row.
   const clock=(await q.query('SELECT clock_timestamp() AS published_at')).rows[0];
   const publishedAt=date(clock.published_at),dayStart=publishedAt.slice(0,10)+'T00:00:00.000Z';
   const {total,own}=(await q.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_scope=$1)::int AS own
    FROM claus_packages WHERE published_at>=$2::timestamptz AND published_at<$2::timestamptz+interval '1 day'`,[scope,dayStart])).rows[0];
   if(own>=3)fail('author_daily_limit');if(total>=12)fail('global_daily_limit');
   const row=(await q.query(`INSERT INTO claus_packages(id,project_id,revision,owner_scope,manifest,manifest_hash,files,test_receipt,review_receipt,published_at,license_documents)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::timestamptz,$11::jsonb) RETURNING *`,
    [snapshot.manifest.id,clean.id,clean.revision,scope,JSON.stringify(snapshot.manifest),snapshot.manifestHash,JSON.stringify(snapshot.files),JSON.stringify(snapshot.testReceipt),JSON.stringify(snapshot.reviewReceipt),publishedAt,JSON.stringify(snapshot.licenseDocuments)])).rows[0];
   return this.receipt(q,key,scope,inputHash,row);
  });
 }
 async withdraw(requestId:string,scope:string,packageId:string){
  scopeCheck(scope);packageCheck(packageId);
  const {key,inputHash}=this.request(requestId,scope,{action:'withdraw',packageId});
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041014)');
   const replay=await this.replay(q,key,inputHash,scope);if(replay)return replay;
   const row=(await q.query(`UPDATE claus_packages SET withdrawn_at=COALESCE(withdrawn_at,clock_timestamp())
    WHERE id=$1 AND owner_scope=$2 RETURNING ${packageColumns}`,[packageId,scope])).rows[0];
   if(!row)fail('missing');return this.receipt(q,key,scope,inputHash,row);
  });
 }
 async owned(scope:string,projectId:string):Promise<{packages:OwnedPackage[]}>{
  scopeCheck(scope);projectCheck(projectId);
  if(!(await this.db.query('SELECT 1 FROM claus_builds WHERE id=$1 AND owner_scope=$2',[projectId,scope])).rows.length)fail('project_missing');
  const rows=(await this.db.query(`SELECT ${packageColumns} FROM claus_packages WHERE owner_scope=$1 AND project_id=$2 ORDER BY published_at DESC,id DESC`,[scope,projectId])).rows;
  return {packages:rows.map(r=>({id:r.id,status:r.withdrawn_at?'withdrawn':'published',manifest:r.manifest,manifestHash:r.manifest_hash,publishedAt:date(r.published_at),withdrawnAt:r.withdrawn_at?date(r.withdrawn_at):null}))};
 }
 async list():Promise<{packages:PublishedPackage[]}>{
  const rows=(await this.db.query(`SELECT ${packageColumns} FROM claus_packages WHERE withdrawn_at IS NULL ORDER BY published_at DESC,id DESC LIMIT 24`)).rows;
  return {packages:rows.map(r=>publicPackage(r) as PublishedPackage)};
 }
 async read(packageId:string,download=false):Promise<{package:PublicPackage}>{
  packageCheck(packageId);if(typeof download!=='boolean')fail('input_invalid');
  const row=(await this.db.query(`SELECT ${packageColumns}${download?',files,license_documents':''} FROM claus_packages WHERE id=$1`,[packageId])).rows[0];
  if(!row)fail('missing');return {package:publicPackage(row,download)};
 }
}
