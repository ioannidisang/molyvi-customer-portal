// One-use, private, opt-in measurement in the resident application process.
// It never loads real R2 credentials or changes an automatic activation.
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {DatabaseSync} from 'node:sqlite';
import {inventory,safeName} from './backup.mjs';
import {createReferenceBackupRun,assessReferenceBackupCapacity,REFERENCE_AUTOMATIC_DISK_BYTES} from './automatic-run.mjs';
import {R2Budget} from './r2-budget.mjs';
import {RetentionCatalog} from './retention.mjs';
import {createR2Transport} from './r2-transport.mjs';
import {readLinuxMemorySample} from './hosted-memory-probe-sampler.mjs';

const SERVICE='srv-db7othjrjlhs73cg7lf0',configs=new WeakSet(),check=(v,m)=>{if(!v)throw Error(m);};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),json=value=>JSON.stringify(value);
const HASH=/^[a-f0-9]{64}$/,RUN=/^auto-[0-9]{14}-[a-f0-9]{8}$/;
export const HOSTED_PROBE_POLICY=Object.freeze({
  schemaVersion:1,limitBytes:512*1024*1024,baselineRssBytes:192*1024*1024,baselineAnonBytes:192*1024*1024,
  rssStopBytes:416*1024*1024,anonStopBytes:416*1024*1024,currentWarningBytes:496*1024*1024,
  deadlineMs:15*60*1000,mockObjectBytes:512_000_000,requiredFreeBytes:REFERENCE_AUTOMATIC_DISK_BYTES+512_000_000
});
const CONTROL_FILES=Object.freeze([
  'molyvi-r2-access/automatic.json','molyvi-r2-access/budget.sqlite','molyvi-r2-access/r2-config.json',
  'molyvi-r2-access/retention.json','molyvi-r2-automatic/retention.sqlite','molyvi-r2-automatic/schedule.sqlite'
]);
const CONTROL_DBS=CONTROL_FILES.filter(file=>file.endsWith('.sqlite'));
function exactKeys(value,keys,code){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),code);}
async function safePath(file,{directory=false}={}){
  file=path.resolve(file);let current=path.parse(file).root;
  for(const bit of file.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,bit);const s=await fs.lstat(current);
    check(!s.isSymbolicLink(),'PROBE_PATH_LINK');
    if(current!==file)check(s.isDirectory(),'PROBE_PATH_TYPE');
    else check(directory?s.isDirectory():s.isFile()&&s.nlink===1,'PROBE_PATH_TYPE');
  }
  const real=await fs.realpath(file);
  check(process.platform==='win32'?real.toLowerCase()===file.toLowerCase():real===file,'PROBE_PATH_ALIAS');
  return file;
}
async function syncDirectory(dir){if(process.platform!=='win32'){const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}}
async function write(file,value){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}await syncDirectory(path.dirname(file));}
async function readJson(file,max=1024*1024){
  await safePath(file);const h=await fs.open(file,'r');
  try{
    const before=await h.stat();check(before.size>0&&before.size<=max&&before.nlink===1,'PROBE_JSON_LIMIT');
    const data=Buffer.alloc(before.size),extra=Buffer.alloc(1);let offset=0;
    while(offset<data.length){const r=await h.read(data,offset,data.length-offset,offset);check(r.bytesRead>0,'PROBE_FILE_CHANGED');offset+=r.bytesRead;}
    check((await h.read(extra,0,1,offset)).bytesRead===0,'PROBE_FILE_CHANGED');
    const after=await h.stat();check(before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ino===after.ino,'PROBE_FILE_CHANGED');
    return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)),hash:sha(data)};
  }finally{await h.close();}
}
async function digest(file){
  await safePath(file);const h=crypto.createHash('sha256');let bytes=0;
  for await(const b of createReadStream(file)){bytes+=b.length;check(bytes<=512_000_000,'PROBE_FILE_LIMIT');h.update(b);}
  return {bytes,sha256:h.digest('hex')};
}
function disjoint(a,b){for(const [x,y]of [[a,b],[b,a]]){const r=path.relative(x,y);check(r&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'PROBE_PATH_OVERLAP');}}
async function databaseState(file,{application=false,schedule=false}={}){
  await safePath(file);const db=new DatabaseSync(file,{readOnly:true});
  try{
    check(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','PROBE_DATABASE_INTEGRITY');
    check(db.prepare('PRAGMA foreign_key_check').all().length===0,'PROBE_DATABASE_FOREIGN_KEYS');
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{
      check(/^[a-z_]+$/.test(name),'PROBE_DATABASE_TABLE');const hash=crypto.createHash('sha256');let rows=0;
      for(const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()){hash.update(json(row)+'\n');check(++rows<=1_000_000,'PROBE_DATABASE_ROW_LIMIT');}
      return {table:name,rows,sha256:hash.digest('hex')};
    });
    const result={tables,userVersion:db.prepare('PRAGMA user_version').get().user_version};
    if(application){const pending=db.prepare("SELECT count(*) n FROM mail_outbox WHERE status IN ('queued','retry_wait','sending')").get().n;check(pending===0,'PROBE_PENDING_MAIL');result.pendingMail=pending;}
    if(schedule){
      const row=db.prepare('SELECT status,next_at,error,alert_status FROM schedule WHERE id=1').get();
      check(row?.status==='waiting'&&row.error===null&&row.alert_status===null,'PROBE_SCHEDULE_NOT_IDLE');result.schedule={...row};
    }
    return result;
  }finally{db.close();}
}
async function controlState(base){
  const files=[];for(const file of CONTROL_FILES)files.push({file,...await digest(path.join(base,file))});
  const databases=[];for(const file of CONTROL_DBS)databases.push({file,...await databaseState(path.join(base,file),{schedule:file.endsWith('/schedule.sqlite')})});
  const format=path.join(base,'molyvi-r2-access/reference-format.json');
  try{await fs.lstat(format);throw Error('PROBE_REFERENCE_ACTIVATION_ALREADY_PRESENT');}catch(e){if(e.code!=='ENOENT')throw e;}
  const usageDb=new DatabaseSync(path.join(base,'molyvi-r2-access/budget.sqlite'),{readOnly:true});
  const retentionDb=new DatabaseSync(path.join(base,'molyvi-r2-automatic/retention.sqlite'),{readOnly:true});
  let usage,retained;
  try{
    usage={...usageDb.prepare('SELECT COALESCE(sum(requests),0) requests,COALESCE(sum(upload_bytes),0) uploadBytes,COALESCE(sum(download_bytes),0) downloadBytes FROM reservations WHERE at>?').get(Date.now()-31*86_400_000)};
    retained={...retentionDb.prepare("SELECT COALESCE(sum(bytes),0) storedBytes,count(*) objects FROM backups WHERE status='active'").get()};
  }finally{usageDb.close();retentionDb.close();}
  return {files,databases,usage,retained,referenceActivationAbsent:true};
}
async function pendingWorkspaceJobs(source){
  let count=0;
  for(const entry of await fs.readdir(path.join(source,'workspaces'),{withFileTypes:true})){
    if(entry.name.startsWith('.'))continue;
    check(entry.isDirectory()&&!entry.isSymbolicLink(),'PROBE_WORKSPACE_DIRECTORY');
    const {value}=await readJson(path.join(source,'workspaces',entry.name,'workspace.json'));
    for(const job of Object.values(value.jobs??{}))if(['queued','running','result_ready'].includes(job?.status))count++;
  }
  check(count===0,'PROBE_PENDING_WORKSPACE_JOBS');return count;
}
export async function captureHostedProbePreservation({source,probeRoot}){
  source=await safePath(source,{directory:true});probeRoot=await safePath(probeRoot,{directory:true});
  disjoint(source,probeRoot);check(path.dirname(source)===path.dirname(probeRoot),'PROBE_ROOT_SCOPE');
  const complete=await inventory(source,{skipSqliteSidecars:true}),sourceLogicalBytes=complete.reduce((n,e)=>n+e.bytes,0);
  check(sourceLogicalBytes+12*1024*1024<=512_000_000,'PROBE_SOURCE_CAPACITY');
  const files=complete.filter(entry=>entry.file!=='accounts/customers.sqlite');
  const application=await databaseState(path.join(source,'accounts/customers.sqlite'),{application:true});
  const controls=await controlState(path.dirname(source));
  return {files,application,controls,pendingWorkspaceJobs:await pendingWorkspaceJobs(source),sourceLogicalBytes};
}
function validatePermit(value,{serviceId,release}){
  exactKeys(value,['schemaVersion','kind','serviceId','release','runId','expiresAt','controls','sourcePins'],'PROBE_PERMIT_FIELDS');
  check(value.schemaVersion===1&&value.kind==='molyvi_resident_backup_memory_once_v1'&&value.serviceId===SERVICE&&serviceId===SERVICE&&
    value.release===release&&/^[a-f0-9]{40}$/.test(release)&&RUN.test(value.runId),'PROBE_PERMIT_SCOPE');
  check(Number.isSafeInteger(value.expiresAt)&&value.expiresAt>0,'PROBE_PERMIT_EXPIRY');
  check(Array.isArray(value.controls)&&value.controls.length===CONTROL_FILES.length,'PROBE_CONTROL_PINS');
  check(value.controls.map(x=>x.file).sort().join(',')===[...CONTROL_FILES].sort().join(','),'PROBE_CONTROL_PINS');
  for(const pin of value.controls){exactKeys(pin,['file','sha256'],'PROBE_CONTROL_PINS');check(HASH.test(pin.sha256),'PROBE_CONTROL_PINS');}
  check(Array.isArray(value.sourcePins)&&value.sourcePins.length>0&&value.sourcePins.length<=4096,'PROBE_SOURCE_PINS');
  const names=new Set();for(const pin of value.sourcePins){
    exactKeys(pin,['file','bytes','sha256'],'PROBE_SOURCE_PINS');safeName(pin.file);
    check(!names.has(pin.file)&&pin.file!=='accounts/customers.sqlite'&&!/-wal$|-shm$/.test(pin.file)&&Number.isSafeInteger(pin.bytes)&&pin.bytes>=0&&HASH.test(pin.sha256),'PROBE_SOURCE_PINS');
    names.add(pin.file);
  }
}
async function validateCurrent(config){
  const {value,hash}=await readJson(config.permitFile);check(hash===config.permitHash,'PROBE_PERMIT_CHANGED');validatePermit(value,config);
  check(Date.now()<value.expiresAt,'PROBE_PERMIT_EXPIRED');
  const controls=await controlState(path.dirname(config.source));
  for(const pin of value.controls)check(controls.files.find(x=>x.file===pin.file)?.sha256===pin.sha256,'PROBE_CONTROL_CHANGED');
  const schedule=controls.databases.find(x=>x.file.endsWith('/schedule.sqlite')).schedule;
  check(schedule.next_at>Date.now()+HOSTED_PROBE_POLICY.deadlineMs,'PROBE_SCHEDULE_TOO_SOON');
  for(const pin of value.sourcePins){const actual=await digest(path.join(config.source,pin.file));check(actual.bytes===pin.bytes&&actual.sha256===pin.sha256,'PROBE_SOURCE_PIN_CHANGED');}
  await databaseState(path.join(config.source,'accounts/customers.sqlite'),{application:true});await pendingWorkspaceJobs(config.source);
}
export async function loadHostedMemoryProbe({permitFile,source,probeRoot,release,serviceId}){
  permitFile=path.resolve(permitFile);source=path.resolve(source);probeRoot=path.resolve(probeRoot);
  try{await fs.lstat(permitFile);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(permitFile===path.join(probeRoot,'permit.json')&&path.dirname(source)===path.dirname(probeRoot),'PROBE_ROOT_SCOPE');disjoint(source,probeRoot);
  await safePath(probeRoot,{directory:true});await safePath(source,{directory:true});
  const {value,hash}=await readJson(permitFile);validatePermit(value,{release,serviceId});
  const config=Object.freeze({permitFile,source,probeRoot,release,serviceId,permitHash:hash,runId:value.runId});
  configs.add(config);
  try{await fs.lstat(path.join(probeRoot,'attempt.json'));}catch(e){if(e.code!=='ENOENT')throw e;await validateCurrent(config);}
  return config;
}
async function priorOutcome(config){
  let attempt;try{attempt=(await readJson(path.join(config.probeRoot,'attempt.json'))).value;}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(attempt.permitHash===config.permitHash&&attempt.release===config.release&&attempt.runId===config.runId,'PROBE_ATTEMPT_CONFLICT');
  try{
    const {value:complete}=await readJson(path.join(config.probeRoot,'complete.json'));
    const report=await readJson(path.join(config.probeRoot,'report.json'));
    check(complete.permitHash===config.permitHash&&complete.reportHash===report.hash&&report.value.status==='PASS'&&report.value.permitHash===config.permitHash,'PROBE_COMPLETION_INVALID');
    return {status:'SKIP_VERIFIED_PASS',allowAutomaticStart:true,runId:config.runId,reportHash:report.hash};
  }catch(e){if(e.code!=='ENOENT')throw e;return {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:false,runId:config.runId};}
}
async function startSampler({root,deadline,flags}){
  check(process.platform==='linux','PROBE_LINUX_REQUIRED');
  const initial=await readLinuxMemorySample();
  check(initial.limitBytes===HOSTED_PROBE_POLICY.limitBytes,'PROBE_CGROUP_LIMIT_MISMATCH');
  check(initial.rssBytes<=HOSTED_PROBE_POLICY.baselineRssBytes&&initial.nonreclaimableEstimateBytes<=HOSTED_PROBE_POLICY.baselineAnonBytes,'PROBE_INITIAL_MEMORY_HEADROOM');
  check((initial.events.oom??0)===0&&(initial.events.oom_kill??0)===0,'PROBE_EXISTING_OOM_EVENT');
  const worker=new Worker(new URL('./hosted-memory-probe-sampler.mjs',import.meta.url),{workerData:{
    shared:flags.buffer,logFile:path.join(root,'memory-samples.jsonl'),deadline,policy:HOSTED_PROBE_POLICY,initial,
    cgroup:'/sys/fs/cgroup',proc:'/proc',pid:process.pid,threadLabel:'bounded-memory-observer'
  },resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4,stackSizeMb:1}});
  let readyResolve,readyReject,finishResolve,finishReject,done=false;
  const ready=new Promise((res,rej)=>{readyResolve=res;readyReject=rej;}),finished=new Promise((res,rej)=>{finishResolve=res;finishReject=rej;});
  finished.catch(()=>{});
  worker.on('message',message=>{if(message.type==='ready')readyResolve(message.sample);if(message.type==='complete'){done=true;readyReject(Error(message.error??'PROBE_SAMPLER_STOPPED'));finishResolve(message);}});
  worker.on('error',e=>{Atomics.compareExchange(flags,1,0,4);readyReject(e);finishReject(e);});
  worker.on('exit',code=>{if(!done){const e=Error('PROBE_SAMPLER_EXIT_'+code);Atomics.compareExchange(flags,1,0,4);readyReject(e);finishReject(e);}});
  await ready;
  return {initial,async stop(){Atomics.store(flags,0,1);return finished;}};
}
function diskSdk({directory,mark,guard,calls}){
  const objects=new Map();
  const sdk={};
  for(const kind of ['HeadObject','PutObject','GetObject','ListObjectsV2','DeleteObject'])sdk[kind+'Command']=class{constructor(input){this.input=input;this.kind=kind;}};
  sdk.S3Client=class{
    async send(command){
      guard();const {input:i,kind}=command;await mark('mock_'+kind);check(calls.length<32,'PROBE_MOCK_REQUEST_LIMIT');
      check(i.Bucket==='molyvi-private-backups'&&!i.ACL,'PROBE_MOCK_SCOPE');calls.push({sequence:calls.length+1,kind,at:Date.now()});
      const item=objects.get(i.Key);
      if(kind==='HeadObject'){if(!item)throw {$metadata:{httpStatusCode:404}};return {ContentLength:item.bytes,Metadata:item.metadata,ETag:item.etag};}
      if(kind==='ListObjectsV2')return {Contents:[...objects].map(([Key,o])=>({Key,Size:o.bytes,ETag:o.etag})),IsTruncated:false};
      if(kind==='PutObject'){
        check(!item&&objects.size===0&&i.IfNoneMatch==='*'&&i.ContentLength<=HOSTED_PROBE_POLICY.mockObjectBytes,'PROBE_MOCK_UPLOAD_SCOPE');
        const file=path.join(directory,'encrypted-object.mlvb');let bytes=0;
        const limit=new Transform({transform(chunk,encoding,callback){try{guard();bytes+=chunk.length;check(bytes<=i.ContentLength,'PROBE_MOCK_LENGTH');callback(null,chunk);}catch(e){callback(e);}}});
        await pipeline(i.Body,limit,createWriteStream(file,{flags:'wx',mode:0o600}));guard();check(bytes===i.ContentLength,'PROBE_MOCK_LENGTH');
        const result={bytes,metadata:{...i.Metadata},etag:'local-disk-only',file};objects.set(i.Key,result);return {ETag:result.etag};
      }
      if(kind==='GetObject'){check(item,'PROBE_MOCK_OBJECT_MISSING');return {ContentLength:item.bytes,Metadata:item.metadata,Body:createReadStream(item.file)};}
      throw Error('PROBE_MOCK_DELETION_FORBIDDEN');
    }
    destroy(){}
  };
  return sdk;
}
// The dependency seam is for trusted LOCAL tests only; deployment calls the
// exported runner below, which has no injectable transport, sampler or codec.
export function createHostedMemoryProbeRunnerForTests({sampler=startSampler,statfs=fs.statfs}={}){
  return ({app,config})=>run({app,config,sampler,statfs});
}
export function runHostedMemoryProbe({app,config}){return run({app,config,sampler:startSampler,statfs:fs.statfs});}
function run({app,config,sampler,statfs}){
  check(configs.has(config),'PROBE_GENUINE_CONFIG_REQUIRED');
  check(typeof app?.withBackupResources==='function'&&typeof app?.quietSnapshot==='function','PROBE_RESIDENT_APP_REQUIRED');
  // Synchronous call closes HTTP/production admission before the first await.
  return app.withBackupResources(async()=>{
    const prior=await priorOutcome(config);if(prior)return prior;
    const root=config.probeRoot,start=Date.now(),deadline=start+HOSTED_PROBE_POLICY.deadlineMs,flags=new Int32Array(new SharedArrayBuffer(12));
    await write(path.join(root,'attempt.json'),{schemaVersion:1,permitHash:config.permitHash,release:config.release,runId:config.runId,startedAt:start,pid:process.pid});
    let observer,budget,catalog,r2,before,after,memory,result,realCapacity;const phases=[],calls=[];
    const guard=()=>{check(Date.now()<=deadline,'PROBE_DEADLINE');const reason=Atomics.load(flags,1);check(reason===0,['','PROBE_DEADLINE','PROBE_MEMORY_STOP','PROBE_OOM_EVENT','PROBE_SAMPLER_FAILED'][reason]??'PROBE_STOP');};
    const mark=async phase=>{guard();check(phases.length<100,'PROBE_PHASE_LIMIT');phases.push({phase,sequence:phases.length+1,at:Date.now()});Atomics.store(flags,2,phases.length);};
    try{
      await validateCurrent(config);observer=await sampler({root,deadline,flags});await mark('preservation_before');
      before=await captureHostedProbePreservation(config);await write(path.join(root,'preservation-before.json'),before);guard();
      const disk=await statfs(root);check(Number(disk.bavail)*Number(disk.bsize)>=HOSTED_PROBE_POLICY.requiredFreeBytes,'PROBE_LOCAL_DISK_LIMIT');
      realCapacity=assessReferenceBackupCapacity({sourceBytes:before.sourceLogicalBytes,availableBytes:Number(disk.bavail)*Number(disk.bsize)-HOSTED_PROBE_POLICY.mockObjectBytes,
        usage:before.controls.usage,...before.controls.retained});
      check(realCapacity.admitted,'PROBE_REAL_CAPACITY_REFUSED');
      const runs=path.join(root,'runs'),mock=path.join(root,'mock-remote');
      await fs.mkdir(runs,{mode:0o700});await fs.mkdir(mock,{mode:0o700});await syncDirectory(root);
      const keyFile=path.join(root,'probe-key.bin'),key=crypto.randomBytes(32),keyHash=sha(key);
      const handle=await fs.open(keyFile,'wx',0o600);try{await handle.writeFile(key);await handle.sync();}finally{await handle.close();key.fill(0);}await syncDirectory(root);
      budget=await new R2Budget(path.join(root,'probe-budget.sqlite')).ready();catalog=await new RetentionCatalog(path.join(root,'probe-retention.sqlite')).ready();
      r2=await createR2Transport({accountId:'f'.repeat(32),bucket:'molyvi-private-backups',jurisdiction:'eu',accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)},
        {budget,sdk:diskSdk({directory:mock,mark,guard,calls})});
      const perform=createReferenceBackupRun({source:config.source,root:runs,release:config.release,keyFile,keyHash,budget,catalog,r2,seedLegacy:false,
        withBackupResources:callback=>callback(), // already owns the actual outer app lease
        quietSnapshot:callback=>app.quietSnapshot(async()=>{await mark('snapshot');const value=await callback();await mark('post_snapshot_heavy');return value;}),
        statfs:async dir=>{guard();const measured=await statfs(dir),free=Number(measured.bavail)*Number(measured.bsize);
          return {...measured,bsize:1,bavail:Math.max(0,free-HOSTED_PROBE_POLICY.mockObjectBytes)};}
      });
      await mark('automatic_preflight');result=await perform(config.runId);await mark('preservation_after');
      after=await captureHostedProbePreservation(config);await write(path.join(root,'preservation-after.json'),after);
      check(json(before)===json(after),'PROBE_PRESERVATION_CHANGED');guard();
      check(result.status==='PASS'&&result.restore.status==='PASS'&&result.remoteDeletion===false&&calls.length===8,'PROBE_BACKUP_RESULT');
      memory=await observer.stop();observer=null;guard();check(!memory.error&&memory.first?.pid===process.pid&&memory.last?.pid===process.pid,'PROBE_SAMPLER_RESULT');
      const report={schemaVersion:1,status:'PASS',permitHash:config.permitHash,serviceId:config.serviceId,release:config.release,runId:config.runId,
        startedAt:start,finishedAt:Date.now(),durationMs:Date.now()-start,pid:process.pid,maxRssKiB:process.resourceUsage().maxRSS,
        policy:HOSTED_PROBE_POLICY,memory,phases,calls,backup:result,realCapacity:{...realCapacity,inventory:'local_existing_catalog_readonly',remoteInventoryQueried:false},
        sourcePreservationHash:sha(json(before)),preserved:true,
        transport:'isolated_local_disk_mock',realR2Requests:0,remoteProviderCalls:0,automaticActivated:false,published:false,instantaneousAbort:false,
        scope:'Resident app process; actual V2 codec; isolated disk-backed fake R2; phase-bound stop checks; kernel memory cap unchanged.'};
      await write(path.join(root,'report.json'),report);const pin=await digest(path.join(root,'report.json'));
      await write(path.join(root,'complete.json'),{schemaVersion:1,permitHash:config.permitHash,reportHash:pin.sha256});
      return {status:'PASS',allowAutomaticStart:true,runId:config.runId,reportHash:pin.sha256};
    }catch(e){
      if(observer){try{memory=await observer.stop();}catch{}observer=null;}
      if(before&&!after){try{after=await captureHostedProbePreservation(config);await write(path.join(root,'preservation-after-failure.json'),after);}catch{}}
      const code=/^[A-Z0-9_]+$/.test(e?.message??'')?e.message:'PROBE_FAILED';
      await write(path.join(root,'failure.json'),{schemaVersion:1,status:'FAILED_CONSUMED',code,permitHash:config.permitHash,runId:config.runId,
        startedAt:start,finishedAt:Date.now(),memory:memory??null,phases,calls,preserved:before&&after?json(before)===json(after):null,automaticActivated:false,remoteProviderCalls:0}).catch(()=>{});
      throw Error(code,{cause:e});
    }finally{r2?.close();budget?.close();catalog?.close();}
  });
}
