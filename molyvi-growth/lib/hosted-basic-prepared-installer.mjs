import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalJson,IntakeError,PRIVATE_ROOT} from './intake-store.mjs';
import {createHostedThemeRechecks} from './hosted-theme-rechecks.mjs';

// Separate opt-in profile for a customer-confirmed, immutable Basic package.
// The historical one-product profile and its activation are not modified.
// Importing this module never reads a credential or starts provider work.
export const HOSTED_PREPARED_BASIC_INSTALLER_ROOT=path.join(PRIVATE_ROOT,'molyvi-hosted-staging','controlled-operations','basic-prepared-installer');
export const HOSTED_PREPARED_BASIC_INSTALLER_JOBS_ROOT=path.join(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,'jobs');
export const HOSTED_PREPARED_BASIC_INSTALLER_ACTIVATION_FILE=path.join(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,'activation.json');
export const HOSTED_PREPARED_BASIC_INSTALLER_LIMITS=Object.freeze({graphQLRequests:700,mutations:130,stagedUploads:31,externalRequests:800,events:1600,ownedBytes:8*1024*1024,elapsedMs:60*60*1000});
const PROFILE='hosted_prepared_basic_v1',KIND='molyvi_hosted_prepared_basic_installation';
const IDENTITY=Object.freeze({targetStore:'molyvi-still-dev.myshopify.com',shopId:'108668748113',appId:'436878311425',installId:'1195450433873',liveThemeId:'207379235153'});
const LOCATION='125398417745',ENDPOINT=`https://${IDENTITY.targetStore}/admin/api/2026-10/graphql.json`;
const REGISTRY=path.join(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,'runtime','registry');
const PROGRESS=path.join(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,'runtime','theme-progress');
const MAX_BUNDLE=3*1024*1024,MAX_RECORD=32*1024;
// Leave room for one bounded controller/journal/evidence commit between two
// checks. This is part of the same 8 MiB ceiling, not additional disk budget.
const WRITE_ALLOWANCE=256*1024;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),hash=value=>sha(canonicalJson(value));
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const numeric=value=>typeof value==='string'&&/^[1-9][0-9]{0,24}$/.test(value);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fail=code=>{throw new IntakeError(`HOSTED_PREPARED_BASIC_INSTALLER_${code}`,422);};
const inside=(a,b)=>{const r=path.relative(a,b);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
const frozen=value=>Object.freeze(structuredClone(value));
const confirmationKeys=['requestId','sourceHash','requestHash','projectId','ownerHash','planHash','themeZipSha256'];
function checkedConfirmation(value){
  if(!value||!equal(Object.keys(value).sort(),[...confirmationKeys].sort())||!uuid(value.requestId)||!uuid(value.projectId)||!confirmationKeys.filter(k=>!['requestId','projectId'].includes(k)).every(k=>isHash(value[k])))fail('CONFIRMATION_REQUIRED');
  if(value.projectId==='6018a065-af86-4e4b-8f67-730e1adb3519')fail('COMPLETED_FIXTURE_FORBIDDEN');
  return structuredClone(value);
}
const nowOf=clock=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)fail('CLOCK_INVALID');return n;};
const iso=n=>new Date(n).toISOString();
const jobPaths=projectId=>{const directory=path.join(HOSTED_PREPARED_BASIC_INSTALLER_JOBS_ROOT,projectId);return {directory,configFile:path.join(directory,'config.json'),bundleFile:path.join(directory,'bundle.json'),journalDirectory:path.join(directory,'journal'),ledgerDirectory:path.join(directory,'operations'),evidenceDirectory:path.join(directory,'readbacks')};};

