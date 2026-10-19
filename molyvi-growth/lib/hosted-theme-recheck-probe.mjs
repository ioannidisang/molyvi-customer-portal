import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonicalJson,IntakeError,PRIVATE_ROOT} from './intake-store.mjs';
import {createBasicThemeProgress,BASIC_THEME_PROGRESS_HOSTED_ROOT} from './basic-theme-progress.mjs';

export const HOSTED_THEME_RECHECK_PROBE_ROOT=path.join(PRIVATE_ROOT,'molyvi-hosted-staging','controlled-operations','theme-rechecks');
const KIND='molyvi_hosted_theme_recheck_probe',MODE='SYNTHETIC_PROVIDER_NO_NETWORK';
const JOBS=path.join(HOSTED_THEME_RECHECK_PROBE_ROOT,'jobs'),MAX_FILE=32*1024,MAX_FILES=96,MAX_BYTES=256*1024;
const MODULE_ROOT=path.dirname(fileURLToPath(import.meta.url));
const SOURCE_FILES=Object.freeze(['basic-theme-progress.mjs','hosted-theme-recheck-probe.mjs','hosted-theme-rechecks.mjs','intake-store.mjs','qualification.mjs']);
const IDENTITY=Object.freeze({targetStore:'molyvi-still-dev.myshopify.com',shopId:'108668748113',appId:'436878311425',installId:'1195450433873',liveThemeId:'207379235153'});
const POLICY=Object.freeze({readyAtReadCheck:3,actualNetworkAllowed:false,maximumOwnedFiles:MAX_FILES,maximumOwnedBytes:MAX_BYTES});
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(`HOSTED_THEME_PROBE_${code}`,422);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const keys=(value,list)=>value&&typeof value==='object'&&!Array.isArray(value)&&equal(Object.keys(value).sort(),list.toSorted());
const iso=value=>new Date(value).toISOString();
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&iso(Date.parse(value))===value;
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const jobPaths=jobId=>{const jobDirectory=path.join(JOBS,jobId);return {jobDirectory,configFile:path.join(jobDirectory,'config.json'),journalDirectory:path.join(jobDirectory,'journal'),receiptFile:path.join(jobDirectory,'journal','synthetic-create.json'),verificationFile:path.join(jobDirectory,'journal','verification.json')};};
const checkName=number=>`check-${String(number).padStart(3,'0')}.json`;
const nowOf=clock=>{const now=clock();if(!Number.isSafeInteger(now)||now<0)fail('CLOCK_INVALID');return now;};

