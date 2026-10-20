// Private startup gate. Call before opening stores, listeners, OAuth or workers.
// Roll out readers + this gate first, then arm a restart of that SAME release.
// Interrupted attempts never replay. Originals remain on the persistent disk.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {migrateCanonicalDeliveries,verifyCompletedCanonicalMigration} from './canonical-delivery-migration.mjs';
import {inventory,verifyService} from './r2-backup/backup.mjs';
import {assertReviewedReadiness} from './canonical-migration-readiness.mjs';

const H=/^[a-f0-9]{64}$/,R=/^[a-f0-9]{40}$/;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const present=f=>fs.lstat(f).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,keys)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(','),'MIGRATION_GATE_SCHEMA');
const CODE_ROOT=fileURLToPath(new URL('../../',import.meta.url));
// Frozen canonical compatibility files from the completed 31c06900 release.
// Entry/gate changes require explicit target-code pins in the operator record.
export const CANONICAL_COMPATIBILITY_PINS=Object.freeze([
 ['molyvi-growth/lib/customer-delivery.mjs',11985,'1537b8b5c55fc372f5b517a0b4e689606cffe9067009b9699a0fc28b587976da'],
 ['molyvi-growth/lib/delivery-archive-source.mjs',16035,'0ceacaaad082dba7d77251d8d904537f0d3e44b866af59c29d23ffa7fb491ea2'],
 ['molyvi-growth/lib/delivery-final-release.mjs',19586,'49b2d0fd7560c96491e70414263b894e293209b3dbb66c034c3d185e4850ece1'],
 ['molyvi-growth/lib/delivery-revision.mjs',20215,'4cb34e59d4bb679062b1b5b83ada1f4f6ae25da7589cf45152b0bc458b50f5db'],
 ['molyvi-growth/lib/delivery-storage-prepare.mjs',5461,'33552103c2d158834bc7adbf13b26b8805c5876573cdd1a97909238d9fa553c6'],
 ['molyvi-growth/lib/delivery-storage.mjs',8143,'e21b7b9bb97cc750e75d87d6f4461f2c97f2333e73ab10a5d17bca6bcb1032f3'],
 ['molyvi-growth/lib/service-handoff.mjs',21012,'86957b101b02b7b016431adfdb1d4a0610bec212f64483ed2aa8ee2f2b1c0211'],
 ['molyvi-growth/operations/canonical-delivery-migration.mjs',25779,'f8e5d552d87c724b1ebee40eef0bf05eb871fe81df5be91a912c92b773573633'],
 ['molyvi-growth/operations/canonical-migration-readiness.mjs',26461,'5105239c40ea581284217588be6572940d368a45d776b85460f4b99c0d07ee86'],
 ['molyvi-growth/operations/r2-backup/backup.mjs',14092,'55338936b2e71b403c2d356151aa75b4595d0e07d6dade1accaf84b7ecb1c145'],
].map(([file,bytes,sha256])=>Object.freeze({file,bytes,sha256})));
export const CANONICAL_RELEASE_PIN_PATHS=Object.freeze([...CANONICAL_COMPATIBILITY_PINS.map(p=>p.file),'molyvi-growth/hosted-customer-server.mjs','molyvi-growth/operations/canonical-migration-startup.mjs'].sort());
export const HOSTED_CANONICAL_COMPLETION_ANCHOR=Object.freeze({baseRelease:'31c06900ba4805afd922558918f7d819544aefef',permitHash:'c1d31cb94a49a5d322870c4460399b8f3ccb153bea8280da0abb845cb1ac6104',attemptHash:'c6e22e9a435cc5eab86af29755f9c6a7e5814cf77e8a63570be2474a55b0eff1',completionHash:'f8b6988cdc99ec8b2796a43179e56a52de0aaf9bc36f1d5678d757d6f1c8a100',planHash:'8be79553039208274da3e3f4e59cbb4767ed9d7a8e8b9fb64cc2f73a9f9adae0'});
async function ordinary(file,directory=false){
 file=path.resolve(file);let at=path.parse(file).root;
 for(const bit of file.slice(at.length).split(path.sep).filter(Boolean)){
  at=path.join(at,bit);const s=await fs.lstat(at);
  check(!s.isSymbolicLink()&&(at!==file||directory?s.isDirectory():s.isFile()&&s.nlink===1),'MIGRATION_GATE_UNSAFE_PATH');
 }
 const real=await fs.realpath(file);check(process.platform==='win32'?real.toLowerCase()===file.toLowerCase():real===file,'MIGRATION_GATE_ALIAS');
}
async function read(file,parse=true){
 await ordinary(file);const s=await fs.lstat(file);check(s.size>0&&s.size<=1024*1024,'MIGRATION_GATE_METADATA_LIMIT');
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 const unchanged=a=>s.dev===a.dev&&s.ino===a.ino&&s.size===a.size&&s.mtimeMs===a.mtimeMs&&s.ctimeMs===a.ctimeMs&&a.nlink===1;
 try{
  check(unchanged(await h.stat()),'MIGRATION_GATE_CHANGED');const raw=Buffer.alloc(s.size);let offset=0;
  while(offset<raw.length){const r=await h.read(raw,offset,Math.min(65536,raw.length-offset),offset);check(r.bytesRead>0,'MIGRATION_GATE_CHANGED');offset+=r.bytesRead;}
  check((await h.read(Buffer.alloc(1),0,1,offset)).bytesRead===0,'MIGRATION_GATE_CHANGED');await ordinary(file);
  check(unchanged(await fs.lstat(file))&&unchanged(await h.stat()),'MIGRATION_GATE_CHANGED');
  return parse?{value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),sha256:hash(raw)}:{bytes:raw.length,sha256:hash(raw)};
 }finally{await h.close();}
}
async function write(file,value){
 const raw=Buffer.from(JSON.stringify(value)+'\n');check(raw.length<=1024*1024,'MIGRATION_GATE_METADATA_LIMIT');
 const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}
 if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
 return hash(raw);
}

