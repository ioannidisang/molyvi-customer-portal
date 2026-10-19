import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {verifyBasicStorePackage} from './basic-store-package.mjs';

const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>sha(canonicalJson(value));
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(`BASIC_INSTALL_${code}`,422);};
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isId=value=>typeof value==='string'&&/^[1-9][0-9]{0,24}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const domain=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(value);
const inside=(parent,child)=>{const r=path.relative(parent,child);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value);
const json=value=>JSON.stringify(value,null,2)+'\n';
const eventName=index=>`${String(index).padStart(6,'0')}.json`;
const MAX_EVENTS=512,MAX_FILE_BYTES=4*1024*1024;
export const BASIC_INSTALL_CONTINUATION_REGISTRY=path.join(WORKSPACE_ROOT,'briefs','molyvi-basic-installer-runtime','continuations');
export const BASIC_INSTALL_HOSTED_PROFILE='hosted_basic_v1';
export const BASIC_INSTALL_HOSTED_ROOT=path.join(WORKSPACE_ROOT,'briefs','molyvi-hosted-staging','controlled-operations','basic-installer');
export const BASIC_INSTALL_HOSTED_REGISTRY=path.join(BASIC_INSTALL_HOSTED_ROOT,'runtime','registry');
export const BASIC_INSTALL_HOSTED_CONTINUATION_REGISTRY=path.join(BASIC_INSTALL_HOSTED_ROOT,'runtime','continuations');
export const BASIC_INSTALL_HOSTED_JOBS_ROOT=path.join(BASIC_INSTALL_HOSTED_ROOT,'jobs');
function profile(value){if(value!==undefined&&value!==BASIC_INSTALL_HOSTED_PROFILE)fail('RUNTIME_PROFILE_INVALID');return value;}
const runtimeRegistry=value=>profile(value)===BASIC_INSTALL_HOSTED_PROFILE?BASIC_INSTALL_HOSTED_CONTINUATION_REGISTRY:BASIC_INSTALL_CONTINUATION_REGISTRY;
const continuationFile=(key,value)=>path.join(runtimeRegistry(value),`${key}.json`);
function profilePaths(value,registry,directory,projectId,{continuation=false}={}){
  profile(value);
  if(value===BASIC_INSTALL_HOSTED_PROFILE){
    if(registry!==BASIC_INSTALL_HOSTED_REGISTRY)fail('RUNTIME_REGISTRY_MISMATCH');
    if(directory!==undefined&&!['journal',...(continuation?['continuation-journal']:[])].some(name=>directory===path.join(BASIC_INSTALL_HOSTED_JOBS_ROOT,projectId,name)))fail('RUNTIME_JOURNAL_MISMATCH');
  }else if([registry,directory].some(item=>typeof item==='string'&&(item===BASIC_INSTALL_HOSTED_ROOT||inside(BASIC_INSTALL_HOSTED_ROOT,item))))fail('RUNTIME_PROFILE_REQUIRED');
}