function syntheticBindings(jobId,attemptId){
  const syntheticHash=label=>hash({kind:KIND,label,jobId});
  const binding={intentHash:syntheticHash('intent'),...IDENTITY,projectId:jobId,ownerHash:syntheticHash('owner'),planHash:syntheticHash('plan'),themeZipSha256:syntheticHash('no-theme-zip'),packageBytesHash:syntheticHash('no-package')};
  const themeId='990019'+BigInt('0x'+jobId.replaceAll('-','').slice(0,12)).toString().padStart(15,'0');
  return {binding,themeId,dependenciesHash:syntheticHash('no-provider-dependencies'),registryKey:hash({targetStore:binding.targetStore,projectId:binding.projectId}),schedulerBinding:{jobId,intentHash:binding.intentHash,attemptId,themeId,...IDENTITY}};
}
async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function safeDirectory(directory){
  const absolute=path.resolve(directory),root=path.parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_DIRECTORY');
  }
  return absolute;
}
async function ensureRoots(){
  await safeDirectory(PRIVATE_ROOT);let current=PRIVATE_ROOT;
  for(const part of path.relative(PRIVATE_ROOT,JOBS).split(path.sep)){
    current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await safeDirectory(current);
  }
}
async function readBytes(file,limit=MAX_FILE){
  await safeDirectory(path.dirname(file));const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)fail('UNSAFE_FILE');
  const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail('CONCURRENT_CHANGE');return bytes;
}
function parse(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_JSON');}}
async function writeNew(file,value){
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');if(bytes.length>MAX_FILE)fail('FILE_LIMIT');
  await safeDirectory(path.dirname(file));const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}return bytesHash(bytes);
}
async function sourceHashes(){
  // Deployed/source-controlled code is bound by its bytes, not by link count:
  // cloud-sync tooling may hold a hardlink to an editor's current source file.
  // The separate immutable runtime-data reader remains strictly single-link.
  await safeDirectory(MODULE_ROOT);const result={};
  for(const name of SOURCE_FILES){
    const file=path.join(MODULE_ROOT,name),before=await fs.lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.size>128*1024)fail('UNSAFE_SOURCE');
    const bytes=await fs.readFile(file),after=await fs.lstat(file);
    if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)fail('SOURCE_CHANGED');
    result[name]=bytesHash(bytes);
  }
  return result;
}
function assertConfig(config,file){
  if(!keys(config,['schemaVersion','kind','mode','jobId','createdAt','binding','progress','policy','sourceHashes','syntheticReceiptSha256','initialState'])||config.schemaVersion!==1||config.kind!==KIND||config.mode!==MODE||!uuid(config.jobId)||!validTime(config.createdAt)||!equal(config.policy,POLICY))fail('CONFIG_INVALID');
  const paths=jobPaths(config.jobId),progress=config.progress;
  if(path.resolve(file)!==paths.configFile||!keys(progress,['binding','attemptId','dependenciesHash','journalDirectory','registryKey','rootDirectory'])||!uuid(progress.attemptId))fail('CONFIG_BINDING_MISMATCH');
  const expected=syntheticBindings(config.jobId,progress.attemptId);
  if(!equal(config.binding,expected.schedulerBinding)||!equal(progress.binding,expected.binding)||progress.dependenciesHash!==expected.dependenciesHash||progress.registryKey!==expected.registryKey||progress.journalDirectory!==paths.journalDirectory||progress.rootDirectory!==BASIC_THEME_PROGRESS_HOSTED_ROOT)fail('CONFIG_BINDING_MISMATCH');
  if(!keys(config.sourceHashes,SOURCE_FILES)||!Object.values(config.sourceHashes).every(isHash)||!isHash(config.syntheticReceiptSha256)||!keys(config.initialState,['head','eventCount','deadlineAt'])||!isHash(config.initialState.head)||config.initialState.eventCount!==6||!validTime(config.initialState.deadlineAt))fail('CONFIG_PROOF_INVALID');
  return paths;
}
function checkBody(config,state,outcome,observedAt,previousCheckSha256){
  return {schemaVersion:1,kind:'molyvi_synthetic_theme_state_read',mode:MODE,jobId:config.jobId,attemptId:config.progress.attemptId,themeId:config.binding.themeId,readCheck:state.counters.readChecks,outcome,observedAt,previousCheckSha256,actualNetworkRequests:0,providerCalled:false,progressHeadBeforeResult:state.head};
}
async function ownedStats(paths,intentHash){
  let files=0,bytes=0;
  async function file(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_FILE)fail('UNSAFE_FILE');files++;bytes+=stat.size;if(files>MAX_FILES||bytes>MAX_BYTES)fail('STORAGE_LIMIT');}
  async function folder(directory){await safeDirectory(directory);for(const entry of await fs.readdir(directory,{withFileTypes:true})){const target=path.join(directory,entry.name);if(entry.isSymbolicLink())fail('UNSAFE_DIRECTORY');if(entry.isDirectory()){if(entry.name==='.writer-lock'||entry.name==='.reconcile-lock')continue;fail('UNEXPECTED_DIRECTORY');}await file(target);}}
  await safeDirectory(paths.jobDirectory);
  for(const entry of await fs.readdir(paths.jobDirectory,{withFileTypes:true})){
    if(['config.json','process-pause.json','process-finish.json','proof.json'].includes(entry.name))await file(path.join(paths.jobDirectory,entry.name));
    else if(entry.name==='journal'){if(!entry.isDirectory()||entry.isSymbolicLink())fail('UNSAFE_DIRECTORY');}
    else if(entry.name==='.reconcile-lock'){const lock=path.join(paths.jobDirectory,entry.name);await safeDirectory(lock);if((await fs.readdir(lock)).length)fail('UNEXPECTED_DIRECTORY');}
    else fail('UNEXPECTED_JOB_ENTRY');
  }
  await folder(paths.journalDirectory);await folder(path.join(BASIC_THEME_PROGRESS_HOSTED_ROOT,intentHash));
  return {files,bytes,maximumFiles:MAX_FILES,maximumBytes:MAX_BYTES,insideExistingBackupSource:true,backupRoot:'controlled-operations',backupScopeChanged:false,backupLimitsChanged:false,jobProofReportsIncluded:true};
}

/** Operator-only local fixture preparation. It creates no Shopify object.
 * Even the creation reservations and definite receipt below are explicitly
 * simulated; only the production progress persistence is exercised here. */