// Read-only predeploy validation against a local copy of the exact target code.
// This checks private operator configuration, not issuer authentication or live
// completion. Startup separately verifies the original receipts and full layout.
export async function validateCanonicalCarryForwardAuthorization({record,anchor,source,controlRoot,output,scope,release,codeRoot=CODE_ROOT,now=Date.now()}){
 const serialized=JSON.stringify({record,anchor,scope});check(typeof serialized==='string'&&Buffer.byteLength(serialized)<=1024*1024,'MIGRATION_GATE_METADATA_LIMIT');
 ({record,anchor,scope}=JSON.parse(serialized));
 exact(anchor,'baseRelease,permitHash,attemptHash,completionHash,planHash');
 check(R.test(anchor.baseRelease)&&['permitHash','attemptHash','completionHash','planHash'].every(k=>H.test(anchor[k])),'MIGRATION_GATE_RELEASE_ANCHOR');
 exact(record,'schemaVersion,format,scope,baseRelease,targetRelease,source,controlRoot,output,anchors,codePins,authorizedAt,authorizationReferenceSha256');
 exact(record.scope,'serviceId,workspaceId');exact(record.anchors,'permitHash,attemptHash,completionHash,planHash');
 check(record.schemaVersion===1&&record.format==='molyvi_canonical_carry_forward_v1'&&same(record.scope,scope)&&record.baseRelease===anchor.baseRelease&&R.test(release)&&record.targetRelease===release&&release!==anchor.baseRelease&&record.source===source&&record.controlRoot===controlRoot&&record.output===output,'MIGRATION_GATE_RELEASE_SCOPE');
 check(['permitHash','attemptHash','completionHash','planHash'].every(k=>record.anchors[k]===anchor[k]),'MIGRATION_GATE_RELEASE_ANCHOR');
 check(typeof codeRoot==='string'&&path.isAbsolute(codeRoot)&&[source,controlRoot,output].every(p=>typeof p==='string'&&path.isAbsolute(p)),'MIGRATION_GATE_RELEASE_SCOPE');
 check(H.test(record.authorizationReferenceSha256)&&typeof record.authorizedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.authorizedAt)&&Number.isFinite(Date.parse(record.authorizedAt))&&Number.isSafeInteger(now)&&Date.parse(record.authorizedAt)<=now,'MIGRATION_GATE_RELEASE_AUTHORIZATION');
 check(Array.isArray(record.codePins)&&record.codePins.length===CANONICAL_RELEASE_PIN_PATHS.length&&same(record.codePins.map(p=>p?.file),CANONICAL_RELEASE_PIN_PATHS),'MIGRATION_GATE_RELEASE_CODE_PINS');
 for(const pin of record.codePins){
  exact(pin,'file,bytes,sha256');check(Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=1024*1024&&H.test(pin.sha256),'MIGRATION_GATE_RELEASE_CODE_PINS');
  const frozen=CANONICAL_COMPATIBILITY_PINS.find(p=>p.file===pin.file);if(frozen)check(pin.bytes===frozen.bytes&&pin.sha256===frozen.sha256,'MIGRATION_GATE_RELEASE_COMPATIBILITY');
  const actual=await read(path.join(codeRoot,pin.file),false);check(actual.bytes===pin.bytes&&actual.sha256===pin.sha256,'MIGRATION_GATE_RELEASE_CODE_CHANGED');
 }
 return true;
}
async function carryForward({anchor,source,controlRoot,output,scope,release,codeRoot,clock,completedAt}){
 const directory=controlRoot+'-releases';check(await present(directory),'MIGRATION_GATE_RELEASE_NOT_AUTHORIZED');await ordinary(directory,true);
 const names=(await fs.readdir(directory)).sort(),name=release+'.json';
 check(names.length<=32&&names.every(n=>/^[a-f0-9]{40}\.json$/.test(n))&&names.includes(name),'MIGRATION_GATE_RELEASE_NOT_AUTHORIZED');
 const file=path.join(directory,name),record=await read(file),validate=async()=>{
  await validateCanonicalCarryForwardAuthorization({record:record.value,anchor,source,controlRoot,output,scope,release,codeRoot,now:clock()});
  check(Number.isFinite(Date.parse(completedAt))&&Date.parse(record.value.authorizedAt)>=Date.parse(completedAt),'MIGRATION_GATE_RELEASE_AUTHORIZATION');
 };
 await validate();return {sha256:record.sha256,stable:async()=>{
  await ordinary(directory,true);check(same((await fs.readdir(directory)).sort(),names)&&(await read(file)).sha256===record.sha256,'MIGRATION_GATE_RELEASE_CHANGED');await validate();
 }};
}