async function safeDirectory(directory){
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_DIRECTORY');}
  return absolute;
}
async function ensure(directory){
  if(directory!==HOSTED_PREPARED_BASIC_INSTALLER_ROOT&&!inside(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,directory))fail('DIRECTORY_SCOPE');
  await safeDirectory(PRIVATE_ROOT);let current=PRIVATE_ROOT;
  for(const part of path.relative(PRIVATE_ROOT,directory).split(path.sep)){current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await safeDirectory(current);}
}
async function readBytes(file,max=MAX_RECORD,{singleLink=true,parentChecked=false}={}){
  if(!parentChecked)await safeDirectory(path.dirname(file));const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(singleLink&&stat.nlink!==1)||stat.size>max)fail('UNSAFE_FILE');
  const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail('FILE_CHANGED');return bytes;
}
function parse(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_JSON');}}
async function writeNew(file,value,{raw=false,max=MAX_RECORD}={}){
  const bytes=raw?value:Buffer.from(JSON.stringify(value,null,2)+'\n');if(!Buffer.isBuffer(bytes)||bytes.length>max)fail('FILE_LIMIT');
  await safeDirectory(path.dirname(file));const fd=await fs.open(file,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}return sha(bytes);
}
function decodeBase64(value){if(typeof value!=='string'||value.length>MAX_BUNDLE||!value.length||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('PACKAGE_ENCODING');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)fail('PACKAGE_ENCODING');return bytes;}
async function bundleFrom(bytes){
  const input=parse(bytes);if(input?.schemaVersion!==1||input.kind!=='molyvi_prepared_basic_bundle'||!uuid(input.ownerId)||!uuid(input.plan?.projectId)||input.plan.targetStore!==IDENTITY.targetStore||!Array.isArray(input.uploads)||input.uploads.length<3||input.uploads.length>31)fail('PACKAGE_SCOPE');
  const confirmation=checkedConfirmation(input.confirmation);
  const prepared={plan:input.plan,uploads:input.uploads.map(item=>({...item,bytes:decodeBase64(item.bytes)}))},theme={manifest:input.theme?.manifest,zipBytes:decodeBase64(input.theme?.zipBytes)};
  const {verifyBasicStorePackage}=await import('./basic-store-package.mjs');verifyBasicStorePackage(prepared);
  const products=prepared.plan.products.length,photos=prepared.plan.products.reduce((n,p)=>n+p.photos.length,0),variants=prepared.plan.products.reduce((n,p)=>n+p.variants.length,0);
  if(products<1||products>10||photos+(prepared.plan.branding.logoFile?1:0)!==input.uploads.length||photos>30||variants<products||variants>100||prepared.plan.pages.length!==7||theme.manifest?.zip?.sha256!==sha(theme.zipBytes)||theme.manifest?.projectId!==prepared.plan.projectId||theme.manifest?.planHash!==prepared.plan.planHash)fail('PACKAGE_SCOPE');
  if(confirmation.projectId!==prepared.plan.projectId||confirmation.ownerHash!==hash(input.ownerId)||confirmation.ownerHash!==prepared.plan.binding.ownerHash||confirmation.planHash!==prepared.plan.planHash||confirmation.themeZipSha256!==sha(theme.zipBytes))fail('CONFIRMATION_BINDING');
  const counts={products,variants,photos,pages:7,steps:2*products+photos+9,plannedMutations:2*products+3*photos+10,plannedUploads:photos+1};
  if(counts.plannedMutations>HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.mutations||counts.plannedUploads>HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.stagedUploads)fail('PACKAGE_BUDGET');
  return {prepared,theme,ownerId:input.ownerId,confirmation,counts};
}
function sourceBinding(state){const i=state.intent;return {intentHash:state.intentHash,targetStore:i.targetStore,projectId:i.projectId,ownerHash:i.ownerHash,planHash:i.planHash,themeZipSha256:i.themeZipSha256,packageBytesHash:i.packageBytesHash};}
function contextFor(bundle){return {projectId:bundle.prepared.plan.projectId,ownerId:bundle.ownerId,targetStore:IDENTITY.targetStore,planHash:bundle.prepared.plan.planHash,themeZipSha256:sha(bundle.theme.zipBytes)};}
function validateConfig(config,file){
  if(config?.schemaVersion!==1||config.kind!==KIND||config.runtimeProfile!==PROFILE||!uuid(config.jobId)||!uuid(config.projectId)||!isHash(config.bundleSha256)||!isHash(config.intentHash)||!isHash(config.authorizationSha256)||!equal(config.identity,IDENTITY)||!equal(config.limits,HOSTED_PREPARED_BASIC_INSTALLER_LIMITS)||config.publicationAuthorized!==false||config.newChargesAuthorized!==false||!validTime(config.preparedAt)||!validTime(config.deadlineAt)||Date.parse(config.deadlineAt)-Date.parse(config.preparedAt)!==HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.elapsedMs||typeof config.operatorId!=='string'||!config.operatorId||config.operatorId.length>200||/[\x00-\x1f]/.test(config.operatorId)||path.resolve(file)!==jobPaths(config.projectId).configFile)fail('CONFIG_BINDING');
  if(checkedConfirmation(config.confirmation).projectId!==config.projectId)fail('CONFIG_BINDING');
  return config;
}

/** The caller supplies a fresh, independently recorded scope preflight and the
 * actual operator authorization hash. This prepares private state only; no
 * network, activation, credential storage or provider action occurs here. */
export async function prepareHostedPreparedBasicInstallation({bundleFile,bundleSha256,jobId,authorizationSha256,operatorId,preflightEvidence,confirmation,clock=Date.now}={}){
  if(!isHash(bundleSha256)||!isHash(authorizationSha256)||!uuid(jobId)||typeof operatorId!=='string'||!operatorId||operatorId.length>200||/[\x00-\x1f]/.test(operatorId))fail('AUTHORIZATION_REQUIRED');
  if(typeof bundleFile!=='string'||!['briefs','customer-materials'].some(name=>inside(path.join(path.dirname(PRIVATE_ROOT),name),path.resolve(bundleFile))))fail('PACKAGE_LOCATION');
  const bytes=await readBytes(path.resolve(bundleFile),MAX_BUNDLE,{singleLink:false});if(sha(bytes)!==bundleSha256)fail('PACKAGE_SHA_MISMATCH');
  const bundle=await bundleFrom(bytes),context=contextFor(bundle),paths=jobPaths(context.projectId),now=nowOf(clock);
  if(!equal(bundle.confirmation,checkedConfirmation(confirmation)))fail('CONFIRMATION_BINDING');
  await ensure(HOSTED_PREPARED_BASIC_INSTALLER_JOBS_ROOT);await ensure(REGISTRY);
  try{await fs.mkdir(paths.directory,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('ALREADY_PREPARED');throw e;}
  await fs.mkdir(paths.ledgerDirectory,{mode:0o700});await fs.mkdir(paths.evidenceDirectory,{mode:0o700});
  await writeNew(paths.bundleFile,bytes,{raw:true,max:MAX_BUNDLE});
  const {createBasicInstallation}=await import('./basic-installation.mjs');
  const state=await createBasicInstallation({runtimeProfile:PROFILE,directory:paths.journalDirectory,registryDirectory:REGISTRY,prepared:bundle.prepared,theme:bundle.theme,context,authorization:{projectId:context.projectId,ownerHash:bundle.prepared.plan.binding.ownerHash,targetStore:IDENTITY.targetStore,planHash:context.planHash,createOnly:true,publicationAuthorized:false,newChargesAuthorized:false,referenceSha256:authorizationSha256},preflightEvidence,liveThemeId:IDENTITY.liveThemeId,inventoryLocationId:LOCATION,currency:'EUR'});
  if(state.intent.steps.length!==bundle.counts.steps||state.intent.runtimeProfile!==PROFILE)fail('HOSTED_PROFILE_REQUIRED');
  const config={schemaVersion:1,kind:KIND,runtimeProfile:PROFILE,jobId,projectId:context.projectId,bundleSha256,intentHash:state.intentHash,authorizationSha256,operatorId,identity:IDENTITY,limits:HOSTED_PREPARED_BASIC_INSTALLER_LIMITS,confirmation:bundle.confirmation,counts:bundle.counts,publicationAuthorized:false,newChargesAuthorized:false,preparedAt:iso(now),deadlineAt:iso(now+HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.elapsedMs)};
  validateConfig(config,paths.configFile);const configSha256=await writeNew(paths.configFile,config);
  await writeNew(path.join(paths.ledgerDirectory,'head.json'),{intentHash:config.intentHash,sequence:0,eventHash:hash(config)});
  await ownedBytes(paths.directory,config);
  return frozen({configFile:paths.configFile,configSha256,jobId,projectId:context.projectId,journalDirectory:paths.journalDirectory,intentHash:state.intentHash});
}

const initialLedger=config=>({sequence:0,head:hash(config),phase:'prepared',lastObservedAt:config.preparedAt,counters:{graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0},waiting:null,stopCode:null});
const eventName=n=>`${String(n).padStart(6,'0')}.json`;
function applyLedger(state,event,config){
  const {eventHash,...body}=event??{};
  if(!isHash(eventHash)||eventHash!==hash(body)||body.sequence!==state.sequence+1||body.previousHash!==state.head||body.intentHash!==config.intentHash||!validTime(body.observedAt)||Date.parse(body.observedAt)<Date.parse(state.lastObservedAt)||!['install','reserve','wait','recheck','verify','stop'].includes(body.type))fail('LEDGER_CORRUPT');
  if(['verified','stopped'].includes(state.phase))fail('LEDGER_TERMINAL');
  if(body.type!=='stop'&&Date.parse(body.observedAt)>=Date.parse(config.deadlineAt))fail('DEADLINE_EXCEEDED');
  if(body.type==='install'){if(state.phase!=='prepared')fail('LEDGER_TRANSITION');state.phase='installing';}
  if(body.type==='reserve'){
    if(!['installing','rechecking'].includes(state.phase)||!['graphql','mutation','upload','external'].includes(body.kind))fail('LEDGER_TRANSITION');
    const counters={...state.counters};if(['graphql','mutation'].includes(body.kind))counters.graphQLRequests++;if(body.kind==='mutation')counters.mutations++;if(body.kind==='upload'){counters.stagedUploads++;counters.externalRequests++;}if(body.kind==='external')counters.externalRequests++;
    for(const key of Object.keys(counters))if(counters[key]>HOSTED_PREPARED_BASIC_INSTALLER_LIMITS[key])fail('BUDGET_EXHAUSTED');state.counters=counters;
  }
  if(body.type==='wait'){
    if(!['installing','rechecking'].includes(state.phase)||!numeric(body.waiting?.themeId)||['207379235153','208782819665'].includes(body.waiting.themeId)||!uuid(body.waiting.attemptId)||!validTime(body.waiting.nextCheckAt)||!validTime(body.waiting.deadlineAt)||Date.parse(body.waiting.nextCheckAt)>Date.parse(body.waiting.deadlineAt))fail('WAITING_BINDING');
    if(state.waiting&&(state.waiting.themeId!==body.waiting.themeId||state.waiting.attemptId!==body.waiting.attemptId||state.waiting.deadlineAt!==body.waiting.deadlineAt||Date.parse(body.waiting.nextCheckAt)<=Date.parse(state.waiting.nextCheckAt)))fail('WAITING_CHANGED');
    state.phase='waiting';state.waiting=structuredClone(body.waiting);
  }
  if(body.type==='recheck'){if(state.phase!=='waiting'||Date.parse(body.observedAt)<Date.parse(state.waiting.nextCheckAt))fail('CHECK_NOT_DUE');state.phase='rechecking';}
  if(body.type==='verify'){if(!['installing','rechecking','waiting'].includes(state.phase))fail('LEDGER_TRANSITION');state.phase='verified';}
  if(body.type==='stop'){if(typeof body.code!=='string'||!/^[A-Z][A-Z0-9_]{2,99}$/.test(body.code))fail('STOP_CODE');state.phase='stopped';state.stopCode=body.code;}
  state.sequence=body.sequence;state.head=eventHash;state.lastObservedAt=body.observedAt;return state;
}
async function readLedger(paths,config){
  await safeDirectory(paths.ledgerDirectory);const entries=await fs.readdir(paths.ledgerDirectory),names=entries.filter(n=>n!=='head.json').sort();if(names.length>HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.events||names.some((name,index)=>name!==eventName(index+1)))fail('LEDGER_CORRUPT');
  const state=initialLedger(config);for(const name of names)applyLedger(state,parse(await readBytes(path.join(paths.ledgerDirectory,name),MAX_RECORD,{parentChecked:true})),config);
  const head=parse(await readBytes(path.join(paths.ledgerDirectory,'head.json'),MAX_RECORD,{parentChecked:true}));if(!equal(head,{intentHash:config.intentHash,sequence:state.sequence,eventHash:state.head}))fail('LEDGER_HIGH_WATER_MISMATCH');return state;
}
async function assertLedgerHead(paths,config,state){
  // The complete chain is validated on load and inspection. A running writer
  // retains its verified counters; another process cannot replace that state.
  // Under the write lock check the separate high-water mark, every filename,
  // and the last event again before extending the already-validated chain.
  await safeDirectory(paths.ledgerDirectory);const names=(await fs.readdir(paths.ledgerDirectory)).filter(n=>n!=='head.json').sort();
  if(names.length!==state.sequence||names.some((name,index)=>name!==eventName(index+1)))fail('LEDGER_HIGH_WATER_MISMATCH');
  const head=parse(await readBytes(path.join(paths.ledgerDirectory,'head.json'),MAX_RECORD,{parentChecked:true}));if(!equal(head,{intentHash:config.intentHash,sequence:state.sequence,eventHash:state.head}))fail('CONCURRENT_OPERATION');
  if(state.sequence){const event=parse(await readBytes(path.join(paths.ledgerDirectory,eventName(state.sequence)),MAX_RECORD,{parentChecked:true})),{eventHash,...body}=event;if(eventHash!==state.head||hash(body)!==eventHash)fail('LEDGER_CORRUPT');}
}
async function ownedBytes(directory,config){
  let bytes=0,files=0;async function add(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('UNSAFE_FILE');bytes+=stat.size;if(++files>2000||bytes>HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.ownedBytes-WRITE_ALLOWANCE)fail('STORAGE_LIMIT');}
  async function visit(folder){await safeDirectory(folder);for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name),stat=await fs.lstat(file);if(stat.isSymbolicLink())fail('UNSAFE_FILE');if(stat.isDirectory())await visit(file);else await add(file);}}
  await visit(directory);
  if(config){
    const progressDirectory=path.join(PROGRESS,config.intentHash);try{await visit(progressDirectory);}catch(e){if(e.code!=='ENOENT')throw e;}
    const key=hash({targetStore:IDENTITY.targetStore,projectId:config.projectId});await add(path.join(REGISTRY,`${key}.json`));
  }
  return {bytes,files,maximumBytes:HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.ownedBytes,reservedWriteMarginBytes:WRITE_ALLOWANCE,insideExistingBackupSource:true,backupScopeChanged:false,backupLimitsChanged:false};
}

