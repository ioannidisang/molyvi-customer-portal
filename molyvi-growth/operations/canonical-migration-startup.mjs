// Private startup gate. Call before opening stores, listeners, OAuth or workers.
// Roll out readers + this gate first, then arm a restart of that SAME release.
// Interrupted attempts never replay. Originals remain on the persistent disk.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrateCanonicalDeliveries,verifyCompletedCanonicalMigration} from './canonical-delivery-migration.mjs';
import {inventory,verifyService} from './r2-backup/backup.mjs';
import {assertReviewedReadiness} from './canonical-migration-readiness.mjs';

const H=/^[a-f0-9]{64}$/,R=/^[a-f0-9]{40}$/;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const present=f=>fs.lstat(f).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,keys)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(','),'MIGRATION_GATE_SCHEMA');
async function ordinary(file,directory=false){
 file=path.resolve(file);let at=path.parse(file).root;
 for(const bit of file.slice(at.length).split(path.sep).filter(Boolean)){
  at=path.join(at,bit);const s=await fs.lstat(at);
  check(!s.isSymbolicLink()&&(at!==file||directory?s.isDirectory():s.isFile()&&s.nlink===1),'MIGRATION_GATE_UNSAFE_PATH');
 }
 const real=await fs.realpath(file);check(process.platform==='win32'?real.toLowerCase()===file.toLowerCase():real===file,'MIGRATION_GATE_ALIAS');
}
async function read(file){
 await ordinary(file);const s=await fs.lstat(file);check(s.size>0&&s.size<=1024*1024,'MIGRATION_GATE_METADATA_LIMIT');
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 const unchanged=a=>s.dev===a.dev&&s.ino===a.ino&&s.size===a.size&&s.mtimeMs===a.mtimeMs&&s.ctimeMs===a.ctimeMs&&a.nlink===1;
 try{
  check(unchanged(await h.stat()),'MIGRATION_GATE_CHANGED');const raw=Buffer.alloc(s.size);let offset=0;
  while(offset<raw.length){const r=await h.read(raw,offset,Math.min(65536,raw.length-offset),offset);check(r.bytesRead>0,'MIGRATION_GATE_CHANGED');offset+=r.bytesRead;}
  check((await h.read(Buffer.alloc(1),0,1,offset)).bytesRead===0,'MIGRATION_GATE_CHANGED');await ordinary(file);
  check(unchanged(await fs.lstat(file))&&unchanged(await h.stat()),'MIGRATION_GATE_CHANGED');
  return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),sha256:hash(raw)};
 }finally{await h.close();}
}
async function write(file,value){
 const raw=Buffer.from(JSON.stringify(value)+'\n');check(raw.length<=1024*1024,'MIGRATION_GATE_METADATA_LIMIT');
 const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}
 if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
 return hash(raw);
}

export function createCanonicalMigrationStartup({migrate=migrateCanonicalDeliveries,verifyCompleted=verifyCompletedCanonicalMigration,verifyApplication=verifyApplicationReadOnly,assertReadiness=assertReviewedReadiness,clock=Date.now}={}){
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
  check(v.schemaVersion===1&&v.format==='molyvi_canonical_startup_v1'&&v.serviceId===serviceId&&v.workspaceId===workspaceId&&v.release===release&&v.twoPhaseCompatibleRelease===release&&v.source===source&&v.output===output,'MIGRATION_GATE_SCOPE');
  check(Array.isArray(v.deliveries)&&v.deliveries.length===2&&Array.isArray(v.readinessPins)&&v.readinessPins.length<=10000,'MIGRATION_GATE_SCHEMA');
  const scope={serviceId,workspaceId},identity={permitHash:p.sha256,release,source,output,scope};
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
   check(await verifyCompleted({source,output,scope,planHash:r.planHash,deliveries:v.deliveries})===true,'MIGRATION_GATE_COMPLETION_READBACK');
   await stable();await stateIs(['permit.json','attempt.json','completion.json']);check((await read(path.join(controlRoot,'attempt.json'))).sha256===a.sha256&&(await read(path.join(controlRoot,'completion.json'))).sha256===c.sha256,'MIGRATION_GATE_CHANGED');
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
 return createCanonicalMigrationStartup()({source,controlRoot,output:HOST+'/molyvi-canonical-rollback-20261020-r1',release,serviceId,workspaceId:'tea-d9bnluoqmsqc7399dhfg'});
}