export function createCanonicalMigrationStartup({migrate=migrateCanonicalDeliveries,verifyCompleted=verifyCompletedCanonicalMigration,verifyApplication=verifyApplicationReadOnly,assertReadiness=assertReviewedReadiness,clock=Date.now,carryForwardAnchor=null,codeRoot=CODE_ROOT}={}){
 if(carryForwardAnchor!==null){exact(carryForwardAnchor,'baseRelease,permitHash,attemptHash,completionHash,planHash');carryForwardAnchor={...carryForwardAnchor};}
 return async function run({source,controlRoot,output,release,serviceId,workspaceId}){
  for(const s of [source,controlRoot,output])check(typeof s==='string'&&path.isAbsolute(s),'MIGRATION_GATE_PATH');
  source=path.resolve(source);controlRoot=path.resolve(controlRoot);output=path.resolve(output);
  check(new Set([source,controlRoot,output]).size===3&&path.dirname(source)===path.dirname(controlRoot)&&path.dirname(source)===path.dirname(output),'MIGRATION_GATE_PATH');
  check(R.test(release)&&typeof serviceId==='string'&&typeof workspaceId==='string','MIGRATION_GATE_SCOPE');
  await ordinary(source,true);
  if(!await present(controlRoot)){
   check(!await present(output),'MIGRATION_GATE_ORPHAN_OUTPUT');return {status:'NOT_ARMED',migrationRun:false};
  }
  await ordinary(controlRoot,true);const names=(await fs.readdir(controlRoot)).sort();
  check(names.every(n=>['permit.json','attempt.json','completion.json','failure.json'].includes(n)),'MIGRATION_GATE_UNKNOWN_STATE');
  check(names.includes('permit.json'),'MIGRATION_GATE_MISSING_PERMIT');
  const permitFile=path.join(controlRoot,'permit.json'),p=await read(permitFile),v=p.value;
  exact(v,'schemaVersion,format,serviceId,workspaceId,release,source,output,deliveries,createdAt,expiresAt,readinessPins,readiness,twoPhaseCompatibleRelease');
  check(v.schemaVersion===1&&v.format==='molyvi_canonical_startup_v1'&&v.serviceId===serviceId&&v.workspaceId===workspaceId&&R.test(v.release)&&v.twoPhaseCompatibleRelease===v.release&&v.source===source&&v.output===output,'MIGRATION_GATE_SCOPE');
  const changedRelease=v.release!==release;
  check(!changedRelease||(carryForwardAnchor&&names.includes('attempt.json')&&names.includes('completion.json')),'MIGRATION_GATE_SCOPE');
  check(Array.isArray(v.deliveries)&&v.deliveries.length===2&&Array.isArray(v.readinessPins)&&v.readinessPins.length<=10000,'MIGRATION_GATE_SCHEMA');
  const scope={serviceId,workspaceId},identity={permitHash:p.sha256,release:v.release,source,output,scope};
  const stable=async()=>check((await read(permitFile)).sha256===p.sha256,'MIGRATION_GATE_CHANGED');
  const stateIs=async expected=>check(same((await fs.readdir(controlRoot)).sort(),[...expected].sort()),'MIGRATION_GATE_STATE_CHANGED');
  check(!names.includes('failure.json'),'MIGRATION_GATE_FAILED_ATTEMPT');
  if(names.includes('attempt.json')){
   const a=await read(path.join(controlRoot,'attempt.json'));
   exact(a.value,'schemaVersion,identity,startedAt');check(a.value.schemaVersion===1&&same(a.value.identity,identity),'MIGRATION_GATE_ATTEMPT_MISMATCH');
   check(names.includes('completion.json'),'MIGRATION_GATE_INCOMPLETE_ATTEMPT');
   const c=await read(path.join(controlRoot,'completion.json'));
   exact(c.value,'schemaVersion,identity,attemptHash,completedAt,result');
   check(c.value.schemaVersion===1&&same(c.value.identity,identity)&&c.value.attemptHash===a.sha256,'MIGRATION_GATE_COMPLETION_MISMATCH');
   const r=c.value.result;check(r?.status==='PASS_CANONICAL_MIGRATION'&&r.output===output&&H.test(r.planHash)&&r.requiresMaintenance===false,'MIGRATION_GATE_COMPLETION_MISMATCH');
   let authorization=null;
   if(changedRelease){
    const actual={baseRelease:v.release,permitHash:p.sha256,attemptHash:a.sha256,completionHash:c.sha256,planHash:r.planHash};
    check(same(actual,carryForwardAnchor),'MIGRATION_GATE_RELEASE_ANCHOR');
    authorization=await carryForward({anchor:actual,source,controlRoot,output,scope,release,codeRoot,clock,completedAt:c.value.completedAt});
   }
   check(await verifyCompleted({source,output,scope,planHash:r.planHash,deliveries:v.deliveries})===true,'MIGRATION_GATE_COMPLETION_READBACK');
   if(authorization)await authorization.stable();
   await stable();await stateIs(['permit.json','attempt.json','completion.json']);check((await read(path.join(controlRoot,'attempt.json'))).sha256===a.sha256&&(await read(path.join(controlRoot,'completion.json'))).sha256===c.sha256,'MIGRATION_GATE_CHANGED');
   if(authorization)return {status:'VERIFIED_COMPLETED_CARRY_FORWARD',migrationRun:false,planHash:r.planHash,baseRelease:v.release,targetRelease:release,authorizationSha256:authorization.sha256};
   return {status:'VERIFIED_COMPLETED',migrationRun:false,planHash:r.planHash};
  }
  check(!names.includes('completion.json')&&!await present(output),'MIGRATION_GATE_ORPHAN_OUTPUT');
  const now=clock(),created=Date.parse(v.createdAt),expires=Date.parse(v.expiresAt);
  check(Number.isFinite(created)&&Number.isFinite(expires)&&created<=now&&expires>now&&expires-created<=60*60*1000,'MIGRATION_GATE_EXPIRED');
  await stable();check(await assertReadiness({source,permit:v})===true,'MIGRATION_GATE_UNSETTLED_WORK');await stable();await stateIs(['permit.json']);check(clock()<expires,'MIGRATION_GATE_EXPIRED');
  const attemptHash=await write(path.join(controlRoot,'attempt.json'),{schemaVersion:1,identity,startedAt:new Date(now).toISOString()});
  let held=false;
  const assertExclusive=async()=>{
   await stable();check((await read(path.join(controlRoot,'attempt.json'))).sha256===attemptHash,'MIGRATION_GATE_CHANGED');
   await stateIs(['permit.json','attempt.json']);check(held,'MIGRATION_GATE_EXCLUSIVITY');return true;
  };
  try{
   const result=await migrate({source,output,scope,deliveries:v.deliveries,
    withExclusiveResources:async fn=>{check(!held,'MIGRATION_GATE_NESTED');held=true;try{return await fn();}finally{held=false;}},
    assertExclusive,verifyApplication});
   check(result?.status==='PASS_CANONICAL_MIGRATION'&&result.output===output&&H.test(result.planHash)&&result.requiresMaintenance===false,'MIGRATION_GATE_RESULT');
   check(await verifyCompleted({source,output,scope,planHash:result.planHash,deliveries:v.deliveries})===true,'MIGRATION_GATE_COMPLETION_READBACK');
   await stable();await stateIs(['permit.json','attempt.json']);check((await read(path.join(controlRoot,'attempt.json'))).sha256===attemptHash,'MIGRATION_GATE_CHANGED');
   await write(path.join(controlRoot,'completion.json'),{schemaVersion:1,identity,attemptHash,completedAt:new Date(clock()).toISOString(),result});
   return {status:'MIGRATED_VERIFIED',migrationRun:true,result};
  }catch(error){
   await write(path.join(controlRoot,'failure.json'),{schemaVersion:1,identity,attemptHash,code:/^[A-Z0-9_]{1,100}$/.test(error.code??'')?error.code:'MIGRATION_STARTUP_FAILED',planHash:H.test(error.migration?.planHash??'')?error.migration.planHash:null,requiresMaintenance:true}).catch(()=>{});
   throw error;
  }
 };
}

