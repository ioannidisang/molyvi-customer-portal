// One-use resident-app measurement. Only the disk-backed fake SDK below is
// constructed. This never reads provider credentials or activates a scheduler.
import fs from 'node:fs/promises';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {DatabaseSync} from 'node:sqlite';
import {safeName} from './backup.mjs';
import {captureHostedProbePreservation} from './hosted-memory-probe.mjs';
import {readLinuxMemorySample} from './hosted-memory-probe-sampler.mjs';
import {createGenerationBackupRun,GENERATION_AUTOMATIC_DISK_BYTES} from './generation-run.mjs';
import {GenerationCatalog} from './generation-catalog.mjs';
import {R2Budget,R2_LIMITS} from './r2-budget.mjs';
import {createR2Transport} from './r2-transport.mjs';

const SERVICE='srv-db7othjrjlhs73cg7lf0',WORKSPACE='tea-d9bnluoqmsqc7399dhfg';
const scope=Object.freeze({serviceId:SERVICE,workspaceId:WORKSPACE}),configs=new WeakSet();
const check=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),json=v=>JSON.stringify(v);
const HASH=/^[a-f0-9]{64}$/,RUN=/^auto-[0-9]{14}-[a-f0-9]{8}$/;
const CONTROL_FILES=['molyvi-r2-access/automatic.json','molyvi-r2-access/budget.sqlite','molyvi-r2-access/r2-config.json',
  'molyvi-r2-access/retention.json','molyvi-r2-automatic/retention.sqlite','molyvi-r2-automatic/schedule.sqlite'];
