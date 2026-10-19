import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';

const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(`BASIC_THEME_PROGRESS_${code}`,422);};
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isId=value=>typeof value==='string'&&/^[1-9][0-9]{0,24}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&equal(Object.keys(value).sort(),expected.toSorted());
const iso=value=>new Date(value).toISOString();
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&iso(Date.parse(value))===value;
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const eventName=sequence=>`${String(sequence).padStart(6,'0')}.json`;
const MAX_FILE_BYTES=64*1024,MAX_EVENTS=1024;
const BACKOFF=Object.freeze([1000,2000,4000,8000,15000,30000]);
export const BASIC_THEME_PROGRESS_ROOT=path.join(WORKSPACE_ROOT,'briefs','molyvi-basic-installer-runtime','theme-progress');
export const BASIC_THEME_PROGRESS_HOSTED_ROOT=path.join(WORKSPACE_ROOT,'briefs','molyvi-hosted-staging','controlled-operations','theme-rechecks','progress');
export const BASIC_THEME_PROGRESS_INSTALLER_HOSTED_ROOT=path.join(WORKSPACE_ROOT,'briefs','molyvi-hosted-staging','controlled-operations','basic-installer','runtime','theme-progress');
const INSTALLER_HOSTED_ROOT=path.dirname(path.dirname(BASIC_THEME_PROGRESS_INSTALLER_HOSTED_ROOT));
const INSTALLER_HOSTED_PROFILE='hosted_basic_v1';
export const BASIC_THEME_PROGRESS_PREPARED_HOSTED_ROOT=path.join(WORKSPACE_ROOT,'briefs','molyvi-hosted-staging','controlled-operations','basic-prepared-installer','runtime','theme-progress');
const PREPARED_HOSTED_ROOT=path.dirname(path.dirname(BASIC_THEME_PROGRESS_PREPARED_HOSTED_ROOT));
const PREPARED_HOSTED_PROFILE='hosted_prepared_basic_v1';
export const BASIC_THEME_PROGRESS_LIMITS=Object.freeze({graphQLRequests:160,externalRequests:256,stagedUploads:1,themeCreateAttempts:1,readChecks:12,elapsedMs:15*60*1000});
const BINDING_KEYS=['intentHash','targetStore','projectId','ownerHash','planHash','themeZipSha256','packageBytesHash','shopId','appId','installId','liveThemeId'];