/** One explicitly selected real installation. Before theme creation it may run
 * only once in one process. A restart with an unfinished initial step stops;
 * only a durable definite theme ID in waiting state can be reconciled. */
export async function loadHostedPreparedBasicInstaller({configFile,configSha256,accessToken,getAccessToken,assertSourceCurrent,networkEnabled=false,fetchImpl=globalThis.fetch,uploadFetch=globalThis.fetch,decodeImage,clock=Date.now,timers=globalThis}={}){
  if(!isHash(configSha256)||typeof configFile!=='string'||networkEnabled!==true||typeof fetchImpl!=='function'||typeof uploadFetch!=='function')fail('ACTIVATION_REQUIRED');
  const raw=await readBytes(path.resolve(configFile));if(sha(raw)!==configSha256)fail('CONFIG_SHA_MISMATCH');const config=validateConfig(parse(raw),configFile),paths=jobPaths(config.projectId);
  const bundleBytes=await readBytes(paths.bundleFile,MAX_BUNDLE);if(sha(bundleBytes)!==config.bundleSha256)fail('PACKAGE_SHA_MISMATCH');const bundle=await bundleFrom(bundleBytes),context=contextFor(bundle);
  if(context.projectId!==config.projectId||!equal(bundle.confirmation,config.confirmation)||!equal(bundle.counts,config.counts))fail('CONFIG_BINDING');await ownedBytes(paths.directory,config);
  const {readBasicInstallation}=await import('./basic-installation.mjs');const options={directory:paths.journalDirectory,context};
  let journal=await readBasicInstallation(options);if(journal.intentHash!==config.intentHash||journal.intent.runtimeProfile!==PROFILE||journal.intent.registryDirectory!==REGISTRY||journal.intent.liveThemeId!==IDENTITY.liveThemeId||journal.intent.authorization.referenceSha256!==config.authorizationSha256)fail('JOURNAL_BINDING');
  let ledger=await readLedger(paths,config),queue=Promise.resolve();
  async function append(type,extra={}){
    const action=queue.then(async()=>{const lock=path.join(paths.directory,'.budget-lock');try{await fs.mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('BUSY_OR_INTERRUPTED');throw e;}
      try{await assertLedgerHead(paths,config,ledger);if(type==='verify'&&!equal(await readLedger(paths,config),ledger))fail('LEDGER_CORRUPT');const latest=ledger,now=nowOf(clock);if(now<Date.parse(latest.lastObservedAt))fail('CLOCK_ROLLBACK');if(latest.sequence>=HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.events)fail('EVENT_LIMIT');const body={sequence:latest.sequence+1,previousHash:latest.head,intentHash:config.intentHash,type,observedAt:iso(now),...extra},event={...body,eventHash:hash(body)},next=applyLedger(structuredClone(latest),event,config);await ownedBytes(paths.directory,config);await writeNew(path.join(paths.ledgerDirectory,eventName(event.sequence)),event);
        // An interrupted event/head commit is retained and blocks restart. The
        // separate high-water checkpoint also detects trailing-event removal.
        const nextHead=path.join(paths.ledgerDirectory,'head.next.json');await writeNew(nextHead,{intentHash:config.intentHash,sequence:next.sequence,eventHash:next.head});await fs.rename(nextHead,path.join(paths.ledgerDirectory,'head.json'));ledger=next;return next;
      }finally{await fs.rmdir(lock);}});
    queue=action.catch(()=>{});return action;
  }
  let runner=null,controller=null,scheduler=null,lifecycle='idle',timer=null,inFlight=null,draining=null,lastCode=null;
  const status=()=>{const child=scheduler?.status()??null;return frozen({lifecycle:child&&['completed','failed'].includes(child.lifecycle)?child.lifecycle:lifecycle,jobId:config.jobId,projectId:config.projectId,phase:ledger.phase,counters:ledger.counters,inFlight:inFlight!==null||Boolean(child?.inFlight),draining:draining!==null,timerScheduled:timer!==null||Boolean(child?.timerScheduled),themeId:ledger.waiting?.themeId??journal.steps.theme?.receipt?.remoteId??null,lastCode:ledger.stopCode??lastCode,scheduler:child});};
  const validateSnapshot=async()=>{if(sha(await readBytes(paths.configFile))!==configSha256||sha(await readBytes(paths.bundleFile,MAX_BUNDLE))!==config.bundleSha256)fail('SOURCE_CHANGED');await ownedBytes(paths.directory,config);};
  async function sourceCurrent(){
    if(typeof assertSourceCurrent!=='function')fail('SOURCE_CONFIRMATION_CHECK_REQUIRED');
    let accepted=false;try{accepted=await assertSourceCurrent(frozen(config.confirmation));}catch{fail('SOURCE_CONFIRMATION_CHECK_FAILED');}
    if(accepted!==true)fail('SOURCE_CONFIRMATION_CHANGED');
  }
  async function stopJob(code){
    lastCode=code;if(!['verified','stopped'].includes(ledger.phase))await append('stop',{code});
    if(controller){try{await controller.stop({code:'HOSTED_JOB_STOPPED'});}catch{}}
  }
  async function budgetFetch(url,init){
    if(url!==ENDPOINT||init?.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>1024*1024)fail('REQUEST_SCOPE');
    const body=parse(Buffer.from(init.body));if(typeof body.query!=='string'||!/^\s*(?:query|mutation)\s+MolyviBasic[A-Za-z0-9_]+\b/.test(body.query))fail('REQUEST_SCOPE');
    const mutation=/^\s*mutation\b/.test(body.query);if(ledger.phase==='rechecking'&&mutation)fail('RECHECK_READ_ONLY');
    if(mutation)await sourceCurrent();
    await append('reserve',{kind:mutation?'mutation':'graphql',operationSha256:sha(body.query)});
    return fetchImpl(url,init);
  }
  async function budgetExternal(url,init){
    if(typeof url!=='string'||!['POST','GET'].includes(init?.method)||init.redirect!=='error')fail('REQUEST_SCOPE');
    if(ledger.phase==='rechecking'&&init.method!=='GET')fail('RECHECK_READ_ONLY');
    if(init.method==='POST')await sourceCurrent();
    await append('reserve',{kind:init.method==='POST'?'upload':'external'});return uploadFetch(url,init);
  }
  async function readyRunner(){
    if(runner)return runner;await sourceCurrent();const token=getAccessToken===undefined?accessToken:typeof getAccessToken==='function'?await getAccessToken():null;if(typeof token!=='string'||token.length<16||token.length>2048||!(/^[\x21-\x7e]+$/).test(token))fail('CREDENTIAL_REQUIRED');
    const [{createShopifyBasicTransport},{createBasicInstallationRunner}]=await Promise.all([import('./shopify-basic-transport.mjs'),import('./basic-installation-runner.mjs')]);
    let decoder=decodeImage;if(decoder===undefined){const sharp=createRequire(import.meta.url)('sharp');sharp.cache(false);sharp.concurrency(1);const {createShopifyImageDecoder}=await import('./shopify-image-decoder.mjs');decoder=createShopifyImageDecoder({sharp});}
    const transport=createShopifyBasicTransport({prepared:bundle.prepared,theme:bundle.theme,binding:sourceBinding(journal),liveThemeId:IDENTITY.liveThemeId,inventoryLocationId:LOCATION,accessToken:token,fetchImpl:budgetFetch,uploadFetch:budgetExternal,decodeImage:decoder,networkEnabled:true,recordReadbackEvidence:async evidence=>{
      if(evidence?.outcome!=='found'||!numeric(evidence.remoteId)||!uuid(evidence.readRequestId)||!isHash(evidence.payloadHash))fail('EVIDENCE_INVALID');
      // The full transport report may include CDN URLs. Retain its digest and
      // exact resource/attempt binding, never the provider payload or secrets.
      const record={kind:'molyvi_hosted_basic_readback_digest',intentHash:config.intentHash,key:evidence.key,attemptId:evidence.attemptId,readRequestId:evidence.readRequestId,remoteId:evidence.remoteId,payloadHash:evidence.payloadHash,observedAt:evidence.observedAt,readbackSha256:hash(evidence),provenanceSha256:evidence.provenance?hash(evidence.provenance):null};
      await ownedBytes(paths.directory,config);await writeNew(path.join(paths.evidenceDirectory,`${evidence.readRequestId}.json`),record);
    }});
    runner=await createBasicInstallationRunner({runtimeProfile:PROFILE,registryDirectory:REGISTRY,trustedShop:{shopId:IDENTITY.shopId,targetStore:IDENTITY.targetStore},transport,operatorId:config.operatorId,timeoutMs:60000,themeWaitMs:0,themeClock:clock});return runner;
  }
  async function progress(){
    journal=await readBasicInstallation(options);if(journal.intentHash!==config.intentHash)fail('JOURNAL_BINDING');const step=journal.intent.steps.find(s=>s.key==='theme'),current=journal.steps.theme;
    if(!current?.attemptId||step.dependsOn.some(key=>journal.steps[key].status!=='succeeded'))fail('THEME_DEPENDENCIES');
    const {createBasicThemeProgress}=await import('./basic-theme-progress.mjs');controller=createBasicThemeProgress({runtimeProfile:PROFILE,binding:{...sourceBinding(journal),...IDENTITY},attemptId:current.attemptId,dependenciesHash:hash(Object.fromEntries(step.dependsOn.map(key=>[key,journal.steps[key].receipt]))),journalDirectory:paths.journalDirectory,registryKey:journal.intent.registryKey,rootDirectory:PROGRESS,clock});
    const result=await controller.read();if(!result||!numeric(result.themeId)||['207379235153','208782819665'].includes(result.themeId))fail('DEFINITE_THEME_REQUIRED');return result;
  }
  async function accept(result){
    journal=result;if(result.intentHash!==config.intentHash)fail('JOURNAL_BINDING');
    if(result.waiting){const p=await progress();if(p.status!=='waiting'||p.themeId!==result.waiting.remoteId||p.nextEligibleAt!==result.waiting.nextCheckAt)fail('WAITING_PROOF');await append('wait',{waiting:{themeId:p.themeId,attemptId:p.attemptId,nextCheckAt:p.nextEligibleAt,deadlineAt:p.deadlineAt}});return;}
    if(!Object.values(result.steps).every(step=>step.status==='succeeded'))fail('INSTALLATION_INCOMPLETE');await sourceCurrent();await append('verify');
  }
  async function attachScheduler(){
    const p=await progress();if(!ledger.waiting||p.themeId!==ledger.waiting.themeId||p.attemptId!==ledger.waiting.attemptId||p.deadlineAt!==ledger.waiting.deadlineAt)fail('WAITING_PROOF');
    const binding={jobId:config.jobId,intentHash:config.intentHash,attemptId:p.attemptId,themeId:p.themeId,...IDENTITY};
    scheduler=createHostedThemeRechecks({binding,clock,timers,readDue:async expected=>{
      if(!equal(expected,binding))fail('WAITING_PROOF');await validateSnapshot();const fresh=await progress();
      if((ledger.phase==='verified')!==(fresh.status==='verified'))fail('VERIFICATION_MISMATCH');
      return {binding,status:ledger.phase==='stopped'?'stopped':fresh.status,nextCheckAt:fresh.nextEligibleAt,deadlineAt:fresh.deadlineAt};
    },reconcileKnown:async expected=>{
      if(!equal(expected,binding)||ledger.phase!=='waiting')fail('WAITING_PROOF');await validateSnapshot();const fresh=await progress();if(fresh.status!=='waiting'||fresh.themeId!==binding.themeId)fail('WAITING_PROOF');
      await append('recheck');const active=await readyRunner();await accept(await active.reconcileStep({...options,key:'theme'}));
    },stopJob:async()=>stopJob('THEME_RECHECK_STOPPED')});
    if(lifecycle==='running')scheduler.start();else scheduler.pause();
  }
  async function initial(){
    await validateSnapshot();await sourceCurrent();journal=await readBasicInstallation(options);
    if(journal.eventCount!==0||Object.values(journal.steps).some(step=>step.status!=='pending'))fail('INITIAL_STATE_CHANGED');await append('install');
    const active=await readyRunner();for(const step of journal.intent.steps){
      if(lifecycle!=='running'){await stopJob('INITIAL_INTERRUPTED');return;}
      await validateSnapshot();await sourceCurrent();journal=await active.runStep({...options,key:step.key});
      if(step.kind==='theme')await accept(journal);
    }
    if(ledger.phase==='waiting')await attachScheduler();else lifecycle='completed';
  }
  async function cycle(){
    try{
      if(['verified','stopped'].includes(ledger.phase)){lifecycle='completed';return;}
      if(ledger.phase==='prepared')await initial();
      else if(ledger.phase==='waiting')await attachScheduler();
      else{await stopJob('INTERRUPTED_INITIAL_OR_RECHECK');lifecycle='failed';}
    }catch(error){const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{2,99}$/.test(error.code)?error.code:'INSTALLATION_STOPPED';try{await stopJob(code);}catch{}lifecycle='failed';lastCode=code;}
  }
  const cancel=()=>{if(timer!==null){timers.clearTimeout(timer);timer=null;}};
  function arm(){if(lifecycle!=='running'||timer!==null||inFlight||scheduler)return;timer=timers.setTimeout(()=>{timer=null;if(lifecycle!=='running')return;inFlight=cycle().finally(()=>{inFlight=null;});},1000);timer?.unref?.();}
  function start(){if(lifecycle==='running')return status();if(lifecycle!=='idle')fail('START_STATE');lifecycle='running';arm();return status();}
  function pause(){if(['idle','running'].includes(lifecycle)){lifecycle='paused';cancel();scheduler?.pause();}return status();}
  function drain(){if(draining)return draining;pause();draining=Promise.resolve().then(async()=>{if(inFlight)await inFlight;if(scheduler)await scheduler.drain();await queue;}).then(()=>{draining=null;return status();});return draining;}
  function resume(){if(draining)fail('DRAIN_IN_PROGRESS');if(lifecycle==='running')return status();if(lifecycle!=='paused')fail('RESUME_STATE');lifecycle='running';if(scheduler)scheduler.resume();else arm();return status();}
  async function stop(){cancel();if(!['completed','failed'].includes(lifecycle))lifecycle='stopped';if(inFlight)await inFlight;if(scheduler)await scheduler.stop();await queue;return status();}
  async function inspect(){
    await validateSnapshot();const actualLedger=await readLedger(paths,config),actual=await readBasicInstallation(options);
    return frozen({...status(),phase:actualLedger.phase,counters:actualLedger.counters,eventCount:actualLedger.sequence,journalEventCount:actual.eventCount,journalHead:actual.head,intentHash:actual.intentHash,counts:{succeeded:Object.values(actual.steps).filter(s=>s.status==='succeeded').length,total:actual.intent.steps.length},resources:actual.intent.steps.filter(s=>actual.steps[s.key].receipt).map(s=>({key:s.key,kind:s.kind,remoteId:actual.steps[s.key].receipt.remoteId})),waiting:actualLedger.waiting,storage:await ownedBytes(paths.directory,config),publicationAuthorized:false,newChargesAuthorized:false});
  }
  return Object.freeze({start,pause,drain,resume,stop,status,inspect,config:frozen(config)});
}