export async function prepareHostedThemeRecheckProbe({jobId=crypto.randomUUID(),clock=Date.now}={}){
  if(!uuid(jobId)||typeof clock!=='function')fail('PREPARATION_ARGUMENTS_INVALID');
  const paths=jobPaths(jobId),createdAt=iso(nowOf(clock)),attemptId=crypto.randomUUID(),derived=syntheticBindings(jobId,attemptId),sources=await sourceHashes();
  await ensureRoots();try{await fs.mkdir(paths.jobDirectory,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('PREPARATION_ALREADY_EXISTS');throw error;}await fs.mkdir(paths.journalDirectory,{mode:0o700});
  const progress={binding:derived.binding,attemptId,dependenciesHash:derived.dependenciesHash,journalDirectory:paths.journalDirectory,registryKey:derived.registryKey,rootDirectory:BASIC_THEME_PROGRESS_HOSTED_ROOT};
  const syntheticReceiptSha256=await writeNew(paths.receiptFile,{schemaVersion:1,kind:'molyvi_synthetic_theme_create_receipt',mode:MODE,jobId,attemptId,themeId:derived.themeId,createdAt,providerCalled:false,actualNetworkRequests:0,publication:false});
  const controller=createBasicThemeProgress({...progress,clock});await controller.begin();await controller.reserve('staged_upload');await controller.reserve('theme_create');await controller.recordCreated({themeId:derived.themeId,responseSha256:syntheticReceiptSha256});await controller.reserve('read_check');
  const checking=await controller.reserve('graphql');
  const config={schemaVersion:1,kind:KIND,mode:MODE,jobId,createdAt,binding:derived.schedulerBinding,progress,policy:{...POLICY},sourceHashes:sources,syntheticReceiptSha256,initialState:null};
  await writeNew(path.join(paths.journalDirectory,checkName(1)),checkBody(config,checking,'processing',iso(nowOf(clock)),null));
  const waiting=await controller.scheduleCheck();config.initialState={head:waiting.head,eventCount:waiting.eventCount,deadlineAt:waiting.deadlineAt};
  const configSha256=await writeNew(paths.configFile,config),storage=await ownedStats(paths,derived.binding.intentHash);
  return freeze({configFile:paths.configFile,configSha256,binding:config.binding,jobDirectory:paths.jobDirectory,progressDirectory:path.join(BASIC_THEME_PROGRESS_HOSTED_ROOT,derived.binding.intentHash),deadlineAt:waiting.deadlineAt,provenance:{mode:MODE,actualProviderCalls:0,actualNetworkRequests:0,fullInstallerVerified:false,progressCountersAreSimulated:true,storage}});
}

/** Load only an explicit hash-pinned operator fixture. No environment lookup,
 * journal scan, provider discovery, create call, adoption, credential or retry. */
export async function loadHostedThemeRecheckProbe({configFile,configSha256,clock=Date.now}={}){
  if(typeof configFile!=='string'||!isHash(configSha256)||typeof clock!=='function')fail('ACTIVATION_REQUIRED');
  const requested=path.resolve(configFile),requestedJob=path.basename(path.dirname(requested));
  if(!uuid(requestedJob)||requested!==jobPaths(requestedJob).configFile)fail('CONFIG_BINDING_MISMATCH');
  const configBytes=await readBytes(configFile);if(bytesHash(configBytes)!==configSha256)fail('CONFIG_SHA_MISMATCH');
  const config=parse(configBytes),paths=assertConfig(config,configFile);
  if(!equal(await sourceHashes(),config.sourceHashes))fail('SOURCE_CHANGED');
  const controller=createBasicThemeProgress({...config.progress,clock});
  const progressDirectory=path.join(BASIC_THEME_PROGRESS_HOSTED_ROOT,config.binding.intentHash);
  const assertBinding=binding=>{if(!equal(binding,config.binding))fail('BINDING_MISMATCH');};
  async function invariant(){
    if(bytesHash(await readBytes(paths.configFile))!==configSha256)fail('CONFIG_SHA_MISMATCH');
    if(bytesHash(await readBytes(paths.receiptFile))!==config.syntheticReceiptSha256)fail('SYNTHETIC_RECEIPT_CHANGED');
    const anchor=parse(await readBytes(path.join(progressDirectory,`${String(config.initialState.eventCount).padStart(6,'0')}.json`)));
    if(anchor.eventHash!==config.initialState.head)fail('INITIAL_PROGRESS_CHANGED');
    await ownedStats(paths,config.binding.intentHash);
  }
  async function readState(){
    await invariant();const state=await controller.read();
    if(!state||state.themeId!==config.binding.themeId||state.responseSha256!==config.syntheticReceiptSha256||state.deadlineAt!==config.initialState.deadlineAt||state.eventCount<config.initialState.eventCount||state.counters.stagedUploads!==1||state.counters.themeCreateAttempts!==1||state.counters.externalReads!==0)fail('PROGRESS_BINDING_MISMATCH');
    if(['waiting','verified'].includes(state.status)&&state.counters.graphQLRequests!==state.counters.readChecks+1)fail('SIMULATION_COUNTER_MISMATCH');
    if(state.status==='verified'){
      const receipt=await readBytes(paths.verificationFile);if(bytesHash(receipt)!==state.proofSha256)fail('VERIFICATION_RECEIPT_CHANGED');
      const report=parse(receipt);if(report.configSha256!==configSha256||report.mode!==MODE||!equal(report.binding,config.binding))fail('VERIFICATION_RECEIPT_CHANGED');
    }
    return state;
  }
  async function readDue(binding){
    assertBinding(binding);const state=await readState();
    const locked=await exists(path.join(paths.jobDirectory,'.reconcile-lock'));
    return freeze({binding:structuredClone(config.binding),status:locked?'checking':({waiting:'waiting',checking:'checking',verified:'verified',stopped:'stopped'}[state.status]??'unknown'),nextCheckAt:state.nextEligibleAt,deadlineAt:state.deadlineAt});
  }
  async function reconcileKnown(binding){
    assertBinding(binding);await invariant();const lock=path.join(paths.jobDirectory,'.reconcile-lock');
    try{await fs.mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('BUSY_OR_INTERRUPTED');throw error;}
    try{
      const before=await readState();if(before.status!=='waiting')fail('NOT_WAITING');
      if(!before.nextEligibleAt||nowOf(clock)<Date.parse(before.nextEligibleAt))fail('CHECK_NOT_DUE');
      await controller.reserve('read_check');const checking=await controller.reserve('graphql'),number=checking.counters.readChecks;
      if(number>POLICY.readyAtReadCheck)fail('SIMULATION_BUDGET_EXHAUSTED');
      const previous=await readBytes(path.join(paths.journalDirectory,checkName(number-1))),outcome=number<POLICY.readyAtReadCheck?'processing':'ready';
      await writeNew(path.join(paths.journalDirectory,checkName(number)),checkBody(config,checking,outcome,iso(nowOf(clock)),bytesHash(previous)));
      if(outcome==='processing')return await controller.scheduleCheck();
      const checks=[];for(let n=1;n<=number;n++)checks.push({readCheck:n,sha256:bytesHash(await readBytes(path.join(paths.journalDirectory,checkName(n))))});
      const proofSha256=await writeNew(paths.verificationFile,{schemaVersion:1,kind:'molyvi_synthetic_theme_recheck_verification',mode:MODE,configSha256,binding:config.binding,sourceHashes:config.sourceHashes,checks,checkedAt:iso(nowOf(clock)),progressHeadBeforeCompletion:checking.head,actualNetworkRequests:0,actualProviderCalls:0,shopifyVerified:false,fullInstallerVerified:false,progressPersistenceVerified:true,progressCountersAreSimulated:true});
      return await controller.complete({proofSha256});
    }finally{const stat=await fs.lstat(lock);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_DIRECTORY');await fs.rmdir(lock);}
  }
  async function stopJob(binding,{code}={}){
    assertBinding(binding);await invariant();if(typeof code!=='string'||!/^[A-Z][A-Z0-9_]{2,99}$/.test(code))fail('STOP_CODE_INVALID');
    try{return await controller.stop({code});}catch(error){if(error.code!=='BASIC_THEME_PROGRESS_TERMINAL_STATE')throw error;return controller.read();}
  }
  async function inspect(){
    const state=await readState();return freeze({mode:MODE,configSha256,binding:config.binding,status:state.status,themeId:state.themeId,deadlineAt:state.deadlineAt,nextCheckAt:state.nextEligibleAt,counters:state.counters,eventCount:state.eventCount,head:state.head,proofSha256:state.proofSha256,stopCode:state.stopCode,sourceHashes:config.sourceHashes,actualNetworkRequests:0,actualProviderCalls:0,shopifyVerified:false,fullInstallerVerified:false,progressPersistenceVerified:true,progressCountersAreSimulated:true,storage:await ownedStats(paths,config.binding.intentHash)});
  }
  // A late restart may load the callbacks solely so the scheduler can persist
  // a terminal stop. readDue still rejects the expired active record and no
  // reconcile is permitted; every integrity/source/binding error remains fatal.
  try{await readState();}catch(error){if(error.code!=='BASIC_THEME_PROGRESS_DEADLINE_EXCEEDED')throw error;}
  return Object.freeze({config:freeze(structuredClone(config)),binding:freeze(structuredClone(config.binding)),readDue,reconcileKnown,stopJob,inspect});
}