function normalize(input){
  const {binding,attemptId,dependenciesHash,journalDirectory,registryKey}=structuredClone(input);
  if(!keys(binding,BINDING_KEYS)||!['intentHash','ownerHash','planHash','themeZipSha256','packageBytesHash'].every(key=>isHash(binding[key]))||!uuid(binding.projectId)||binding.targetStore!=='molyvi-still-dev.myshopify.com'||binding.shopId!=='108668748113'||binding.appId!=='436878311425'||binding.installId!=='1195450433873'||binding.liveThemeId!=='207379235153')fail('BINDING_MISMATCH');
  if(!uuid(attemptId)||!isHash(dependenciesHash)||registryKey!==hash({targetStore:binding.targetStore,projectId:binding.projectId}))fail('CLAIM_BINDING_MISMATCH');
  if(typeof journalDirectory!=='string'||!journalDirectory||/[\x00-\x1f]/.test(journalDirectory))fail('JOURNAL_DIRECTORY_REQUIRED');
  const absolute=path.resolve(journalDirectory);
  if(!['briefs','customer-materials'].some(name=>inside(path.join(WORKSPACE_ROOT,name),absolute))||[BASIC_THEME_PROGRESS_ROOT,BASIC_THEME_PROGRESS_HOSTED_ROOT,BASIC_THEME_PROGRESS_INSTALLER_HOSTED_ROOT].some(root=>absolute===root||inside(root,absolute)))fail('JOURNAL_DIRECTORY_REQUIRED');
  return {binding,attemptId,dependenciesHash,journalDirectory:absolute,registryKey};
}
async function safeDirectory(directory){
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=await fs.lstat(current);
    if(stat.isSymbolicLink()||!stat.isDirectory())fail('UNSAFE_DIRECTORY');
  }
  return absolute;
}
async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function readFile(file){
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.size>MAX_FILE_BYTES)fail('UNSAFE_FILE');
  const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail('CONCURRENT_CHANGE');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('CORRUPT_RECORD');}
  return {value,sha256:bytesHash(bytes)};
}
async function writeNew(file,value){
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');if(bytes.length>MAX_FILE_BYTES)fail('FILE_LIMIT');
  const handle=await fs.open(file,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function ensureRoot(rootDirectory){
  const privateRoot=path.join(WORKSPACE_ROOT,'briefs');await safeDirectory(privateRoot);
  let directory=privateRoot;
  for(const part of path.relative(privateRoot,rootDirectory).split(path.sep)){
    directory=path.join(directory,part);
    try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    await safeDirectory(directory);
  }
}
function initial(record){return {binding:structuredClone(record.binding),attemptId:record.attemptId,dependenciesHash:record.dependenciesHash,journalDirectory:record.journalDirectory,registryKey:record.registryKey,status:'started',themeId:null,responseSha256:null,proofSha256:null,stopCode:null,begunAt:record.begunAt,lastObservedAt:record.begunAt,deadlineAt:record.deadlineAt,nextEligibleAt:null,counters:{graphQLRequests:0,externalReads:0,stagedUploads:0,themeCreateAttempts:0,readChecks:0},eventCount:0,head:record.recordHash};}
function active(state){if(['verified','stopped'].includes(state.status))fail('TERMINAL_STATE');}
function clockCheck(state,now,{allowExpired=false}={}){
  if(now<Date.parse(state.lastObservedAt))fail('CLOCK_ROLLBACK');
  if(!allowExpired&&now>=Date.parse(state.deadlineAt))fail('DEADLINE_EXCEEDED');
}
function applyEvent(state,event){
  if(!validTime(event.observedAt))fail('CORRUPT_RECORD');
  const now=Date.parse(event.observedAt);clockCheck(state,now,{allowExpired:event.type==='stop'});active(state);
  if(event.type==='reserve'){
    const counters={...state.counters},kind=event.kind;
    if(state.nextEligibleAt&&now<Date.parse(state.nextEligibleAt))fail('CHECK_NOT_DUE');
    if(kind==='graphql')counters.graphQLRequests++;
    else if(kind==='external_read'){if(!state.themeId)fail('DEFINITE_THEME_ID_REQUIRED');counters.externalReads++;}
    else if(kind==='staged_upload'){if(state.themeId||counters.themeCreateAttempts)fail('INVALID_TRANSITION');counters.stagedUploads++;}
    else if(kind==='theme_create'){
      if(state.themeId||counters.stagedUploads!==1)fail('INVALID_TRANSITION');
      counters.themeCreateAttempts++;counters.graphQLRequests++;
    }else if(kind==='read_check'){
      if(!state.themeId)fail('DEFINITE_THEME_ID_REQUIRED');
      counters.readChecks++;state.status='checking';state.nextEligibleAt=null;
    }else fail('RESERVATION_KIND_INVALID');
    if(counters.graphQLRequests>BASIC_THEME_PROGRESS_LIMITS.graphQLRequests||counters.externalReads+counters.stagedUploads>BASIC_THEME_PROGRESS_LIMITS.externalRequests||counters.stagedUploads>BASIC_THEME_PROGRESS_LIMITS.stagedUploads||counters.themeCreateAttempts>BASIC_THEME_PROGRESS_LIMITS.themeCreateAttempts||counters.readChecks>BASIC_THEME_PROGRESS_LIMITS.readChecks)fail('BUDGET_EXHAUSTED');
    state.counters=counters;
  }else if(event.type==='created'){
    if(state.themeId||state.status!=='started'||state.counters.themeCreateAttempts!==1||state.counters.stagedUploads!==1||!isId(event.themeId)||event.themeId===state.binding.liveThemeId||!isHash(event.responseSha256))fail('DEFINITE_RECEIPT_INVALID');
    state.themeId=event.themeId;state.responseSha256=event.responseSha256;state.status='created';
  }else if(event.type==='scheduled'){
    const expected=iso(now+BACKOFF[Math.min(state.counters.readChecks-1,BACKOFF.length-1)]);
    if(state.status!=='checking'||!state.themeId||state.counters.readChecks<1||event.nextEligibleAt!==expected)fail('INVALID_TRANSITION');
    state.nextEligibleAt=expected;state.status='waiting';
  }else if(event.type==='complete'){
    if(state.status!=='checking'||!state.themeId||state.counters.readChecks<1||!isHash(event.proofSha256))fail('VERIFICATION_PROOF_REQUIRED');
    state.proofSha256=event.proofSha256;state.status='verified';state.nextEligibleAt=null;
  }else if(event.type==='stop'){
    if(typeof event.code!=='string'||!/^[A-Z][A-Z0-9_]{2,99}$/.test(event.code))fail('STOP_CODE_INVALID');
    state.stopCode=event.code;state.status='stopped';
  }else fail('CORRUPT_RECORD');
  state.lastObservedAt=event.observedAt;
}
async function readState(directory,expected,{locked=false}={}){
  await safeDirectory(directory);await safeDirectory(expected.journalDirectory);
  const entries=await fs.readdir(directory),events=entries.filter(name=>/^\d{6}\.json$/.test(name)).sort();
  if(entries.includes('.writer-lock')&&!locked)fail('BUSY_OR_INTERRUPTED_LOCK');
  if(entries.some(name=>!['record.json','head.json','.writer-lock'].includes(name)&&!events.includes(name))||events.length>MAX_EVENTS)fail('INTERRUPTED_OR_CORRUPT_RECORD');
  const loaded=await readFile(path.join(directory,'record.json')),record=loaded.value,{recordHash,...body}=record??{};
  if(recordHash!==hash(body)||body.schemaVersion!==1||body.kind!=='molyvi_basic_theme_progress'||!equal(Object.fromEntries(Object.keys(expected).map(key=>[key,body[key]])),expected)||!equal(body.limits,BASIC_THEME_PROGRESS_LIMITS)||!validTime(body.begunAt)||body.deadlineAt!==iso(Date.parse(body.begunAt)+BASIC_THEME_PROGRESS_LIMITS.elapsedMs))fail('BINDING_OR_RECORD_MISMATCH');
  const headBefore=await readFile(path.join(directory,'head.json')),checkpoint=headBefore.value;
  if(checkpoint.intentHash!==expected.binding.intentHash||checkpoint.sequence!==events.length||!isHash(checkpoint.eventHash))fail('HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  const state=initial(record);
  for(const [index,name]of events.entries()){
    if(name!==eventName(index+1))fail('CORRUPT_RECORD');
    const {eventHash,...event}=(await readFile(path.join(directory,name))).value;
    if(eventHash!==hash(event)||event.sequence!==index+1||event.previousHash!==state.head||event.intentHash!==expected.binding.intentHash||event.attemptId!==expected.attemptId)fail('CORRUPT_RECORD');
    applyEvent(state,event);state.head=eventHash;state.eventCount++;
  }
  if(state.head!==checkpoint.eventHash)fail('HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  const headAfter=await readFile(path.join(directory,'head.json'));
  if(headBefore.sha256!==headAfter.sha256||!equal((await fs.readdir(directory)).sort(),entries.sort())||(!locked&&await exists(path.join(directory,'.writer-lock'))))fail('CONCURRENT_CHANGE');
  return state;
}
async function replaceHead(directory){
  const source=path.join(directory,'head.next.json'),target=path.join(directory,'head.json');
  const beforeSource=await readFile(source),beforeTarget=await readFile(target),delays=[20,50,100,200];
  if(beforeSource.value.sequence!==beforeTarget.value.sequence+1||beforeSource.value.intentHash!==beforeTarget.value.intentHash)fail('HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  for(let attempt=0;;attempt++){
    if((await readFile(source)).sha256!==beforeSource.sha256||(await readFile(target)).sha256!==beforeTarget.sha256)fail('CONCURRENT_CHANGE');
    try{await fs.rename(source,target);return;}catch(error){if(!['EPERM','EBUSY'].includes(error.code)||attempt>=delays.length)throw error;await new Promise(resolve=>setTimeout(resolve,delays[attempt]));}
  }
}

/**
 * Local, trusted-adapter progress only. The installation journal remains the
 * authority for completion. A definite ID is recorded only by the adapter
 * after validating its create response; this module cannot certify that a
 * caller actually contacted Shopify. No credential, URL, raw response, API
 * call, cleanup, reset, adoption or background scheduler is provided here.
 * Counters begin after the journal claim, before before-apply preflight; the
 * bounded pre-claim preflight is outside this attempt's cumulative counters.
 */
export function createBasicThemeProgress({binding,attemptId,dependenciesHash,journalDirectory,registryKey,runtimeProfile,rootDirectory=BASIC_THEME_PROGRESS_ROOT,clock=Date.now}={}){
  const expected=normalize({binding,attemptId,dependenciesHash,journalDirectory,registryKey});
  if(runtimeProfile!==undefined&&![INSTALLER_HOSTED_PROFILE,PREPARED_HOSTED_PROFILE].includes(runtimeProfile))fail('RUNTIME_PROFILE_INVALID');
  const allowedRoots=runtimeProfile===INSTALLER_HOSTED_PROFILE?[BASIC_THEME_PROGRESS_INSTALLER_HOSTED_ROOT]:runtimeProfile===PREPARED_HOSTED_PROFILE?[BASIC_THEME_PROGRESS_PREPARED_HOSTED_ROOT]:[BASIC_THEME_PROGRESS_ROOT,BASIC_THEME_PROGRESS_HOSTED_ROOT];
  if(typeof rootDirectory!=='string'||!allowedRoots.includes(path.resolve(rootDirectory)))fail('ROOT_DIRECTORY_NOT_ALLOWED');
  const progressRoot=path.resolve(rootDirectory);
  // Keep historical default records byte-compatible; hosted records also bind
  // their one explicitly permitted location inside the existing backup source.
  if(progressRoot===BASIC_THEME_PROGRESS_HOSTED_ROOT)expected.progressRoot=progressRoot;
  if(runtimeProfile===INSTALLER_HOSTED_PROFILE){
    if(!['journal','continuation-journal'].some(name=>expected.journalDirectory===path.join(INSTALLER_HOSTED_ROOT,'jobs',expected.binding.projectId,name)))fail('JOURNAL_DIRECTORY_REQUIRED');
    expected.runtimeProfile=runtimeProfile;expected.progressRoot=progressRoot;
  }else if(runtimeProfile===PREPARED_HOSTED_PROFILE){
    if(expected.journalDirectory!==path.join(PREPARED_HOSTED_ROOT,'jobs',expected.binding.projectId,'journal'))fail('JOURNAL_DIRECTORY_REQUIRED');
    expected.runtimeProfile=runtimeProfile;expected.progressRoot=progressRoot;
  }else if([INSTALLER_HOSTED_ROOT,PREPARED_HOSTED_ROOT].some(root=>expected.journalDirectory===root||inside(root,expected.journalDirectory)))fail('RUNTIME_PROFILE_REQUIRED');
  if(typeof clock!=='function')fail('CLOCK_REQUIRED');
  const directory=path.join(progressRoot,expected.binding.intentHash);
  const now=()=>{const value=clock();if(!Number.isSafeInteger(value)||value<0||value>8_000_000_000_000_000)fail('CLOCK_INVALID');return value;};
  const safe=work=>async(...args)=>{try{return freeze(structuredClone(await work(...args)));}catch(error){if(error instanceof IntakeError)throw error;fail('STORAGE_UNAVAILABLE');}};
  async function read(){
    if(!await exists(directory))return null;
    const state=await readState(directory,expected);clockCheck(state,now(),{allowExpired:['verified','stopped'].includes(state.status)});return state;
  }
  async function begin(){
    await safeDirectory(expected.journalDirectory);await ensureRoot(progressRoot);
    try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('ALREADY_BEGUN');throw error;}
    const started=now(),body={schemaVersion:1,kind:'molyvi_basic_theme_progress',...expected,limits:{...BASIC_THEME_PROGRESS_LIMITS},begunAt:iso(started),deadlineAt:iso(started+BASIC_THEME_PROGRESS_LIMITS.elapsedMs)},record={...body,recordHash:hash(body)};
    await writeNew(path.join(directory,'record.json'),record);
    await writeNew(path.join(directory,'head.json'),{intentHash:expected.binding.intentHash,sequence:0,eventHash:record.recordHash});
    return initial(record);
  }
  async function mutate(build,{allowExpired=false}={}){
    await safeDirectory(directory);await safeDirectory(expected.journalDirectory);
    const lock=path.join(directory,'.writer-lock');
    try{await fs.mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('BUSY_OR_INTERRUPTED_LOCK');throw error;}
    try{
      const state=await readState(directory,expected,{locked:true}),observed=now();clockCheck(state,observed,{allowExpired});
      const event={...build(structuredClone(state),observed),observedAt:iso(observed),intentHash:expected.binding.intentHash,attemptId:expected.attemptId,sequence:state.eventCount+1,previousHash:state.head};
      if(event.sequence>MAX_EVENTS)fail('EVENT_LIMIT');applyEvent(state,event);const eventHash=hash(event);
      // High-water checkpoint first: any interruption stays fail-closed.
      await writeNew(path.join(directory,'head.next.json'),{intentHash:expected.binding.intentHash,sequence:event.sequence,eventHash});
      await writeNew(path.join(directory,eventName(event.sequence)),{...event,eventHash});
      await replaceHead(directory);
      state.eventCount=event.sequence;state.head=eventHash;return state;
    }finally{
      const stat=await fs.lstat(lock);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_DIRECTORY');await fs.rmdir(lock);
    }
  }
  return Object.freeze({
    begin:safe(begin),read:safe(read),
    reserve:safe(kind=>mutate(()=>({type:'reserve',kind}))),
    recordCreated:safe(input=>{const {themeId,responseSha256}=structuredClone(input??{});return mutate(()=>({type:'created',themeId,responseSha256}));}),
    scheduleCheck:safe(()=>mutate((state,observed)=>{if(state.status!=='checking'||state.counters.readChecks<1)fail('INVALID_TRANSITION');return {type:'scheduled',nextEligibleAt:iso(observed+BACKOFF[Math.min(state.counters.readChecks-1,BACKOFF.length-1)])};})),
    // Call only after the independently verified installation receipt commits.
    complete:safe(input=>{const {proofSha256}=structuredClone(input??{});return mutate(()=>({type:'complete',proofSha256}));}),
    stop:safe(input=>{const {code}=structuredClone(input??{});return mutate(()=>({type:'stop',code}),{allowExpired:true});})
  });
}