// This module never calls Shopify or any network/provider. It records trusted
// operator observations. Hashes protect accidental corruption, not a malicious
// local administrator; they do not verify remote ownership or grant authority.
async function safeDirectory(value,{newDirectory=false}={}){
  if(typeof value!=='string'||!value||/[\x00-\x1f]/.test(value))fail('PRIVATE_DIRECTORY_REQUIRED');
  const absolute=path.resolve(value),root=['briefs','customer-materials'].map(p=>path.join(WORKSPACE_ROOT,p)).find(p=>inside(p,absolute));
  if(!root)fail('PRIVATE_DIRECTORY_REQUIRED');
  const parent=newDirectory?path.dirname(absolute):absolute,parsed=path.parse(parent);let current=parsed.root;
  for(const part of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=await fs.lstat(current);
    if(stat.isSymbolicLink()||!stat.isDirectory())fail('UNSAFE_DIRECTORY');
  }
  return absolute;
}
async function readJson(file){
  const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_FILE_BYTES)fail('UNSAFE_FILE');
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error instanceof SyntaxError)fail('CORRUPT_JOURNAL');throw error;}
}
async function writeNew(file,value){
  const bytes=Buffer.from(json(value));if(bytes.length>MAX_FILE_BYTES)fail('JOURNAL_LIMIT');
  const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function continuationRecord(intent){
  let value;try{await safeDirectory(runtimeRegistry(intent.runtimeProfile));value=await readJson(continuationFile(intent.registryKey,intent.runtimeProfile));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const {recordHash,...unsigned}=value??{};
  if(recordHash!==hash(unsigned)||value?.schemaVersion!==1||value.kind!=='molyvi_basic_immutable_source_continuation'||value.registryKey!==intent.registryKey||value.intentHash!==intent.intentHash||value.originalRegistryDirectory!==intent.registryDirectory||!isHash(value.sourceHash)||!Number.isSafeInteger(value.sourceEventCount)||value.sourceEventCount<0||!Array.isArray(value.sourceFiles)||!Array.isArray(value.allowedSteps)||new Set(value.allowedSteps).size!==value.allowedSteps.length||value.allowedSteps.some(key=>!intent.steps.some(s=>s.key===key&&['page','theme'].includes(s.kind)))||!isHash(value.authorizationSha256)||value.publicationAuthorized!==false||value.newChargesAuthorized!==false||typeof value.sourceDirectory!=='string'||typeof value.journalDirectory!=='string'||value.sourceDirectory===value.journalDirectory)fail('CONTINUATION_CORRUPT');
  return value;
}
async function assertWritableJournal(directory){
  const intent=validateIntent(await readJson(path.join(directory,'intent.json'))),record=await continuationRecord(intent);
  profilePaths(intent.runtimeProfile,intent.registryDirectory,directory,intent.projectId,{continuation:!!record});
  if(record&&path.resolve(record.sourceDirectory)===directory)fail('CONTINUATION_SOURCE_FROZEN');
  if(record&&path.resolve(record.journalDirectory)!==directory)fail('CONTINUATION_DIRECTORY_MISMATCH');
  return record;
}
async function ensureContinuationRegistry(value){
  const destination=runtimeRegistry(value),privateRoot=path.join(WORKSPACE_ROOT,'briefs');
  await safeDirectory(path.join(privateRoot,path.relative(privateRoot,destination).split(path.sep)[0]),{newDirectory:true});
  let directory=privateRoot;
  for(const part of path.relative(privateRoot,destination).split(path.sep)){
    directory=path.join(directory,part);
    try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    await safeDirectory(directory);
  }
}
export async function getBasicInstallationRuntimeRegistry(runtimeProfile){await ensureContinuationRegistry(runtimeProfile);return runtimeRegistry(runtimeProfile);}
/**
 * Retry only an unchanged local checkpoint rename when the filesystem reports
 * a transient lock. This is NOT an installation/provider/claim retry. The
 * existing writer lock remains held, no new event is constructed, and any
 * exhausted or ambiguous result retains head.next.json for investigation.
 * Injectable primitives support isolated filesystem tests, not HTTP callers.
 */
export async function renameBasicInstallationCheckpoint(directory,{rename=(source,target)=>fs.rename(source,target),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const absolute=await safeDirectory(directory),lock=await fs.lstat(path.join(absolute,'.writer-lock'));
  if(!lock.isDirectory()||lock.isSymbolicLink())fail('CHECKPOINT_LOCK_REQUIRED');
  const source=path.join(absolute,'head.next.json'),target=path.join(absolute,'head.json');
  const beforeSource=await readJson(source),beforeTarget=await readJson(target);
  const sourceHash=sha(await fs.readFile(source)),targetHash=sha(await fs.readFile(target));
  if(beforeSource.intentHash!==beforeTarget.intentHash||!isHash(beforeSource.intentHash)||!isHash(beforeSource.eventHash)||!isHash(beforeTarget.eventHash)||!Number.isSafeInteger(beforeTarget.sequence)||beforeTarget.sequence<0||beforeSource.sequence!==beforeTarget.sequence+1)fail('HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  const delays=[20,50,100,200];
  for(let attempt=0;;attempt++){
    // Re-read both safe files each time: never rename a replaced/different
    // checkpoint, nor overwrite a head changed outside the held writer lock.
    await readJson(source);await readJson(target);
    if(sha(await fs.readFile(source))!==sourceHash||sha(await fs.readFile(target))!==targetHash)fail('CHECKPOINT_CHANGED_RECONCILIATION_REQUIRED');
    try{await rename(source,target);return;}
    catch(error){if(!['EPERM','EBUSY'].includes(error.code)||attempt>=delays.length)throw error;await wait(delays[attempt]);}
  }
}
function evidence(value){
  if(!value||!text(value.operatorId)||!isHash(value.evidenceSha256)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.observedAt??'')||!Number.isFinite(Date.parse(value.observedAt))||value.scopeConfirmed!==true)fail('OPERATOR_EVIDENCE_REQUIRED');
  return {operatorId:value.operatorId,evidenceSha256:value.evidenceSha256,observedAt:value.observedAt,scopeConfirmed:true,verification:'operator_attested_not_independent_remote_verification'};
}
function authorization(value,scope){
  if(!value||value.targetStore!==scope.targetStore||value.projectId!==scope.projectId||value.ownerHash!==scope.ownerHash||value.planHash!==scope.planHash||value.createOnly!==true||value.publicationAuthorized!==false||value.newChargesAuthorized!==false||!isHash(value.referenceSha256))fail('AUTHORIZATION_SCOPE_MISMATCH');
  return {...scope,createOnly:true,publicationAuthorized:false,newChargesAuthorized:false,referenceSha256:value.referenceSha256};
}
function expectedScope(plan){return {targetStore:plan.targetStore,projectId:plan.projectId,ownerHash:plan.ownerHash,planHash:plan.planHash};}
function contextFor(plan,context){
  if(!context||!uuid(context.ownerId)||context.targetStore!==plan.targetStore||context.projectId!==plan.projectId||hash(context.ownerId)!==plan.ownerHash||context.planHash!==plan.planHash||context.themeZipSha256!==plan.themeZipSha256)fail('CONTEXT_MISMATCH');
}
function validateIntent(intent){
  const {intentHash,...body}=intent??{};
  if(intentHash!==hash(body)||body.schemaVersion!==1||body.kind!=='molyvi_basic_controlled_installation'||!uuid(body.projectId)||!isHash(body.ownerHash)||!isHash(body.planHash)||!isHash(body.packageBytesHash)||!isHash(body.themeZipSha256)||!isHash(body.themeManifestHash)||!domain(body.targetStore)||body.mode!=='create_only_operator_journal'||body.networkEnabled!==false||body.publicationAuthorized!==false||body.newChargesAuthorized!==false||body.overwriteExisting!==false||!isId(body.liveThemeId)||!isId(body.inventoryLocationId)||body.currency!=='EUR'||body.registryKey!==hash({targetStore:body.targetStore,projectId:body.projectId})||typeof body.registryDirectory!=='string'||!Array.isArray(body.steps)||body.steps.length<10||body.steps.length>64)fail('CORRUPT_INTENT');
  profilePaths(body.runtimeProfile,body.registryDirectory,undefined,body.projectId);
  authorization(body.authorization,expectedScope(body));evidence(body.preflightEvidence);
  if(!Array.isArray(body.preexistingResources)||body.preexistingResources.some(r=>!['catalog','variant','media','collection','page','theme'].includes(r.kind)||!isId(r.remoteId))||new Set(body.preexistingResources.map(r=>`${r.kind}:${r.remoteId}`)).size!==body.preexistingResources.length)fail('CORRUPT_INTENT');
  const seen=new Set();
  for(const step of body.steps){
    if(!text(step.key)||seen.has(step.key)||!['catalog','media','variant_media','collection','page','theme'].includes(step.kind)||step.action!==(step.kind==='variant_media'?'link_new_resources':'create')||!Array.isArray(step.dependsOn)||step.dependsOn.some(key=>!seen.has(key))||step.payloadHash!==hash(step.expected))fail('CORRUPT_INTENT');
    seen.add(step.key);
  }
  return intent;
}
async function verifiedTheme(plan,theme){
  const manifest=structuredClone(theme?.manifest),bytes=Buffer.isBuffer(theme?.zipBytes)?Buffer.from(theme.zipBytes):null;
  if(!manifest||!bytes||bytes.length>32*1024*1024||manifest.kind!=='molyvi_basic_theme_package'||manifest.planHash!==plan.planHash||manifest.projectId!==plan.projectId||manifest.targetStore!==plan.targetStore||manifest.applicationAuthorized!==false||manifest.publicationAuthorized!==false||manifest.status!=='UNPUBLISHED_NOT_APPLIED'||manifest.zip?.sha256!==sha(bytes)||manifest.zip.bytes!==bytes.length||!Array.isArray(manifest.files))fail('THEME_MISMATCH');
  // Inspect declared sizes before decompression. Exact SHA verification below
  // covers every accepted file without eagerly inflating an unbounded ZIP.
  let zip;try{zip=await JSZip.loadAsync(bytes);}catch{fail('THEME_ZIP_INVALID');}
  const expected=manifest.files.filter(file=>!file.file.split('/').some(part=>part.startsWith('.'))),actual=Object.values(zip.files).filter(file=>!file.dir);
  if(actual.length!==expected.length||new Set(expected.map(file=>file.file)).size!==expected.length)fail('THEME_ZIP_INVALID');
  let total=0;for(const file of expected){
    if(!text(file.file)||file.file.includes('\\')||file.file.split('/').some(part=>!part||part==='..'||part==='.')||!Number.isSafeInteger(file.bytes)||file.bytes<0||!isHash(file.sha256)||(total+=file.bytes)>64*1024*1024)fail('THEME_ZIP_INVALID');
    const entry=zip.file(file.file);if(!entry||entry._data?.uncompressedSize!==file.bytes)fail('THEME_ZIP_INVALID');
    const data=await entry.async('nodebuffer');if(data.length!==file.bytes||sha(data)!==file.sha256)fail('THEME_ZIP_INVALID');
  }
  return {themeManifestHash:hash(manifest),themeZipSha256:sha(bytes)};
}

/** A new private journal only. Existing journals are opened, never recreated. */
export async function createBasicInstallation({directory,registryDirectory,runtimeProfile,prepared,theme,context,authorization:grant,preflightEvidence,liveThemeId,inventoryLocationId,currency,preexistingResources=[]}={}){
  profile(runtimeProfile);
  verifyBasicStorePackage(prepared);
  const plan=structuredClone(prepared.plan),uploads=prepared.uploads.map(item=>({fileName:item.fileName,sha256:sha(item.bytes),bytes:item.bytes.length}));
  // Snapshot all caller input before the first await.
  const snapshot=structuredClone({context,grant,preflightEvidence,liveThemeId,inventoryLocationId,currency,preexistingResources,runtimeProfile});
  if(typeof registryDirectory!=='string'||typeof directory!=='string')fail('PRIVATE_DIRECTORY_REQUIRED');
  profilePaths(snapshot.runtimeProfile,path.resolve(registryDirectory),path.resolve(directory),plan.projectId);
  const themeCheck=await verifiedTheme(plan,theme),ownerHash=plan.binding.ownerHash,scope={targetStore:plan.targetStore,projectId:plan.projectId,ownerHash,planHash:plan.planHash};
  const steps=[];const add=(key,kind,expected,dependsOn=[])=>steps.push({key,kind,action:kind==='variant_media'?'link_new_resources':'create',expected,payloadHash:hash(expected),dependsOn});
  for(const product of plan.products){
    const key=`catalog:${product.productId}`;
    add(key,'catalog',{handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.type,optionNames:product.optionNames,status:'DRAFT',channels:[],currency:snapshot.currency,inventoryLocationId:snapshot.inventoryLocationId,variants:product.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))});
    for(const photo of product.photos)add(`media:${product.productId}:${photo.position}`,'media',{parentKey:key,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt},[key]);
    add(`variant_media:${product.productId}`,'variant_media',{parentKey:key,associations:product.variants.map(v=>({localId:v.id,mediaKey:`media:${product.productId}:${v.imagePosition}`}))},[key,...product.photos.map(p=>`media:${product.productId}:${p.position}`)]);
  }
  add('collection','collection',{title:plan.branding.brandName,handle:plan.namespace,productKeys:plan.products.map(p=>`catalog:${p.productId}`),channels:[]},steps.filter(s=>s.kind==='catalog').map(s=>s.key));
  for(const page of plan.pages)add(`page:${page.documentId}`,'page',{title:page.title,handle:page.handle,bodySha256:page.bodySha256,visibility:'Hidden'});
  add('theme','theme',{zipSha256:themeCheck.themeZipSha256,status:'Draft'},steps.map(s=>s.key));
  const registry=await safeDirectory(registryDirectory),registryKey=hash({targetStore:scope.targetStore,projectId:scope.projectId});
  // A canonical continuation reservation remains authoritative even if a
  // caller supplies another legacy registry for the same store/project.
  for(const selected of [undefined,BASIC_INSTALL_HOSTED_PROFILE]){
    try{await safeDirectory(runtimeRegistry(selected));await readJson(continuationFile(registryKey,selected));fail('INSTALLATION_ALREADY_CONTINUED');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  // A hosted reservation cannot be bypassed by selecting a legacy registry.
  if(snapshot.runtimeProfile===undefined){try{await safeDirectory(BASIC_INSTALL_HOSTED_REGISTRY);await readJson(path.join(BASIC_INSTALL_HOSTED_REGISTRY,`${registryKey}.json`));fail('INSTALLATION_ALREADY_RESERVED');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const body={schemaVersion:1,kind:'molyvi_basic_controlled_installation',mode:'create_only_operator_journal',...(snapshot.runtimeProfile?{runtimeProfile:snapshot.runtimeProfile}:{}),...scope,...themeCheck,registryDirectory:registry,registryKey,packageBytesHash:hash({plan,uploads}),namespace:plan.namespace,authorization:authorization(snapshot.grant,scope),preflightEvidence:evidence(snapshot.preflightEvidence),liveThemeId:snapshot.liveThemeId,inventoryLocationId:snapshot.inventoryLocationId,currency:snapshot.currency,preexistingResources:snapshot.preexistingResources,steps,networkEnabled:false,publicationAuthorized:false,newChargesAuthorized:false,overwriteExisting:false};
  const intent=validateIntent({...body,intentHash:hash(body)});contextFor(intent,snapshot.context);
  const absolute=await safeDirectory(directory,{newDirectory:true});
  if(absolute===registry||inside(absolute,registry)||inside(registry,absolute))fail('REGISTRY_SEPARATION_REQUIRED');
  // A trusted caller must always use the same configured registry. Reservation
  // is create-only even after partial initialization; do not reset it to retry.
  try{await writeNew(path.join(registry,`${registryKey}.json`),{intentHash:intent.intentHash,journalDirectory:absolute,projectId:intent.projectId,targetStore:intent.targetStore,planHash:intent.planHash});}
  catch(error){if(error.code==='EEXIST')fail('INSTALLATION_ALREADY_RESERVED');throw error;}
  await fs.mkdir(absolute,{mode:0o700});
  await writeNew(path.join(absolute,'intent.json'),intent);
  await writeNew(path.join(absolute,'head.json'),{intentHash:intent.intentHash,sequence:0,eventHash:intent.intentHash});
  return readBasicInstallation({directory:absolute,context:snapshot.context});
}
function initial(intent){return {intent,intentHash:intent.intentHash,head:intent.intentHash,eventCount:0,steps:Object.fromEntries(intent.steps.map(s=>[s.key,{status:'pending'}])),visibility:{status:'not_started'},installationStatus:'pending',remoteVerification:'operator_attested_not_independent_remote_verification'};}
function idsFromReceipt(step,receipt){return [{kind:step.kind,remoteId:receipt.remoteId},...(step.kind==='catalog'?receipt.observed.variants.map(v=>({kind:'variant',remoteId:v.remoteId})):[])];}
function receiptFor(state,step,value){
  if(!value||!isId(value.remoteId)||value.payloadHash!==step.payloadHash||!value.observed)fail('RECEIPT_MISMATCH');
  const operatorEvidence=evidence(value.evidence),o=value.observed,e=step.expected;
  if(step.kind==='catalog'){
    const {variants,...observedFields}=o,{variants:expectedVariants,...expectedFields}=e;
    if(!equal(observedFields,expectedFields)||!Array.isArray(variants)||variants.length!==expectedVariants.length)fail('RECEIPT_MISMATCH');
    for(const [index,v]of o.variants.entries()){const {remoteId,...fields}=v;if(!isId(remoteId)||!equal(fields,e.variants[index]))fail('RECEIPT_MISMATCH');}
  }else if(step.kind==='media'){
    if(!equal(o,{parentRemoteId:state.steps[e.parentKey].receipt.remoteId,position:e.position,sourceSha256:e.sourceSha256,alt:e.alt,loaded:true}))fail('RECEIPT_MISMATCH');
  }else if(step.kind==='variant_media'){
    const parent=state.steps[e.parentKey].receipt;
    const associations=e.associations.map(a=>({variantRemoteId:parent.observed.variants.find(v=>v.localId===a.localId).remoteId,mediaRemoteId:state.steps[a.mediaKey].receipt.remoteId}));
    if(value.remoteId!==parent.remoteId||!equal(o,{parentRemoteId:parent.remoteId,associations}))fail('RECEIPT_MISMATCH');
  }else if(step.kind==='collection'){
    if(!equal(o,{title:e.title,handle:e.handle,productRemoteIds:e.productKeys.map(key=>state.steps[key].receipt.remoteId),channels:[]}))fail('RECEIPT_MISMATCH');
  }else if(step.kind==='page'){
    if(!equal(o,e))fail('RECEIPT_MISMATCH');
  }else if(!equal(o,{zipSha256:e.zipSha256,status:'Draft',liveThemeIdUnchanged:state.intent.liveThemeId}))fail('RECEIPT_MISMATCH');
  const receipt={remoteId:value.remoteId,payloadHash:value.payloadHash,observed:structuredClone(o),evidence:operatorEvidence};
  const reserved=[...state.intent.preexistingResources,{kind:'theme',remoteId:state.intent.liveThemeId}];
  for(const item of state.intent.steps){const stored=state.steps[item.key];if(stored.receipt)reserved.push(...idsFromReceipt(item,stored.receipt));}
  const owned=new Set(reserved.map(r=>`${r.kind}:${r.remoteId}`));
  for(const id of idsFromReceipt(step,receipt)){const key=`${id.kind}:${id.remoteId}`;if(owned.has(key))fail('REMOTE_ID_CONFLICT');owned.add(key);}
  return receipt;
}
function visibilityScope(state){
  if(state.intent.steps.some(s=>state.steps[s.key].status!=='succeeded'))fail('INSTALLATION_INCOMPLETE');
  return {targetStore:state.intent.targetStore,projectId:state.intent.projectId,intentHash:state.intentHash,products:state.intent.steps.filter(s=>s.kind==='catalog').map(s=>state.steps[s.key].receipt.remoteId),collection:state.steps.collection.receipt.remoteId,pages:state.intent.steps.filter(s=>s.kind==='page').map(s=>state.steps[s.key].receipt.remoteId),theme:state.steps.theme.receipt.remoteId,liveThemeId:state.intent.liveThemeId};
}
function applyEvent(state,event){
  if(state.continuation&&event.sequence>state.continuation.sourceEventCount&&(event.type.startsWith('visibility_')||event.type==='restoration'||!state.continuation.allowedSteps.includes(event.key)))fail('CONTINUATION_STEP_FORBIDDEN');
  if(event.type==='claim'){
    const step=state.intent.steps.find(s=>s.key===event.key);if(!step||state.steps[event.key].status!=='pending'||!uuid(event.attemptId)||step.dependsOn.some(key=>state.steps[key].status!=='succeeded'))fail('INVALID_TRANSITION');
    state.steps[event.key]={status:'claimed_outcome_unknown',attemptId:event.attemptId};
  }else if(event.type==='receipt'||event.type==='reconcile'){
    const step=state.intent.steps.find(s=>s.key===event.key),current=state.steps[event.key];
    if(!step||current.status!=='claimed_outcome_unknown'||current.attemptId!==event.attemptId)fail('INVALID_TRANSITION');
    const receipt=receiptFor(state,step,event.receipt);if(!equal(receipt,event.receipt))fail('CORRUPT_JOURNAL');
    if(event.type==='reconcile')evidence(event.reconciliationEvidence);
    state.steps[event.key]={...current,status:'succeeded',receipt,reconciled:event.type==='reconcile'};
  }else if(event.type==='block'){
    const current=state.steps[event.key];if(!current||current.status!=='claimed_outcome_unknown'||current.attemptId!==event.attemptId||!['confirmed_absent','needs_investigation'].includes(event.reason))fail('INVALID_TRANSITION');
    evidence(event.evidence);state.steps[event.key]={...current,status:'blocked_no_automatic_retry',reason:event.reason,evidence:event.evidence};
  }else if(event.type==='visibility_claim'){
    const scope=visibilityScope(state);
    if(state.visibility.status!=='not_started'||!equal(scope,event.scope)||event.authorization.scopeHash!==hash(scope)||!isHash(event.authorization.referenceSha256)||event.authorization.temporaryOnly!==true||event.authorization.restoreRequired!==true||event.authorization.themePublishAuthorized!==false)fail('VISIBILITY_SCOPE_MISMATCH');
    evidence(event.evidence);state.visibility={status:'restoration_required',scope,authorization:event.authorization};
  }else if(event.type==='restoration'){
    if(state.visibility.status!=='restoration_required')fail('INVALID_TRANSITION');
    const scope=state.visibility.scope,expected={products:scope.products.map(remoteId=>({remoteId,status:'DRAFT',channels:[]})),collection:{remoteId:scope.collection,channels:[]},pages:scope.pages.map(remoteId=>({remoteId,visibility:'Hidden'})),theme:{remoteId:scope.theme,status:'Draft'},liveThemeId:scope.liveThemeId};
    if(!equal(event.observed,expected))fail('RESTORATION_MISMATCH');evidence(event.evidence);
    state.visibility={...state.visibility,status:'restored_operator_attested',observed:event.observed,evidence:event.evidence};
  }else fail('UNKNOWN_EVENT');
  const statuses=Object.values(state.steps).map(s=>s.status);
  state.installationStatus=statuses.every(s=>s==='succeeded')?'installed_operator_attested':statuses.some(s=>s==='blocked_no_automatic_retry')?'blocked':statuses.some(s=>s==='claimed_outcome_unknown')?'outcome_unknown':'pending';
  return state;
}
async function readState(directory,context,{immutableSource=false}={}){
  const intent=validateIntent(await readJson(path.join(directory,'intent.json')));contextFor(intent,context);
  const continuation=immutableSource?null:await continuationRecord(intent);
  profilePaths(intent.runtimeProfile,intent.registryDirectory,directory,intent.projectId,{continuation:!!continuation});
  if(continuation&&path.resolve(continuation.sourceDirectory)===directory)fail('CONTINUATION_SOURCE_FROZEN');
  if(continuation&&path.resolve(continuation.journalDirectory)!==directory)fail('CONTINUATION_DIRECTORY_MISMATCH');
  const registry=await safeDirectory(intent.registryDirectory),reservation=await readJson(path.join(registry,`${intent.registryKey}.json`));
  if(!equal(reservation,{intentHash:intent.intentHash,journalDirectory:continuation?continuation.sourceDirectory:directory,projectId:intent.projectId,targetStore:intent.targetStore,planHash:intent.planHash}))fail('REGISTRY_MISMATCH');
  const entries=await fs.readdir(directory),events=entries.filter(name=>/^\d{6}\.json$/.test(name)).sort();
  if(entries.some(name=>!['intent.json','head.json','.writer-lock'].includes(name)&&!events.includes(name))||events.length>MAX_EVENTS||!entries.includes('head.json'))fail('CORRUPT_JOURNAL');
  const checkpoint=await readJson(path.join(directory,'head.json'));
  if(checkpoint.intentHash!==intent.intentHash||checkpoint.sequence!==events.length||!isHash(checkpoint.eventHash))fail('HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  const state=initial(intent);
  for(const [index,name]of events.entries()){
    if(name!==eventName(index+1))fail('CORRUPT_JOURNAL');
    const signed=await readJson(path.join(directory,name)),{eventHash,...event}=signed;
    if(event.sequence!==index+1||event.previousHash!==state.head||event.intentHash!==intent.intentHash||eventHash!==hash(event))fail('CORRUPT_JOURNAL');
    if(continuation&&event.sequence>continuation.sourceEventCount&&(event.type.startsWith('visibility_')||event.type==='restoration'||!continuation.allowedSteps.includes(event.key)))fail('CONTINUATION_STEP_FORBIDDEN');
    applyEvent(state,event);state.head=eventHash;state.eventCount++;
  }
  if(state.head!==checkpoint.eventHash)fail('HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  if(continuation){
    const source=await immutableJournalSnapshot(continuation.sourceDirectory,context);
    if(source.state.intentHash!==intent.intentHash||source.state.eventCount!==continuation.sourceEventCount||source.snapshotHash!==continuation.sourceHash||!equal(source.records,continuation.sourceFiles))fail('CONTINUATION_SOURCE_CHANGED');
    for(const item of source.records.filter(item=>item.file!=='@registry'&&item.file!=='head.json')){
      const file=path.join(directory,item.file);await readJson(file);if(sha(await fs.readFile(file))!==item.sha256)fail('CONTINUATION_PREFIX_CHANGED');
    }
    if(events.length<continuation.sourceEventCount)fail('CONTINUATION_PREFIX_CHANGED');
    state.continuation={sourceDirectory:continuation.sourceDirectory,sourceHash:continuation.sourceHash,sourceEventCount:continuation.sourceEventCount,allowedSteps:[...continuation.allowedSteps],authorizationSha256:continuation.authorizationSha256,registryDirectory:runtimeRegistry(intent.runtimeProfile)};
  }
  return state;
}
async function immutableJournalSnapshot(directory,context){
  const absolute=await safeDirectory(directory);
  const sourceIntent=validateIntent(await readJson(path.join(absolute,'intent.json'))),sourceRegistry=await safeDirectory(sourceIntent.registryDirectory),runnerLock=path.join(sourceRegistry,`${sourceIntent.registryKey}.runner-lock`);
  const assertIdleRunner=async()=>{try{await fs.lstat(runnerLock);fail('CONTINUATION_SOURCE_BUSY');}catch(error){if(error.code!=='ENOENT')throw error;}};
  await assertIdleRunner();
  const entries=(await fs.readdir(absolute)).sort();
  if(entries.length>MAX_EVENTS+2)fail('JOURNAL_LIMIT');
  if(entries.includes('.writer-lock'))fail('CONTINUATION_SOURCE_BUSY');
  if(entries.some(name=>!['intent.json','head.json'].includes(name)&&!/^\d{6}\.json$/.test(name)))fail('CORRUPT_JOURNAL');
  const bytes=new Map(),records=[];let total=0;
  for(const name of entries){
    const file=path.join(absolute,name);await readJson(file);const data=await fs.readFile(file);
    if((total+=data.length)>64*1024*1024)fail('JOURNAL_LIMIT');
    bytes.set(name,data);records.push({file:name,bytes:data.length,sha256:sha(data)});
  }
  const state=await readState(absolute,context,{immutableSource:true}),registry=await safeDirectory(state.intent.registryDirectory),reservationFile=path.join(registry,`${state.intent.registryKey}.json`);
  await readJson(reservationFile);const reservationBytes=await fs.readFile(reservationFile);records.push({file:'@registry',bytes:reservationBytes.length,sha256:sha(reservationBytes)});
  // A read-only sealed source must remain byte-identical throughout validation.
  if(!equal(entries,(await fs.readdir(absolute)).sort()))fail('CONTINUATION_SOURCE_CHANGED');
  for(const item of records){const file=item.file==='@registry'?reservationFile:path.join(absolute,item.file);await readJson(file);if(sha(await fs.readFile(file))!==item.sha256)fail('CONTINUATION_SOURCE_CHANGED');}
  await assertIdleRunner();
  return {directory:absolute,state,records,bytes,snapshotHash:hash(records)};
}

/**
 * One deliberate relocation of an immutable, fully verified catalog journal.
 * The legacy reservation is never edited or bypassed. A fixed canonical
 * continuation reservation freezes the parent for current readers/writers and
 * retains exact source bytes and inherited receipts. Only remaining Hidden
 * pages and one Draft theme may be appended. Partial creation fails closed;
 * there is no reset, branch, unknown-outcome adoption or automatic cleanup.
 */
export async function createBasicInstallationContinuation({sourceDirectory,directory,context,authorization:grant,runtimeProfile}={}){
  profile(runtimeProfile);
  const input=structuredClone({sourceDirectory,directory,context,grant}),source=await immutableJournalSnapshot(input.sourceDirectory,input.context),state=source.state,intent=state.intent;
  if(intent.runtimeProfile!==runtimeProfile)fail('RUNTIME_PROFILE_MISMATCH');
  if(state.visibility.status!=='not_started'||state.installationStatus!=='pending'||Object.values(state.steps).some(step=>!['pending','succeeded'].includes(step.status)))fail('CONTINUATION_SOURCE_NOT_READY');
  const allowedSteps=intent.steps.filter(step=>state.steps[step.key].status==='pending').map(step=>step.key);
  if(!allowedSteps.includes('theme')||intent.steps.some(step=>!['page','theme'].includes(step.kind)&&state.steps[step.key].status!=='succeeded')||allowedSteps.some(key=>!intent.steps.some(step=>step.key===key&&['page','theme'].includes(step.kind))))fail('CONTINUATION_SOURCE_NOT_READY');
  authorization(input.grant,expectedScope(intent));
  if(input.grant.actualUserAuthorization!==true||!equal(input.grant.allowedSteps,allowedSteps)||input.grant.sourceIntentHash!==intent.intentHash||input.grant.sourceHeadHash!==state.head||input.grant.themeZipSha256!==intent.themeZipSha256)fail('CONTINUATION_AUTHORIZATION_MISMATCH');
  const destination=await safeDirectory(input.directory,{newDirectory:true});
  const canonicalRegistry=runtimeRegistry(intent.runtimeProfile);
  profilePaths(intent.runtimeProfile,intent.registryDirectory,destination,intent.projectId,{continuation:true});
  if(destination===source.directory||inside(source.directory,destination)||inside(destination,source.directory)||destination===intent.registryDirectory||inside(intent.registryDirectory,destination)||inside(destination,intent.registryDirectory)||destination===canonicalRegistry||inside(canonicalRegistry,destination)||inside(destination,canonicalRegistry))fail('CONTINUATION_DIRECTORY_MISMATCH');
  try{await fs.lstat(destination);fail('CONTINUATION_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  await ensureContinuationRegistry(intent.runtimeProfile);
  const runnerLock=path.join(canonicalRegistry,`${intent.registryKey}.runner-lock`);
  try{await fs.mkdir(runnerLock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('CONTINUATION_SOURCE_BUSY');throw error;}
  try{
  const lockedSource=await immutableJournalSnapshot(source.directory,input.context);
  if(lockedSource.snapshotHash!==source.snapshotHash)fail('CONTINUATION_SOURCE_CHANGED');
  const body={schemaVersion:1,kind:'molyvi_basic_immutable_source_continuation',registryKey:intent.registryKey,intentHash:intent.intentHash,originalRegistryDirectory:intent.registryDirectory,sourceDirectory:source.directory,journalDirectory:destination,sourceHash:source.snapshotHash,sourceEventCount:state.eventCount,sourceFiles:source.records,allowedSteps,authorizationSha256:hash(input.grant),publicationAuthorized:false,newChargesAuthorized:false};
  try{await writeNew(continuationFile(intent.registryKey,intent.runtimeProfile),{...body,recordHash:hash(body)});}catch(error){if(error.code==='EEXIST')fail('CONTINUATION_ALREADY_RESERVED');throw error;}
  // Source writers observe the reservation before acquiring and after acquiring
  // their lock. If an earlier operation was already in flight, retain the
  // reservation and stop rather than copy an uncertain prefix.
  const afterReservation=await immutableJournalSnapshot(source.directory,input.context);
  if(afterReservation.snapshotHash!==source.snapshotHash)fail('CONTINUATION_SOURCE_CHANGED');
  await fs.mkdir(destination,{mode:0o700});
  for(const [name,data]of source.bytes){const handle=await fs.open(path.join(destination,name),'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}
  return await readBasicInstallation({directory:destination,context:input.context});
  }finally{await fs.rmdir(runnerLock);}
}
/** Claimed items remain unknown after restart. Merely reading never retries. */
export async function readBasicInstallation(options={}){return withLock(options,(directory,context)=>readState(directory,context));}
async function withLock(options,operation){
  const context=structuredClone(options.context),directory=await safeDirectory(options.directory),lock=path.join(directory,'.writer-lock');
  await assertWritableJournal(directory);
  try{await fs.mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('BUSY_OR_INTERRUPTED_LOCK');throw error;}
  try{await assertWritableJournal(directory);return await operation(directory,context);}finally{await fs.rmdir(lock);}
}
async function mutate(options,build){
  return withLock(options,async(directory,context)=>{
    const state=await readState(directory,context),event=build(state);
    if(!event)return {...state,duplicate:true};
    if(state.eventCount>=MAX_EVENTS)fail('JOURNAL_LIMIT');
    const body={...event,sequence:state.eventCount+1,previousHash:state.head,intentHash:state.intentHash};
    applyEvent(structuredClone(state),body);
    const eventHash=hash(body);
    // Persist a high-water mark before the event. Any interrupted gap, missing
    // tail or leftover checkpoint is an investigation, never a retry. This is
    // not a power-loss atomicity guarantee or tamper-proof external audit log.
    await writeNew(path.join(directory,'head.next.json'),{intentHash:state.intentHash,sequence:body.sequence,eventHash});
    await renameBasicInstallationCheckpoint(directory);
    await writeNew(path.join(directory,eventName(body.sequence)),{...body,eventHash});
    return {...await readState(directory,context),duplicate:false};
  });
}
export async function claimBasicInstallationStep(options){
  const key=options.key;return mutate(options,state=>{
    const current=state.steps[key];if(!current)fail('UNKNOWN_STEP');
    if(current.status==='succeeded')return null;
    if(state.continuation&&!state.continuation.allowedSteps.includes(key))fail('CONTINUATION_STEP_FORBIDDEN');
    if(current.status!=='pending')fail('RECONCILIATION_REQUIRED');
    return {type:'claim',key,attemptId:crypto.randomUUID()};
  });
}
async function recordReceipt(options,reconcile){
  const input=structuredClone({key:options.key,attemptId:options.attemptId,receipt:options.receipt,reconciliationEvidence:options.reconciliationEvidence});
  return mutate(options,state=>{
    const step=state.intent.steps.find(s=>s.key===input.key),current=state.steps[input.key];if(!step)fail('UNKNOWN_STEP');
    if(current.status==='succeeded'){
      const normalized={...input.receipt,evidence:evidence(input.receipt?.evidence)};
      if(current.attemptId!==input.attemptId||!equal(current.receipt,normalized))fail('RECEIPT_REPLAY_MISMATCH');return null;
    }
    if(current.status!=='claimed_outcome_unknown'||current.attemptId!==input.attemptId)fail('INVALID_TRANSITION');
    const receipt=receiptFor(state,step,input.receipt);
    return {type:reconcile?'reconcile':'receipt',key:input.key,attemptId:input.attemptId,receipt,...(reconcile?{reconciliationEvidence:evidence(input.reconciliationEvidence)}:{})};
  });
}
export const recordBasicInstallationReceipt=options=>recordReceipt(options,false);
export const reconcileBasicInstallationStep=options=>recordReceipt(options,true);
export async function blockBasicInstallationStep(options){
  const input=structuredClone({key:options.key,attemptId:options.attemptId,reason:options.reason,evidence:options.evidence});
  return mutate(options,()=>({type:'block',...input,evidence:evidence(input.evidence)}));
}
export async function getBasicVisibilityScope(options){const state=await readBasicInstallation(options),scope=visibilityScope(state);return {...scope,scopeHash:hash(scope)};}
export async function claimBasicVisibilityReview(options){
  const input=structuredClone({authorization:options.authorization,evidence:options.evidence});
  return mutate(options,state=>({type:'visibility_claim',scope:visibilityScope(state),authorization:input.authorization,evidence:evidence(input.evidence)}));
}
export async function recordBasicRestoration(options){
  const input=structuredClone({observed:options.observed,evidence:options.evidence});
  return mutate(options,state=>{
    const normalized=evidence(input.evidence);
    if(state.visibility.status==='restored_operator_attested'){
      if(!equal(state.visibility.observed,input.observed)||!equal(state.visibility.evidence,normalized))fail('RESTORATION_REPLAY_MISMATCH');return null;
    }
    return {type:'restoration',observed:input.observed,evidence:normalized};
  });
}