// Full application read-back without constructing the app or sending email.
export async function verifyApplicationReadOnly({source}){
 const files=await inventory(source),db=new DatabaseSync(path.join(source,'accounts/customers.sqlite'),{readOnly:true});let database;
 try{const counts={};for(const table of ['accounts','projects','deliveries','reviews','sessions','mail_outbox'])counts[table]=db.prepare('SELECT count(*) n FROM '+table).get().n;
  database={integrity:'ok',userVersion:db.prepare('PRAGMA user_version').get().user_version,counts};
 }finally{db.close();}
 const result=await verifyService(source,{schemaVersion:1,kind:'molyvi_private_service_snapshot',files,database});return result.status==='PASS';
}

const HOST='/opt/render/project/src/briefs';
export async function runCanonicalMigrationStartup({source,controlRoot,release,serviceId}){
 check(source===HOST+'/molyvi-hosted-staging'&&controlRoot===HOST+'/molyvi-canonical-migration-20261020-r1'&&serviceId==='srv-db7othjrjlhs73cg7lf0','MIGRATION_GATE_WRONG_SERVICE');
 return createCanonicalMigrationStartup({carryForwardAnchor:HOSTED_CANONICAL_COMPLETION_ANCHOR})({source,controlRoot,output:HOST+'/molyvi-canonical-rollback-20261020-r1',release,serviceId,workspaceId:'tea-d9bnluoqmsqc7399dhfg'});
}