const OWNER_PATHS=new Set(['.photo-review-worker.lock','.product-production-worker.lock','.service-production-worker.lock'].map(n=>'workspaces/'+n+'/owner.json'));
export const HOSTED_GENERATION_PROBE_POLICY=Object.freeze({
  schemaVersion:1,limitBytes:512*1024*1024,baselineRssBytes:192*1024*1024,baselineAnonBytes:192*1024*1024,
  rssStopBytes:416*1024*1024,anonStopBytes:416*1024*1024,currentWarningBytes:496*1024*1024,
  deadlineMs:15*60*1000,mockObjectBytes:512_000_000,mockObjects:2,
  requiredFreeBytes:GENERATION_AUTOMATIC_DISK_BYTES+2*512_000_000,databaseTables:19,requestCeiling:32
});
const P=HOSTED_GENERATION_PROBE_POLICY;
function exact(v,keys,code){check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),code);}
function separate(a,b){for(const[x,y]of[[a,b],[b,a]]){const r=path.relative(x,y);check(r&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'GENERATION_PROBE_PATH_OVERLAP');}}
async function safe(file,directory=false){
  file=path.resolve(file);let at=path.parse(file).root;
  for(const bit of file.slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at);check(!s.isSymbolicLink()&&(at!==file||directory?s.isDirectory():s.isFile()&&s.nlink===1),'GENERATION_PROBE_PATH');}
  const real=await fs.realpath(file);check(real===file||process.platform==='win32'&&real.toLowerCase()===file.toLowerCase(),'GENERATION_PROBE_ALIAS');return file;
}
async function sync(dir){if(process.platform!=='win32'){const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}}
async function write(file,value){const raw=Buffer.from(JSON.stringify(value,null,2)+'\n');check(raw.length<=16*1024*1024,'GENERATION_PROBE_METADATA_LIMIT');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}await sync(path.dirname(file));return sha(raw);}
async function read(file,max=1024*1024){
  await safe(file);const before=await fs.lstat(file,{bigint:true});check(before.size>0n&&before.size<=BigInt(max),'GENERATION_PROBE_METADATA_LIMIT');
  const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const signature=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
  try{check(signature(await h.stat({bigint:true}))===signature(before),'GENERATION_PROBE_FILE_CHANGED');const raw=Buffer.alloc(Number(before.size));let used=0;
    while(used<raw.length){const r=await h.read(raw,used,Math.min(65536,raw.length-used),used);check(r.bytesRead>0,'GENERATION_PROBE_FILE_CHANGED');used+=r.bytesRead;}
    check((await h.read(Buffer.alloc(1),0,1,used)).bytesRead===0,'GENERATION_PROBE_FILE_CHANGED');await safe(file);
    check(signature(await h.stat({bigint:true}))===signature(before)&&signature(await fs.lstat(file,{bigint:true}))===signature(before),'GENERATION_PROBE_FILE_CHANGED');
    return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),hash:sha(raw)};
  }finally{await h.close();}
}
async function absent(file){try{await fs.lstat(file);check(false,'GENERATION_PROBE_ACTIVATION_PRESENT');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function activationAbsent(source){const base=path.dirname(source);for(const file of ['molyvi-r2-access/reference-format.json','molyvi-r2-access/generation-format.json','molyvi-r2-automatic/generations.sqlite','molyvi-r2-automatic/generations.sqlite.initialized.json'])await absent(path.join(base,file));}
async function databaseState(file){
  await safe(file);const db=new DatabaseSync(file,{readOnly:true}),quote=s=>'"'+s.replaceAll('"','""')+'"';
  try{
    check(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'GENERATION_PROBE_DATABASE_INVALID');
    const bound=db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(sql AS BLOB))),0) bytes FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get();
    check(bound.n<=256&&bound.bytes<=1024*1024,'GENERATION_PROBE_DATABASE_LIMIT');
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const names=schema.filter(r=>r.type==='table').map(r=>r.name).sort();check(names.length===P.databaseTables,'GENERATION_PROBE_DATABASE_TABLES');
    const tables=[];
    for(const name of names){check(/^[a-z_]+$/.test(name),'GENERATION_PROBE_DATABASE_TABLE');const columns=db.prepare('PRAGMA table_info('+quote(name)+')').all();check(columns.length>0&&columns.length<=128,'GENERATION_PROBE_DATABASE_LIMIT');
      const sizes=columns.map(c=>'coalesce(length(CAST('+quote(c.name)+' AS BLOB)),0)').join('+');check(!db.prepare('SELECT 1 FROM '+quote(name)+' WHERE '+sizes+'>? LIMIT 1').get(4*1024*1024),'GENERATION_PROBE_DATABASE_ROW_LIMIT');
      let rows=0;const h=crypto.createHash('sha256');for(const row of db.prepare('SELECT * FROM '+quote(name)+' ORDER BY rowid').iterate()){check(++rows<=1_000_000,'GENERATION_PROBE_DATABASE_LIMIT');h.update(json(row)+'\n');}tables.push({table:name,rows,sha256:h.digest('hex')});
    }
    return {schemaHash:sha(json(schema)),tables,userVersion:db.prepare('PRAGMA user_version').get().user_version};
  }finally{db.close();}
}
async function legacyRows(source){
  const file=path.join(path.dirname(source),'molyvi-r2-automatic/retention.sqlite');await safe(file);const db=new DatabaseSync(file,{readOnly:true});
  try{check(db.prepare("SELECT count(*) n FROM deletions WHERE status!='confirmed_absent'").get().n===0&&db.prepare("SELECT count(*) n FROM plans WHERE status!='complete'").get().n===0,'GENERATION_PROBE_RETENTION_UNSETTLED');
    const rows=db.prepare("SELECT key,bytes,etag FROM backups WHERE status='active' ORDER BY key LIMIT 21").all().map(r=>({...r}));check(rows.length<=R2_LIMITS.objects,'GENERATION_PROBE_LEGACY_LIMIT');
    for(const row of rows){safeName(row.key);check(!row.key.startsWith('generations/')&&Number.isSafeInteger(row.bytes)&&row.bytes>0&&typeof row.etag==='string'&&row.etag.length>0&&row.etag.length<=200,'GENERATION_PROBE_LEGACY_INVALID');}return rows;
  }finally{db.close();}
}
export async function captureHostedGenerationProbePreservation({source,probeRoot}){
  await activationAbsent(source);const legacy=await legacyRows(source),prior=await captureHostedProbePreservation({source,probeRoot});
  check(legacy.reduce((n,r)=>n+r.bytes,0)===prior.controls.retained.storedBytes&&legacy.length===prior.controls.retained.objects,'GENERATION_PROBE_LEGACY_CHANGED');
  return {...prior,files:prior.files.filter(p=>!OWNER_PATHS.has(p.file)),applicationSemantic:await databaseState(path.join(source,'accounts/customers.sqlite')),
    legacyMetadata:legacy,generationActivationAbsent:true,excludedWorkerOwnerPaths:[...OWNER_PATHS]};
}
function validatePermit(v,{serviceId,release}){
  exact(v,['schemaVersion','kind','serviceId','workspaceId','release','runId','expiresAt','controls','sourcePins'],'GENERATION_PROBE_PERMIT_FIELDS');
  check(v.schemaVersion===1&&v.kind==='molyvi_resident_generation_memory_once_v1'&&v.serviceId===SERVICE&&serviceId===SERVICE&&v.workspaceId===WORKSPACE&&v.release===release&&/^[a-f0-9]{40}$/.test(release)&&RUN.test(v.runId),'GENERATION_PROBE_PERMIT_SCOPE');
  check(Number.isSafeInteger(v.expiresAt)&&v.expiresAt>0,'GENERATION_PROBE_PERMIT_EXPIRY');
  check(Array.isArray(v.controls)&&v.controls.length===6&&v.controls.map(x=>x.file).sort().join(',')===[...CONTROL_FILES].sort().join(','),'GENERATION_PROBE_CONTROL_PINS');
  for(const pin of v.controls){exact(pin,['file','sha256'],'GENERATION_PROBE_CONTROL_PINS');check(HASH.test(pin.sha256),'GENERATION_PROBE_CONTROL_PINS');}
  check(Array.isArray(v.sourcePins)&&v.sourcePins.length>0&&v.sourcePins.length<=4096,'GENERATION_PROBE_SOURCE_PINS');const names=new Set();
  for(const pin of v.sourcePins){exact(pin,['file','bytes','sha256'],'GENERATION_PROBE_SOURCE_PINS');safeName(pin.file);check(!names.has(pin.file)&&!OWNER_PATHS.has(pin.file)&&pin.file!=='accounts/customers.sqlite'&&!/-wal$|-shm$/.test(pin.file)&&Number.isSafeInteger(pin.bytes)&&pin.bytes>=0&&HASH.test(pin.sha256),'GENERATION_PROBE_SOURCE_PINS');names.add(pin.file);}
}
async function current(config){
  const p=await read(config.permitFile);check(p.hash===config.permitHash,'GENERATION_PROBE_PERMIT_CHANGED');validatePermit(p.value,config);check(Date.now()<p.value.expiresAt,'GENERATION_PROBE_PERMIT_EXPIRED');
  const captured=await captureHostedGenerationProbePreservation(config);
  check(json(captured.files)===json(p.value.sourcePins),'GENERATION_PROBE_SOURCE_PIN_CHANGED');for(const pin of p.value.controls)check(captured.controls.files.find(f=>f.file===pin.file)?.sha256===pin.sha256,'GENERATION_PROBE_CONTROL_CHANGED');
  const schedule=captured.controls.databases.find(d=>d.file.endsWith('/schedule.sqlite')).schedule;check(schedule.next_at>Date.now()+P.deadlineMs,'GENERATION_PROBE_SCHEDULE_TOO_SOON');return captured;
}
export async function loadHostedGenerationProbe({permitFile,source,probeRoot,release,serviceId}){
  permitFile=path.resolve(permitFile);source=path.resolve(source);probeRoot=path.resolve(probeRoot);
  try{await fs.lstat(permitFile);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(permitFile===path.join(probeRoot,'permit.json')&&path.dirname(source)===path.dirname(probeRoot),'GENERATION_PROBE_ROOT_SCOPE');separate(source,probeRoot);await safe(probeRoot,true);await safe(source,true);
  const p=await read(permitFile);validatePermit(p.value,{release,serviceId});const config=Object.freeze({permitFile,source,probeRoot,release,serviceId,permitHash:p.hash,runId:p.value.runId});configs.add(config);
  try{await fs.lstat(path.join(probeRoot,'attempt.json'));}catch(e){if(e.code!=='ENOENT')throw e;check(json((await fs.readdir(probeRoot)).sort())===json(['permit.json']),'GENERATION_PROBE_NOT_FRESH');await current(config);}return config;
}
async function priorOutcome(config){
  let a;try{a=await read(path.join(config.probeRoot,'attempt.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(a.value.permitHash===config.permitHash&&a.value.release===config.release&&a.value.runId===config.runId,'GENERATION_PROBE_ATTEMPT_CONFLICT');
  try{await fs.lstat(path.join(config.probeRoot,'failure.json'));return {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:false,runId:config.runId};}catch(e){if(e.code!=='ENOENT')throw e;}
  try{const c=await read(path.join(config.probeRoot,'complete.json')),r=await read(path.join(config.probeRoot,'report.json'),16*1024*1024);
    check(c.value.permitHash===config.permitHash&&c.value.attemptHash===a.hash&&c.value.reportHash===r.hash&&r.value.status==='PASS'&&r.value.permitHash===config.permitHash&&r.value.runId===config.runId&&r.value.realR2Requests===0&&r.value.automaticActivated===false,'GENERATION_PROBE_COMPLETION_INVALID');
    return {status:'SKIP_VERIFIED_PASS',allowAutomaticStart:true,runId:config.runId,reportHash:r.hash};
  }catch(e){if(e.code!=='ENOENT')throw e;return {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:false,runId:config.runId};}
}
async function startSampler({root,deadline,flags}){
  check(process.platform==='linux','GENERATION_PROBE_LINUX_REQUIRED');const initial=await readLinuxMemorySample();check(initial.limitBytes===P.limitBytes,'GENERATION_PROBE_CGROUP_LIMIT');
  check(initial.rssBytes<=P.baselineRssBytes&&initial.nonreclaimableEstimateBytes<=P.baselineAnonBytes,'GENERATION_PROBE_INITIAL_MEMORY');check((initial.events.oom??0)===0&&(initial.events.oom_kill??0)===0,'GENERATION_PROBE_EXISTING_OOM');
  const worker=new Worker(new URL('./hosted-memory-probe-sampler.mjs',import.meta.url),{workerData:{shared:flags.buffer,logFile:path.join(root,'memory-samples.jsonl'),deadline,policy:P,initial,cgroup:'/sys/fs/cgroup',proc:'/proc',pid:process.pid,threadLabel:'generation-memory-observer'},resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4,stackSizeMb:1}});
  let readyResolve,readyReject,finishResolve,finishReject,done=false;const ready=new Promise((a,b)=>{readyResolve=a;readyReject=b;}),finished=new Promise((a,b)=>{finishResolve=a;finishReject=b;});finished.catch(()=>{});
  worker.on('message',m=>{if(m.type==='ready')readyResolve(m.sample);if(m.type==='complete'){done=true;readyReject(Error(m.error??'GENERATION_PROBE_SAMPLER_STOPPED'));finishResolve(m);}});
  worker.on('error',e=>{Atomics.compareExchange(flags,1,0,4);readyReject(e);finishReject(e);});worker.on('exit',code=>{if(!done){const e=Error('GENERATION_PROBE_SAMPLER_EXIT_'+code);Atomics.compareExchange(flags,1,0,4);readyReject(e);finishReject(e);}});await ready;
  return {initial,async stop(){Atomics.store(flags,0,1);return finished;}};
}
function diskSdk({directory,legacy,mark,guard,calls,afterRestore}){
  const objects=new Map(legacy.map(r=>[r.key,{...r,unmanaged:true}])),sdk={};let added=0,restored=false;
  for(const kind of ['HeadObject','PutObject','GetObject','ListObjectsV2','DeleteObject'])sdk[kind+'Command']=class{constructor(input){this.input=input;this.kind=kind;}};
  sdk.S3Client=class{
    async send(command){guard();const{kind,input:i}=command;check(calls.length<P.requestCeiling,'GENERATION_PROBE_MOCK_REQUEST_LIMIT');check(i.Bucket==='molyvi-private-backups'&&!i.ACL,'GENERATION_PROBE_MOCK_SCOPE');await mark('mock_'+kind);calls.push({sequence:calls.length+1,kind,at:Date.now()});const item=objects.get(i.Key);
      if(kind==='ListObjectsV2'){
        // The first LIST after two downloads occurs only after strict restore.
        // This fake-provider observation is local test instrumentation, not a
        // callback or new authority added to the production generation runner.
        if(!restored&&calls.filter(c=>c.kind==='GetObject').length===2){await afterRestore();restored=true;}
        return {Contents:[...objects].map(([Key,o])=>({Key,Size:o.bytes,ETag:o.etag})),IsTruncated:false};
      }
      check(!item?.unmanaged,'GENERATION_PROBE_LEGACY_READ_FORBIDDEN');
      if(kind==='HeadObject'){if(!item)throw {$metadata:{httpStatusCode:404}};return {ContentLength:item.bytes,Metadata:item.metadata,ETag:item.etag};}
      if(kind==='PutObject'){
        check(!item&&added<P.mockObjects&&i.IfNoneMatch==='*'&&i.ContentLength<=P.mockObjectBytes,'GENERATION_PROBE_MOCK_UPLOAD');
        const file=path.join(directory,sha(i.Key)+'.mlvb'),h=crypto.createHash('sha256');let bytes=0;
        const limit=new Transform({highWaterMark:65536,transform(chunk,_e,cb){try{guard();bytes+=chunk.length;check(bytes<=i.ContentLength,'GENERATION_PROBE_MOCK_LENGTH');h.update(chunk);cb(null,chunk);}catch(e){cb(e);}}});
        await pipeline(i.Body,limit,createWriteStream(file,{flags:'wx',mode:0o600,highWaterMark:65536}));guard();check(bytes===i.ContentLength,'GENERATION_PROBE_MOCK_LENGTH');
        const etag='"local-'+h.digest('hex')+'"';objects.set(i.Key,{bytes,metadata:{...i.Metadata},etag,file});added++;return {ETag:etag};
      }
      if(kind==='GetObject'){check(item,'GENERATION_PROBE_MOCK_MISSING');return {ContentLength:item.bytes,Metadata:item.metadata,ETag:item.etag,Body:createReadStream(item.file,{highWaterMark:65536})};}
      throw Error('GENERATION_PROBE_DELETE_FORBIDDEN');
    }
    destroy(){}
  };return sdk;
}
export function createHostedGenerationProbeRunnerForTests({sampler=startSampler,statfs=fs.statfs}={}){return({app,config})=>run({app,config,sampler,statfs});}
export function runHostedGenerationProbe({app,config}){return run({app,config,sampler:startSampler,statfs:fs.statfs});}
function run({app,config,sampler,statfs}){
  check(configs.has(config),'GENERATION_PROBE_GENUINE_CONFIG');check(typeof app?.withBackupResources==='function'&&typeof app?.quietSnapshot==='function','GENERATION_PROBE_RESIDENT_APP_REQUIRED');
  return app.withBackupResources(async()=>{
    const prior=await priorOutcome(config);if(prior)return prior;
    check(json((await fs.readdir(config.probeRoot)).sort())===json(['permit.json']),'GENERATION_PROBE_NOT_FRESH');
    const root=config.probeRoot,start=Date.now(),deadline=start+P.deadlineMs,flags=new Int32Array(new SharedArrayBuffer(12));
    const attemptHash=await write(path.join(root,'attempt.json'),{schemaVersion:1,permitHash:config.permitHash,release:config.release,runId:config.runId,startedAt:start,pid:process.pid});
    let observer,budget,catalog,before,after,memory,result,capacity,snapshotSemantic,restoredSemantic;const phases=[],calls=[];
    const guard=()=>{check(Date.now()<=deadline,'GENERATION_PROBE_DEADLINE');const reason=Atomics.load(flags,1);check(reason===0,['','GENERATION_PROBE_DEADLINE','GENERATION_PROBE_MEMORY_STOP','GENERATION_PROBE_OOM','GENERATION_PROBE_SAMPLER_FAILED'][reason]??'GENERATION_PROBE_STOP');};
    const mark=async phase=>{guard();check(phases.length<100,'GENERATION_PROBE_PHASE_LIMIT');phases.push({phase,sequence:phases.length+1,at:Date.now()});Atomics.store(flags,2,phases.length);};
    try{
      observer=await sampler({root,deadline,flags});await mark('preservation_before');before=await current(config);await write(path.join(root,'preservation-before.json'),before);
      const disk=await statfs(root);check(Number(disk.bavail)*Number(disk.bsize)>=P.requiredFreeBytes,'GENERATION_PROBE_LOCAL_DISK_LIMIT');
      const runs=path.join(root,'runs'),mock=path.join(root,'mock-remote');await fs.mkdir(runs,{mode:0o700});await fs.mkdir(mock,{mode:0o700});await sync(root);
      const keyFile=path.join(root,'probe-key.bin'),key=crypto.randomBytes(32),keyHash=sha(key),h=await fs.open(keyFile,'wx',0o600);try{await h.writeFile(key);await h.sync();}finally{await h.close();key.fill(0);}await sync(root);
      budget=await new R2Budget(path.join(root,'probe-budget.sqlite')).ready();const initialUsage=before.controls.usage;
      if(Object.values(initialUsage).some(n=>n>0))budget.reserve(initialUsage);
      catalog=await new GenerationCatalog(path.join(root,'probe-generations.sqlite'),{scope}).ready();catalog.importLegacy([]);
      const dir=path.join(runs,config.runId);
      const sdk=diskSdk({directory:mock,legacy:before.legacyMetadata,mark,guard,calls,afterRestore:async()=>{
        await mark('restored_database_semantics');restoredSemantic=await databaseState(path.join(dir,'restored/accounts/customers.sqlite'));
        check(json(restoredSemantic)===json(snapshotSemantic)&&json(restoredSemantic)===json(before.applicationSemantic),'GENERATION_PROBE_RESTORED_DATABASE_CHANGED');
        await write(path.join(root,'restored-database.json'),restoredSemantic);
      }});
      const perform=createGenerationBackupRun({source:config.source,root:runs,release:config.release,keyFile,keyHash,scope,budget,catalog,
        withBackupResources:fn=>fn(),quietSnapshot:fn=>app.quietSnapshot(async()=>{await mark('snapshot');const value=await fn();snapshotSemantic=await databaseState(path.join(dir,'snapshot/accounts/customers.sqlite'));check(json(snapshotSemantic)===json(before.applicationSemantic),'GENERATION_PROBE_SNAPSHOT_DATABASE_CHANGED');await write(path.join(root,'snapshot-database.json'),snapshotSemantic);await mark('post_snapshot_heavy');return value;}),
        statfs:async p=>{guard();const d=await statfs(p);return {...d,bsize:1,bavail:Math.max(0,Number(d.bavail)*Number(d.bsize)-P.mockObjects*P.mockObjectBytes)};},
        r2Factory:async options=>{
          await mark('ciphertext_capacity');const base=await fs.lstat(path.join(dir,'base.mlvb')),overlay=await fs.lstat(path.join(dir,'overlay.mlvb')),bytes=base.size+overlay.size;
          capacity={scope:'MOCK_PROTOCOL_WITH_LOCAL_LEGACY_METADATA',inventory:'constructed_from_current_local_catalog_metadata',remoteInventoryQueried:false,remoteAdmissionReady:false,activationReady:false,usage:{...initialUsage},existing:{...before.controls.retained},newCiphertext:{baseBytes:base.size,overlayBytes:overlay.size},
            // Initial LIST + two four-call uploads + two GETs + post-restore
            // LIST + two retained HEADs + final LIST. No deletion is permitted.
            required:{requests:1+2*4+2+1+2+1,uploadBytes:bytes,downloadBytes:bytes,storedBytes:bytes,objects:2}};
          capacity.admitted=initialUsage.requests+capacity.required.requests<=R2_LIMITS.requests&&initialUsage.uploadBytes+bytes<=R2_LIMITS.uploadBytes&&initialUsage.downloadBytes+bytes<=R2_LIMITS.downloadBytes&&before.controls.retained.storedBytes+bytes<=R2_LIMITS.storedBytes&&before.controls.retained.objects+2<=R2_LIMITS.objects;
          check(capacity.admitted,'GENERATION_PROBE_REAL_CAPACITY_REFUSED');await write(path.join(root,'capacity.json'),capacity);return createR2Transport({accountId:'f'.repeat(32),bucket:'molyvi-private-backups',jurisdiction:'eu',accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)},{...options,sdk});
        }});
      await mark('generation_run');result=await perform(config.runId);await mark('preservation_after');
      after=await captureHostedGenerationProbePreservation(config);await write(path.join(root,'preservation-after.json'),after);check(json(before)===json(after),'GENERATION_PROBE_PRESERVATION_CHANGED');guard();
      check(result.status==='PASS'&&result.restore.status==='PASS'&&result.restore.mailSent===false&&result.restore.liveStorageOverwritten===false&&restoredSemantic&&result.retention.deleted.length===0&&calls.length===capacity.required.requests,'GENERATION_PROBE_RESULT');
      memory=await observer.stop();observer=null;guard();check(!memory.error&&memory.first?.pid===process.pid&&memory.last?.pid===process.pid,'GENERATION_PROBE_SAMPLER_RESULT');
      const report={schemaVersion:1,status:'PASS',permitHash:config.permitHash,scope,release:config.release,runId:config.runId,startedAt:start,finishedAt:Date.now(),durationMs:Date.now()-start,pid:process.pid,maxRssKiB:process.resourceUsage().maxRSS,
        policy:P,memory,phases,calls,backup:result,capacity,initialUsageCopiedConservativelyAtNow:{...initialUsage},databaseSemanticHash:sha(json(restoredSemantic)),sourcePreservationHash:sha(json(before)),preserved:true,
        transport:'isolated_local_disk_mock',realR2Requests:0,remoteProviderCalls:0,automaticActivated:false,published:false,instantaneousAbort:false,
        scopeNote:'Resident application; actual base/overlay runner and full restore. Unmanaged legacy rows are local-catalog metadata only; no live R2 inventory. Temporary random probe key, not production recovery-key verification. Phase-bound stops; no instantaneous interruption guarantee.'};
      const reportHash=await write(path.join(root,'report.json'),report);await write(path.join(root,'complete.json'),{schemaVersion:1,permitHash:config.permitHash,attemptHash,reportHash});return {status:'PASS',allowAutomaticStart:true,runId:config.runId,reportHash};
    }catch(error){
      if(observer){try{memory=await observer.stop();}catch{}observer=null;}
      if(before&&!after)try{after=await captureHostedGenerationProbePreservation(config);await write(path.join(root,'preservation-after-failure.json'),after);}catch{}
      const code=/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'GENERATION_PROBE_FAILED';await write(path.join(root,'failure.json'),{schemaVersion:1,status:'FAILED_CONSUMED',code,permitHash:config.permitHash,runId:config.runId,startedAt:start,finishedAt:Date.now(),memory:memory??null,phases,calls,preserved:before&&after?json(before)===json(after):null,automaticActivated:false,remoteProviderCalls:0}).catch(()=>{});throw Error(code,{cause:error});
    }finally{budget?.close();catalog?.close();}
  });
}
