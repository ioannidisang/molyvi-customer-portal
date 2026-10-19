// Exact-job filesystem evidence only. No application imports, locks, token/key
// reads, provider calls, retries, initialization or file writes.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const BASE='/opt/render/project/src/briefs',STORAGE=BASE+'/molyvi-hosted-staging';
const ROOT=STORAGE+'/controlled-operations/basic-installer';
const JOB='9e1bfcc0-1f1c-41f2-a369-1ad65b0fad9a',PROJECT='6018a065-af86-4e4b-8f67-730e1adb3519';
const PACKAGE='2a1a942a0083f9f8160611f5c004d75229cdb222a3887f5e09052b21db244431';
const ZIP='b2e3f0e931f777307ee03a83aa32d0707e9c12423ebd8c58c3c91786b7690d69';
const IDENTITY={targetStore:'molyvi-still-dev.myshopify.com',shopId:'108668748113',appId:'436878311425',installId:'1195450433873',liveThemeId:'207379235153'};
const SERVICE='srv-db7othjrjlhs73cg7lf0',DIRECTORY=ROOT+'/jobs/'+PROJECT,ACCESS=BASE+'/molyvi-basic-installer-access';
const MAX_BYTES=16*1024*1024,MAX_FILES=3000,MAX_FILE=3*1024*1024,MAX_RECORD=128*1024;
const LIMITS={graphQLRequests:250,mutations:24,stagedUploads:4,externalRequests:300,events:640,ownedBytes:8*1024*1024,elapsedMs:3600000};
const PROGRESS_LIMITS={graphQLRequests:160,externalRequests:256,stagedUploads:1,themeCreateAttempts:1,readChecks:12,elapsedMs:900000};
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonical(v));
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code});};
const need=(v,code)=>{if(!v)fail(code);};
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const numeric=v=>typeof v==='string'&&/^[1-9][0-9]{0,24}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const key=v=>typeof v==='string'&&/^[A-Za-z0-9_:.-]{1,180}$/.test(v);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const signature=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
async function ordinary(file,directory=false){
  let current=path.parse(file).root;
  for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current);need(!s.isSymbolicLink()&&(current!==file||directory?s.isDirectory():s.isFile()),'UNSAFE_PATH');}
  need(await fs.realpath(file)===file,'REALPATH_MISMATCH');
}
async function present(file){try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

export function summarizeEventChain(records,{initialHash,intentHash,kind}){
  need(digest(initialHash)&&digest(intentHash)&&['journal','operations','progress'].includes(kind)&&Array.isArray(records)&&records.length<=1024,'CHAIN_ARGUMENTS');
  const allowed=kind==='journal'?['claim','receipt','reconcile','block']:kind==='operations'?['install','reserve','wait','recheck','verify','stop']:['reserve','created','scheduled','complete','stop'];
  let previous=initialHash,observed=null;const events=[],counters={graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0},resources=[];
  for(const [index,record]of records.entries()){
    const {eventHash,...event}=record;
    need(digest(eventHash)&&eventHash===hash(event)&&event.previousHash===previous&&event.sequence===index+1&&event.intentHash===intentHash&&allowed.includes(event.type),'CHAIN_INTEGRITY');
    const row={sequence:event.sequence,type:event.type,eventHash};
    if(event.observedAt!==undefined){need(date(event.observedAt)&&(!observed||event.observedAt>=observed),'EVENT_TIME');observed=event.observedAt;row.observedAt=event.observedAt;}
    if(event.key!==undefined){need(key(event.key),'EVENT_KEY');row.key=event.key;}
    if(event.attemptId!==undefined){need(uuid(event.attemptId),'EVENT_ATTEMPT');row.attemptId=event.attemptId;}
    if(event.kind!==undefined){need(['graphql','mutation','upload','external','external_read','staged_upload','theme_create','read_check'].includes(event.kind),'EVENT_KIND');row.kind=event.kind;}
    if(event.code!==undefined){need(typeof event.code==='string'&&/^[A-Z][A-Z0-9_]{2,99}$/.test(event.code),'EVENT_CODE');row.code=event.code;}
    if(event.themeId!==undefined){need(numeric(event.themeId)&&![IDENTITY.liveThemeId,'208782819665'].includes(event.themeId),'THEME_ID');row.themeId=event.themeId;}
    for(const name of ['responseSha256','proofSha256','operationSha256'])if(event[name]!==undefined){need(digest(event[name]),'EVENT_DIGEST');row[name]=event[name];}
    if(event.nextEligibleAt!==undefined){need(date(event.nextEligibleAt),'EVENT_DATE');row.nextEligibleAt=event.nextEligibleAt;}
    if(event.waiting!==undefined){const w=event.waiting;need(numeric(w.themeId)&&uuid(w.attemptId)&&date(w.nextCheckAt)&&date(w.deadlineAt),'WAITING_INVALID');row.waiting={themeId:w.themeId,attemptId:w.attemptId,nextCheckAt:w.nextCheckAt,deadlineAt:w.deadlineAt};}
    if(event.receipt!==undefined){const r=event.receipt;need(numeric(r.remoteId)&&digest(r.payloadHash)&&r.observed&&typeof r.observed==='object','RECEIPT_INVALID');row.receipt={remoteId:r.remoteId,payloadHash:r.payloadHash,receiptSha256:hash(r),observedSha256:hash(r.observed)};
      if(r.observed.variants!==undefined){need(Array.isArray(r.observed.variants)&&r.observed.variants.length<=100&&r.observed.variants.every(v=>numeric(v.remoteId)),'VARIANT_IDS');row.receipt.variantIds=r.observed.variants.map(v=>v.remoteId);}
      resources.push({key:row.key,...row.receipt});
    }
    if(kind==='operations'&&event.type==='reserve'){
      need(['graphql','mutation','upload','external'].includes(event.kind),'BUDGET_KIND');
      if(['graphql','mutation'].includes(event.kind))counters.graphQLRequests++;if(event.kind==='mutation')counters.mutations++;if(event.kind==='upload'){counters.stagedUploads++;counters.externalRequests++;}if(event.kind==='external')counters.externalRequests++;
    }
    events.push(row);previous=eventHash;
  }
  return {eventCount:events.length,head:previous,hashChainVerified:true,events,resources,...(kind==='operations'?{counters}:{}),providerStateIndependentlyQueried:false};
}

export async function collectHostedBasicInstallation(){
  need(process.platform==='linux'&&process.env.RENDER_SERVICE_ID===SERVICE,'EXACT_RENDER_SERVICE_REQUIRED');
  need(process.env.MOLYVI_PRIVATE_STORAGE===STORAGE&&/^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT??''),'EXACT_RELEASE_STORAGE_REQUIRED');
  const startedAt=new Date().toISOString(),deadline=Date.now()+120000,files=new Map(),directories=new Map();let scannedBytes=0;
  const time=()=>need(Date.now()<=deadline,'READ_TIMEOUT');
  async function read(file,limit=MAX_RECORD){
    time();if(files.has(file)){const saved=files.get(file);need(saved.bytes<=limit,'FILE_LIMIT');return saved.data;}
    await ordinary(file);const before=await fs.lstat(file,{bigint:true});need(before.isFile()&&before.nlink===1n&&before.size>=0n&&before.size<=BigInt(limit),'FILE_TYPE_OR_SIZE');
    need(files.size<MAX_FILES&&scannedBytes+Number(before.size)<=MAX_BYTES,'SCAN_LIMIT');
    const fd=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let data;
    try{need(signature(await fd.stat({bigint:true}))===signature(before),'FILE_CHANGED');data=await fd.readFile();need(data.length===Number(before.size)&&signature(await fd.stat({bigint:true}))===signature(before),'FILE_CHANGED');}finally{await fd.close();}
    need(signature(await fs.lstat(file,{bigint:true}))===signature(before),'FILE_REPLACED');
    files.set(file,{bytes:data.length,sha256:sha(data),signature:signature(before),data});scannedBytes+=data.length;return data;
  }
  async function json(file){let v;try{v=JSON.parse((await read(file)).toString('utf8'));}catch(e){if(e.safeCode)throw e;fail('JSON_INVALID');}need(v&&typeof v==='object'&&!Array.isArray(v),'JSON_OBJECT_REQUIRED');return v;}
  async function list(dir){time();await ordinary(dir,true);const rows=(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>{need(!e.isSymbolicLink()&&(e.isDirectory()||e.isFile()),'TREE_TYPE');return [e.name,e.isDirectory()?'directory':'file'];});directories.set(dir,rows);return rows;}
  async function tree(dir){for(const [name,type]of await list(dir)){need(!name.includes('lock')&&!name.endsWith('.next.json'),'BUSY_OR_INTERRUPTED');const file=path.join(dir,name);if(type==='directory')await tree(file);else await read(file,MAX_FILE);}}
  async function chain(dir,initialHash,intentHash,kind){
    const names=(await list(dir)).map(([name])=>name),events=names.filter(n=>/^\d{6}\.json$/.test(n)).sort();
    const metadata=kind==='journal'?['intent.json','head.json']:kind==='progress'?['record.json','head.json']:['head.json'];
    need(names.every(n=>metadata.includes(n)||events.includes(n))&&events.every((n,i)=>n===String(i+1).padStart(6,'0')+'.json'),'CHAIN_INVENTORY');
    const rows=[];for(const n of events)rows.push(await json(path.join(dir,n)));const result=summarizeEventChain(rows,{initialHash,intentHash,kind}),head=await json(path.join(dir,'head.json'));
    need(head.intentHash===intentHash&&head.sequence===result.eventCount&&head.eventHash===result.head,'HEAD_MISMATCH');return result;
  }
  async function privateMetadata(){
    const out={rootOutsideApplicationBackup:true,credentialOrPrivateKeyOpened:false,present:await present(ACCESS),runPresent:false,entries:[]};if(!out.present)return out;
    for(const dir of [ACCESS,ACCESS+'/'+JOB]){
      if(!await present(dir)){need(dir!==ACCESS,'PRIVATE_ROOT_MISSING');return out;}await ordinary(dir,true);const s=await fs.lstat(dir);need((s.mode&0o777)===0o700&&s.uid===process.getuid(),'PRIVATE_DIRECTORY_PERMISSIONS');
    }
    out.runPresent=true;const allowed=['private-key.pem','receiver.json','accept-attempt.json','credential.json','accepted.json'];
    for(const e of await fs.readdir(ACCESS+'/'+JOB,{withFileTypes:true})){
      need(allowed.includes(e.name),'PRIVATE_UNEXPECTED_ENTRY');const file=ACCESS+'/'+JOB+'/'+e.name;await ordinary(file);const s=await fs.lstat(file);need(s.isFile()&&s.nlink===1&&(s.mode&0o777)===0o600&&s.uid===process.getuid(),'PRIVATE_FILE_PERMISSIONS');out.entries.push({name:e.name,mode:'0600',currentUserOwner:true,singleLink:true,contentRead:false});
    }
    out.entries.sort((a,b)=>a.name.localeCompare(b.name));return out;
  }
  const result={schemaVersion:1,status:'READ_ONLY_EXACT_JOB_CAPTURED',startedAt,serviceId:SERVICE,release:process.env.RENDER_GIT_COMMIT,jobId:JOB,projectId:PROJECT,packageSha256:PACKAGE,identity:IDENTITY,jobPresent:await present(DIRECTORY),privateAccess:await privateMetadata()};
  if(result.jobPresent){
    need((await list(DIRECTORY)).every(([name])=>['config.json','bundle.json','fresh-preflight.json','journal','operations','readbacks'].includes(name)),'JOB_INVENTORY');await tree(DIRECTORY);const config=await json(DIRECTORY+'/config.json');
    need(config.kind==='molyvi_hosted_basic_installation'&&config.runtimeProfile==='hosted_basic_v1'&&config.jobId===JOB&&config.projectId===PROJECT&&config.bundleSha256===PACKAGE&&canonical(config.identity)===canonical(IDENTITY)&&config.publicationAuthorized===false&&config.newChargesAuthorized===false&&digest(config.intentHash)&&digest(config.authorizationSha256)&&date(config.preparedAt)&&date(config.deadlineAt)&&canonical(config.limits)===canonical(LIMITS)&&config.syntheticInput===true,'CONFIG_BINDING');
    need(sha(await read(DIRECTORY+'/bundle.json',MAX_FILE))===PACKAGE,'BUNDLE_HASH');
    result.config={sha256:sha(await read(DIRECTORY+'/config.json')),intentHash:config.intentHash,authorizationSha256:config.authorizationSha256,limits:config.limits,preparedAt:config.preparedAt,deadlineAt:config.deadlineAt,syntheticInput:config.syntheticInput,publicationAuthorized:false,newChargesAuthorized:false};
    const intent=await json(DIRECTORY+'/journal/intent.json'),{intentHash,...unsigned}=intent;
    need(intentHash===config.intentHash&&hash(unsigned)===intentHash&&intent.projectId===PROJECT&&intent.targetStore===IDENTITY.targetStore&&intent.themeZipSha256===ZIP&&intent.liveThemeId===IDENTITY.liveThemeId&&intent.registryDirectory===ROOT+'/runtime/registry'&&intent.registryKey===hash({targetStore:IDENTITY.targetStore,projectId:PROJECT}),'INTENT_BINDING');
    result.journal=await chain(DIRECTORY+'/journal',intentHash,intentHash,'journal');
    result.operations=await chain(DIRECTORY+'/operations',hash(config),intentHash,'operations');
    const registryFile=ROOT+'/runtime/registry/'+intent.registryKey+'.json',registry=await json(registryFile);need(registry.intentHash===intentHash&&registry.projectId===PROJECT&&registry.journalDirectory===DIRECTORY+'/journal','REGISTRY_BINDING');result.registry={sha256:sha(await read(registryFile)),key:intent.registryKey,intentHash};
    const progressDir=ROOT+'/runtime/theme-progress/'+intentHash;result.progress={present:await present(progressDir)};
    if(result.progress.present){await tree(progressDir);const record=await json(progressDir+'/record.json'),{recordHash,...recordBody}=record;need(hash(recordBody)===recordHash&&record.binding?.intentHash===intentHash&&record.binding.projectId===PROJECT&&record.journalDirectory===DIRECTORY+'/journal'&&record.registryKey===intent.registryKey&&uuid(record.attemptId)&&digest(record.dependenciesHash)&&date(record.begunAt)&&date(record.deadlineAt)&&canonical(record.limits)===canonical(PROGRESS_LIMITS),'PROGRESS_BINDING');result.progress={present:true,attemptId:record.attemptId,dependenciesHash:record.dependenciesHash,begunAt:record.begunAt,deadlineAt:record.deadlineAt,limits:record.limits,...await chain(progressDir,recordHash,intentHash,'progress')};}
    result.readbacks=[];for(const [name,type]of await list(DIRECTORY+'/readbacks')){need(type==='file'&&/^[a-f0-9-]{36}\.json$/.test(name),'READBACK_NAME');const p=await json(DIRECTORY+'/readbacks/'+name);need(p.kind==='molyvi_hosted_basic_readback_digest'&&p.intentHash===intentHash&&key(p.key)&&uuid(p.attemptId)&&uuid(p.readRequestId)&&name===p.readRequestId+'.json'&&numeric(p.remoteId)&&digest(p.payloadHash)&&digest(p.readbackSha256)&&date(p.observedAt)&&(p.provenanceSha256===null||digest(p.provenanceSha256)),'READBACK_BINDING');result.readbacks.push({key:p.key,attemptId:p.attemptId,readRequestId:p.readRequestId,remoteId:p.remoteId,payloadHash:p.payloadHash,readbackSha256:p.readbackSha256,provenanceSha256:p.provenanceSha256,observedAt:p.observedAt,fileSha256:sha(await read(DIRECTORY+'/readbacks/'+name))});}
    if(await present(ROOT+'/activation.json')){const a=await json(ROOT+'/activation.json');need(a.jobId===JOB&&a.projectId===PROJECT&&a.packageSha256===PACKAGE&&a.configSha256===result.config.sha256&&digest(a.receiverSha256),'ACTIVATION_BINDING');result.activation={present:true,sha256:sha(await read(ROOT+'/activation.json')),configSha256:a.configSha256,receiverSha256:a.receiverSha256};}else result.activation={present:false};
  }
  for(const [file,record]of files){time();need(signature(await fs.lstat(file,{bigint:true}))===record.signature,'SNAPSHOT_CHANGED');}
  for(const [dir,rows]of directories){time();const current=(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>[e.name,e.isDirectory()?'directory':e.isFile()?'file':'other']);need(canonical(rows)===canonical(current),'INVENTORY_CHANGED');}
  const inventory=[...files].map(([file,r])=>({path:path.relative(ROOT,file).split(path.sep).join('/'),bytes:r.bytes,sha256:r.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  result.sourceInventory={scope:'exact_job_plus_its_registry_progress_activation_only',files:inventory.length,bytes:scannedBytes,manifestSha256:hash(inventory),entries:inventory};
  result.inspection={fileWrites:0,applicationImports:0,locksAcquired:0,networkRequests:0,credentialOrPrivateKeyContentRead:false,privatePermissionMetadataOnly:true,independentProviderVerification:false,globalLegacyStateIncluded:false,globallyAtomicSnapshot:false,perFileAndInventoryStable:true,backupScopeChanged:false,backupLimitsChanged:false};
  result.finishedAt=new Date().toISOString();return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{need(process.argv.length===3&&['--read-only','--gzip-base64'].includes(process.argv[2]),'READ_ONLY_ARGUMENT_REQUIRED');const value=JSON.stringify(await collectHostedBasicInstallation());console.log(process.argv[2]==='--gzip-base64'?JSON.stringify({encoding:'gzip-base64',sha256:sha(value),data:gzipSync(value).toString('base64')}):value);}
  catch(e){console.log(JSON.stringify({status:'STOP',code:e.safeCode??'READ_ONLY_CAPTURE_FAILED',fileWrites:0,networkRequests:0,credentialContentRead:false}));process.exitCode=1;}
}
