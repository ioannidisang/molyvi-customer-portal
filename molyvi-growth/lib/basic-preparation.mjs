import {allowsHostedBasicInstallReferenceProbe} from './basic-reference-install-probe-scope.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalJson, IntakeError, PRIVATE_ROOT} from './intake-store.mjs';
import {TaskStore} from './task-store.mjs';
import {inspectBasicSubmissionReadiness} from './basic-submission-readiness.mjs';
import {inspectHostedBasicCompositionCapacity} from './basic-preparation-capacity.mjs';
import {allowsHostedBasicReferenceProbe} from './basic-reference-probe-scope.mjs';

export const BASIC_PREPARATION_TARGET = 'molyvi-still-dev.myshopify.com';
export const BASIC_REFERENCE_PREPARATION_FORMAT = 'workspace_references_v1';
export const BASIC_PREPARATION_LIMITS = Object.freeze({metadataBytes:1024 * 1024, requests:100, requestsPerProject:8, recordBytes:32768});
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, status=409) => {throw new IntakeError(`BASIC_PREPARATION_${code}`, status);};
const inside = (root, value) => {const relative=path.relative(root,value);return relative!=='' && relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);};
const same = (a,b) => canonicalJson(a) === canonicalJson(b);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
const stamped = value => ({...value, recordHash:hash(value)});
const commonFields = ['schemaVersion','kind','projectId','ownerHash','requestId','sourceHash','recordHash'];
const requestFields = [...commonFields,'targetStore','selectionHash','createdAt','summary','catalogConfirmed'];
const attemptFields = [...commonFields,'requestHash','reservedAt'];
const resultFields = [...commonFields,'requestHash','attemptHash','finishedAt','state','code','artifacts'];
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

async function safeDirectory(directory, missing=false) {
  const absolute=path.resolve(directory), parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);let stat;
    try {stat=await fs.lstat(current);} catch(error) {if(missing && error.code==='ENOENT')return false;throw error;}
    if(!stat.isDirectory() || stat.isSymbolicLink())fail('UNSAFE_DIRECTORY',500);
  }
  return true;
}
async function ensureDirectory(directory) {
  if(!inside(PRIVATE_ROOT,directory))fail('PRIVATE_STORAGE_REQUIRED',500);
  await safeDirectory(PRIVATE_ROOT);let current=PRIVATE_ROOT;
  for(const part of path.relative(PRIVATE_ROOT,directory).split(path.sep)) {
    current=path.join(current,part);
    try {await fs.mkdir(current,{mode:0o700});} catch(error) {if(error.code!=='EEXIST')throw error;}
    await safeDirectory(current);
  }
}
async function readRecord(file) {
  const stat=await fs.lstat(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>BASIC_PREPARATION_LIMITS.recordBytes)fail('UNSAFE_RECORD',500);
  const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail('RECORD_CHANGED',409);
  let record;try {record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('RECORD_INVALID',500);}
  const {recordHash,...body}=record??{};
  if(!isHash(recordHash) || hash(body)!==recordHash)fail('RECORD_INVALID',500);
  return record;
}
function validateRecord(record, kind, request, ownerHash, projectId, referenceComposition=false) {
  const fields=[...(kind==='request'?requestFields:kind==='attempt'?attemptFields:resultFields),...(referenceComposition?['packageFormat']:[])];
  if(!exact(record,fields) || record.schemaVersion!==(referenceComposition?2:1) || referenceComposition&&record.packageFormat!==BASIC_REFERENCE_PREPARATION_FORMAT || record.kind!==`molyvi_basic_preparation_${kind}` || record.projectId!==projectId || record.ownerHash!==ownerHash || !uuid(record.requestId) || !isHash(record.sourceHash))fail('RECORD_BINDING',500);
  if(kind==='request') {
    const summary=record.summary;
    if(record.targetStore!==BASIC_PREPARATION_TARGET || !isHash(record.selectionHash) || !time(record.createdAt) || record.catalogConfirmed!==true || !exact(summary,['products','visualUnits','photos','pages']) || Object.values(summary).some(n=>!Number.isSafeInteger(n)||n<0) || summary.products<1 || summary.products>10 || summary.visualUnits<1 || summary.visualUnits>10 || summary.photos!==summary.visualUnits*3 || summary.pages!==7)fail('RECORD_BINDING',500);
  } else {
    if(record.requestId!==request.requestId || record.sourceHash!==request.sourceHash || record.requestHash!==request.recordHash)fail('RECORD_BINDING',500);
    if(kind==='attempt' && !time(record.reservedAt))fail('RECORD_BINDING',500);
    if(kind==='result') {
      if(!time(record.finishedAt)||!isHash(record.attemptHash)||!['prepared','failed'].includes(record.state)||typeof record.code!=='string'||!/^[A-Z0-9_]{1,100}$/.test(record.code))fail('RECORD_BINDING',500);
      if(record.state==='prepared' && (record.code!=='PREPARED_FOR_INSTALLATION_REVIEW'||!exact(record.artifacts,['planHash','packageManifestSha256','themeManifestSha256','themeZipSha256'])||Object.values(record.artifacts).some(value=>!isHash(value))))fail('RECORD_BINDING',500);
      if(record.state==='failed' && record.artifacts!==null)fail('RECORD_BINDING',500);
    }
  }
  return record;
}

// Metadata is independent of workspace.json, so requesting preparation cannot
// invalidate the assembler's immutable full-workspace source hash. No startup
// directory creation, provider imports, credentials, timers or network calls.
export async function createBasicPreparationService({store,storage,targetStore=BASIC_PREPARATION_TARGET,buildEnabled=false,buildRoot,themeSource,upstreamPath,hostedCompact=false,referenceComposition=false,decodeImage,clock=Date.now}={}) {
  if(!(store instanceof TaskStore) || typeof storage!=='string' || targetStore!==BASIC_PREPARATION_TARGET || typeof buildEnabled!=='boolean' || typeof hostedCompact!=='boolean' || typeof referenceComposition!=='boolean' || typeof clock!=='function')fail('CONFIG_INVALID',500);
  // Explicit LOCAL integration. The existing hosted aggregate-input and memory
  // admission still apply to its old profile; this option cannot bypass them.
  if(referenceComposition&&(hostedCompact||process.env.RENDER_SERVICE_ID&&!allowsHostedBasicReferenceProbe({store,storage,buildRoot})&&!allowsHostedBasicInstallReferenceProbe({store,storage,buildRoot})))fail('REFERENCE_HOSTED_NOT_ENABLED',403);
  if(referenceComposition&&(!buildEnabled||typeof decodeImage!=='function')||!referenceComposition&&decodeImage!==undefined)fail('REFERENCE_CONFIG_INVALID',500);
  const version=referenceComposition?{schemaVersion:2,packageFormat:BASIC_REFERENCE_PREPARATION_FORMAT}:{schemaVersion:1};
  const validate=(...args)=>validateRecord(...args,referenceComposition);
  const compactTheme=hostedCompact||referenceComposition;
  storage=path.resolve(storage);
  if(!inside(PRIVATE_ROOT,storage) || storage===store.storage || inside(store.storage,storage) || inside(storage,store.storage))fail('PRIVATE_STORAGE_REQUIRED',500);
  if(!buildEnabled && (hostedCompact||[buildRoot,themeSource,upstreamPath].some(value=>value!==undefined)))fail('BUILD_CONFIG_DISABLED',500);
  if(buildEnabled) {
    if(typeof buildRoot!=='string')fail('BUILD_ROOT_REQUIRED',500);
    buildRoot=path.resolve(buildRoot);
    if(!inside(PRIVATE_ROOT,buildRoot)||buildRoot===storage||inside(storage,buildRoot)||inside(buildRoot,storage)||buildRoot===store.storage||inside(store.storage,buildRoot)||inside(buildRoot,store.storage))fail('PRIVATE_BUILD_ROOT_REQUIRED',500);
    if(hostedCompact&&(path.basename(store.storage)!=='workspaces'||storage!==path.join(path.dirname(store.storage),'controlled-operations','basic-preparation')||buildRoot!==path.join(path.dirname(store.storage),'controlled-operations','basic-composition')))fail('HOSTED_BUILD_SCOPE',500);
  }
  await safeDirectory(storage,true);if(buildEnabled)await safeDirectory(buildRoot,true);
  const locks=new Map();let mutations=Promise.resolve();
  const serial=async (key,fn)=>{const previous=locks.get(key)??Promise.resolve(),next=previous.catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}};
  const mutate=fn=>{const next=mutations.catch(()=>{}).then(fn);mutations=next;return next;};
  const sessionBinding=session=>{if(!uuid(session?.projectId)||!uuid(session?.ownerId))fail('SESSION_REQUIRED',401);return {projectId:session.projectId,ownerId:session.ownerId,ownerHash:hash(session.ownerId)};};
  const now=()=>{const value=clock();if(!Number.isSafeInteger(value)||value<0)fail('CLOCK_INVALID',500);return new Date(value).toISOString();};
  const paths=(projectId,requestId)=>{const project=path.join(storage,projectId);return {project,directory:requestId?path.join(project,requestId):null};};
  async function usage() {
    if(!await safeDirectory(storage,true))return {bytes:0,requests:0};
    let bytes=0,requests=0;
    for(const project of await fs.readdir(storage)) {
      if(!uuid(project))fail('STORAGE_CONTENT_INVALID',500);
      const projectDirectory=path.join(storage,project);await safeDirectory(projectDirectory);
      const entries=await fs.readdir(projectDirectory);if(entries.length>BASIC_PREPARATION_LIMITS.requestsPerProject)fail('METADATA_LIMIT',429);
      for(const id of entries) {
        if(!uuid(id)||++requests>BASIC_PREPARATION_LIMITS.requests)fail('METADATA_LIMIT',429);
        const directory=path.join(projectDirectory,id);await safeDirectory(directory);
        for(const name of await fs.readdir(directory)) {
          if(!['request.json','attempt.json','result.json'].includes(name))fail('STORAGE_CONTENT_INVALID',500);
          const stat=await fs.lstat(path.join(directory,name));
          if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>BASIC_PREPARATION_LIMITS.recordBytes)fail('UNSAFE_RECORD',500);
          bytes+=stat.size;if(bytes>BASIC_PREPARATION_LIMITS.metadataBytes)fail('METADATA_LIMIT',429);
        }
      }
    }
    return {bytes,requests};
  }
  async function writeNew(file, record) {
    const bytes=Buffer.from(JSON.stringify(record)+'\n'),size=await usage();
    if(bytes.length>BASIC_PREPARATION_LIMITS.recordBytes||size.bytes+bytes.length>BASIC_PREPARATION_LIMITS.metadataBytes)fail('METADATA_LIMIT',429);
    await safeDirectory(path.dirname(file));
    const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  }
  async function entries(binding) {
    const project=paths(binding.projectId).project;if(!await safeDirectory(project,true))return [];
    const names=await fs.readdir(project);if(names.length>BASIC_PREPARATION_LIMITS.requestsPerProject)fail('METADATA_LIMIT',429);
    const result=[];
    for(const name of names) {
      if(!uuid(name))fail('STORAGE_CONTENT_INVALID',500);
      const directory=paths(binding.projectId,name).directory;await safeDirectory(directory);
      const files=await fs.readdir(directory);
      if(!files.includes('request.json')||files.some(file=>!['request.json','attempt.json','result.json'].includes(file)))fail('INCOMPLETE_RECORD',409);
      const request=validate(await readRecord(path.join(directory,'request.json')),'request',null,binding.ownerHash,binding.projectId);
      if(request.requestId!==name)fail('RECORD_BINDING',500);
      const attempt=files.includes('attempt.json')?validate(await readRecord(path.join(directory,'attempt.json')),'attempt',request,binding.ownerHash,binding.projectId):null;
      const outcome=files.includes('result.json')?validate(await readRecord(path.join(directory,'result.json')),'result',request,binding.ownerHash,binding.projectId):null;
      if(outcome&&(!attempt||outcome.attemptHash!==attempt.recordHash))fail('RECORD_BINDING',500);
      result.push({request,attempt,outcome});
    }
    return result.sort((a,b)=>a.request.createdAt.localeCompare(b.request.createdAt)||a.request.requestId.localeCompare(b.request.requestId));
  }
  async function openComposition(binding,record){
    const {createBasicAssemblyBinding,prepareStoredBasicReferenceComposition}=await import('./basic-store-package.mjs');
    return prepareStoredBasicReferenceComposition(store,binding,{targetStore,binding:createBasicAssemblyBinding(record,{targetStore}),decodeImage});
  }
  async function verifyPreparedOutput(binding,requestId,artifacts,composition) {
    const output=path.join(buildRoot,`${binding.projectId}-${requestId}`);await safeDirectory(output);
    const read=async(file,maximum)=>{await safeDirectory(path.dirname(file));const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maximum)fail('OUTPUT_CHANGED');const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail('OUTPUT_CHANGED');return bytes;};
    const inventory=async(directory,prefix='')=>{await safeDirectory(directory);let files=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const name=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(directory,entry.name);if(entry.isSymbolicLink())fail('OUTPUT_CHANGED');if(entry.isDirectory())files.push(...await inventory(file,name));else if(entry.isFile())files.push(name);else fail('OUTPUT_CHANGED');if(files.length>4096)fail('OUTPUT_CHANGED');}return files.sort();};
    const checkFiles=async(directory,records,extra=[])=>{
      if(!Array.isArray(records)||records.length>4096||new Set(records.map(item=>item.file)).size!==records.length)fail('OUTPUT_CHANGED');
      for(const item of records) {
        if(typeof item.file!=='string'||/[\\:\x00-\x1f]/.test(item.file)||item.file.split('/').some(bit=>!bit||bit==='.'||bit==='..')||!Number.isSafeInteger(item.bytes)||item.bytes<0||!isHash(item.sha256))fail('OUTPUT_CHANGED');
        const bytes=await read(path.join(directory,...item.file.split('/')),item.bytes);if(bytes.length!==item.bytes||bytesHash(bytes)!==item.sha256)fail('OUTPUT_CHANGED');
      }
      if(!same(await inventory(directory),[...records.map(item=>item.file),...extra].sort()))fail('OUTPUT_CHANGED');
    };
    const packageDirectory=path.join(output,'package'),themeDirectory=path.join(output,'theme');
    const packageBytes=await read(path.join(packageDirectory,'manifest.json'),1024*1024),themeBytes=await read(path.join(themeDirectory,'manifest.json'),1024*1024);
    if(bytesHash(packageBytes)!==artifacts.packageManifestSha256||bytesHash(themeBytes)!==artifacts.themeManifestSha256)fail('OUTPUT_CHANGED');
    const packageManifest=JSON.parse(packageBytes),themeManifest=JSON.parse(themeBytes);
    if(packageManifest.projectId!==binding.projectId||themeManifest.projectId!==binding.projectId||packageManifest.planHash!==artifacts.planHash||themeManifest.planHash!==artifacts.planHash||themeManifest.zip?.file!=='MOLYVI_Basic_Draft.zip'||themeManifest.zip.sha256!==artifacts.themeZipSha256)fail('OUTPUT_CHANGED');
    if(referenceComposition){
      const {verifyBasicReferenceComposition}=await import('./basic-reference-composition.mjs');
      const plan=verifyBasicReferenceComposition(composition);
      if(packageManifest.kind!=='molyvi_basic_reference_metadata_package'||packageManifest.sourceRecordHash!==plan.source.recordHash||packageManifest.planHash!==plan.planHash||packageManifest.imageBytesCopied!==0||packageManifest.standalone!==false||packageManifest.applicationAuthorized!==false||packageManifest.publicationAuthorized!==false)fail('OUTPUT_CHANGED');
      const savedPlan=JSON.parse(await read(path.join(packageDirectory,'package-plan.json'),1024*1024));
      const refs=JSON.parse(await read(path.join(packageDirectory,'asset-references.json'),1024*1024));
      const {referenceHash,...body}=refs;
      if(!same(savedPlan,plan)||hash(body)!==referenceHash||referenceHash!==packageManifest.referenceHash||refs.ownerHash!==binding.ownerHash||refs.projectId!==binding.projectId||refs.sourceHash!==plan.source.recordHash||refs.planHash!==plan.planHash||!same(refs.assets,composition.assets))fail('OUTPUT_CHANGED');
      await composition.revalidate();
    }
    await checkFiles(packageDirectory,packageManifest.files,['manifest.json']);
    if(!compactTheme)await checkFiles(path.join(themeDirectory,'theme'),themeManifest.files);
    const zip=await read(path.join(themeDirectory,'MOLYVI_Basic_Draft.zip'),themeManifest.zip.bytes);
    if(zip.length!==themeManifest.zip.bytes||bytesHash(zip)!==artifacts.themeZipSha256)fail('OUTPUT_CHANGED');
    if(compactTheme){
      const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
      const archive=await JSZip.loadAsync(zip,{checkCRC32:true}),expected=themeManifest.files.filter(item=>!item.file.split('/').some(bit=>bit.startsWith('.')));
      if(!same(Object.keys(archive.files).sort(),expected.map(item=>item.file).sort()))fail('OUTPUT_CHANGED');
      for(const item of expected){const entry=archive.files[item.file];if(entry.dir||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>32*1024*1024)fail('OUTPUT_CHANGED');const bytes=await entry.async('nodebuffer');if(bytes.length!==item.bytes||bytesHash(bytes)!==item.sha256)fail('OUTPUT_CHANGED');}
    }else{const upstream=await read(path.join(themeDirectory,'upstream.json'),32768);if(bytesHash(upstream)!==themeManifest.upstream?.recordSha256)fail('OUTPUT_CHANGED');}
    if(!same((await fs.readdir(output)).sort(),['package','theme'])||!same((await fs.readdir(themeDirectory)).sort(),(compactTheme?['MOLYVI_Basic_Draft.zip','manifest.json']:['MOLYVI_Basic_Draft.zip','manifest.json','theme','upstream.json']).sort()))fail('OUTPUT_CHANGED');
    if(referenceComposition)await composition.revalidate();
  }
  function publicRequest(item,sourceHash) {
    if(!item)return null;
    const {request,attempt,outcome}=item;
    const state=request.sourceHash!==sourceHash?'source_changed':outcome?.state==='prepared'?'prepared_for_installation_review':outcome?'preparation_failed':attempt?'preparation_unknown':'requested';
    return {requestId:request.requestId,state,sourceHash:request.sourceHash,requestedAt:request.createdAt,counts:structuredClone(request.summary),...(outcome?.state==='prepared'&&state!=='source_changed'?{preparedAt:outcome.finishedAt,planHash:outcome.artifacts.planHash,themeZipSha256:outcome.artifacts.themeZipSha256}:{}),outputVerifiedNow:false,installationEnabled:false,published:false};
  }
  const publicStatus=(readiness,list,projectId)=>({mode:'preparation_only',projectId,sourceHash:readiness.sourceHash,readiness,request:publicRequest(list.find(item=>item.request.sourceHash===readiness.sourceHash)??list.at(-1),readiness.sourceHash),installationEnabled:false,published:false});
  async function status(session) {
    const binding=sessionBinding(session);
    return serial(binding.projectId,async()=>{
      const record=await store.read(binding.projectId,binding.ownerId),readiness=inspectBasicSubmissionReadiness(record);
      return publicStatus(readiness,await entries(binding),binding.projectId);
    });
  }
  async function request(session,command) {
    if(!exact(command,['expectedSourceHash','acknowledged'])||!isHash(command.expectedSourceHash)||command.acknowledged!==true)fail('INVALID_REQUEST',400);
    const binding=sessionBinding(session);
    return serial(binding.projectId,()=>mutate(()=>store.serial(binding.projectId,async()=>{
      // Already holding TaskStore's lock: load directly; never call read here.
      const {record}=await store.load(binding.projectId,binding.ownerId),readiness=inspectBasicSubmissionReadiness(record);
      if(readiness.sourceHash!==command.expectedSourceHash||readiness.sourceHash!==hash(record))fail('SOURCE_CHANGED');
      const list=await entries(binding),existing=list.find(item=>item.request.sourceHash===readiness.sourceHash);
      if(existing)return {...publicStatus(readiness,list,binding.projectId),duplicate:true};
      if(!readiness.ready)fail('NOT_READY',422);
      if(list.length>=BASIC_PREPARATION_LIMITS.requestsPerProject)fail('PROJECT_REQUEST_LIMIT',429);
      const used=await usage();if(used.requests>=BASIC_PREPARATION_LIMITS.requests)fail('METADATA_LIMIT',429);
      const requestId=crypto.randomUUID(),directory=paths(binding.projectId,requestId).directory;
      const saved=stamped({...version,kind:'molyvi_basic_preparation_request',projectId:binding.projectId,ownerHash:binding.ownerHash,requestId,sourceHash:readiness.sourceHash,targetStore,selectionHash:hash(readiness.source),createdAt:now(),summary:structuredClone(readiness.summary),catalogConfirmed:true});
      validate(saved,'request',null,binding.ownerHash,binding.projectId);
      if(used.bytes+Buffer.byteLength(JSON.stringify(saved))+8192>BASIC_PREPARATION_LIMITS.metadataBytes)fail('METADATA_LIMIT',429);
      await ensureDirectory(paths(binding.projectId).project);
      await fs.mkdir(directory,{mode:0o700});await writeNew(path.join(directory,'request.json'),saved);
      return {...publicStatus(readiness,[...list,{request:saved,attempt:null,outcome:null}],binding.projectId),duplicate:false};
    })));
  }
  async function prepare(session,command) {
    if(!buildEnabled)fail('LOCAL_BUILD_DISABLED',403);
    if(!exact(command,['requestId'])||!uuid(command.requestId))fail('INVALID_REQUEST',400);
    const binding=sessionBinding(session);
    return serial(binding.projectId,async()=>{
      const record=await store.read(binding.projectId,binding.ownerId),readiness=inspectBasicSubmissionReadiness(record),list=await entries(binding),item=list.find(value=>value.request.requestId===command.requestId);
      if(!item)fail('REQUEST_NOT_FOUND',404);
      if(item.request.sourceHash!==hash(record)||item.request.sourceHash!==readiness.sourceHash||item.request.selectionHash!==hash(readiness.source))fail('SOURCE_CHANGED');
      if(!readiness.ready)fail('NOT_READY',422);
      if(item.outcome?.state==='prepared') {
        await verifyPreparedOutput(binding,command.requestId,item.outcome.artifacts,referenceComposition?await openComposition(binding,record):undefined);
        if(hostedCompact)await inspectHostedBasicCompositionCapacity({store,session:binding,record,buildRoot,themeSource,after:true});
        if(hash(await store.read(binding.projectId,binding.ownerId))!==readiness.sourceHash)fail('SOURCE_CHANGED');
        const status=publicStatus(readiness,list,binding.projectId);status.request.outputVerifiedNow=true;return {...status,duplicate:true};
      }
      if(item.attempt)fail('ATTEMPT_ALREADY_RESERVED');
      if(hostedCompact)await inspectHostedBasicCompositionCapacity({store,session:binding,record,buildRoot,themeSource});
      const directory=paths(binding.projectId,command.requestId).directory;
      const attempt=stamped({...version,kind:'molyvi_basic_preparation_attempt',projectId:binding.projectId,ownerHash:binding.ownerHash,requestId:command.requestId,sourceHash:readiness.sourceHash,requestHash:item.request.recordHash,reservedAt:now()});
      await mutate(()=>writeNew(path.join(directory,'attempt.json'),attempt));
      let artifacts=null;
      try {
        // Trusted composition after a durable one-attempt reservation. Hosted
        // callers hold the server mutation lease; HTTP cannot supply settings.
        const {createBasicAssemblyBinding,prepareStoredBasicStorePackage,writeBasicStorePackage}=await import('./basic-store-package.mjs');
        const {buildBasicThemePackage,buildBasicReferenceThemePackage}=await import('./basic-theme-package.mjs');
        const prepared=referenceComposition?await openComposition(binding,record):await prepareStoredBasicStorePackage(store,binding,{targetStore,binding:createBasicAssemblyBinding(record,{targetStore})});
        await ensureDirectory(buildRoot);const output=path.join(buildRoot,`${binding.projectId}-${command.requestId}`);
        await fs.mkdir(output,{mode:0o700});
        const writePackage=referenceComposition?(await import('./basic-reference-output.mjs')).writeBasicReferenceMetadataPackage:writeBasicStorePackage;
        const written=await writePackage(prepared,{outputDirectory:path.join(output,'package')});
        const theme=await (referenceComposition?buildBasicReferenceThemePackage:buildBasicThemePackage)(prepared,{outputDirectory:path.join(output,'theme'),compact:compactTheme,...(themeSource?{themeSource}:{}),...(upstreamPath?{upstreamPath}:{})});
        artifacts={planHash:prepared.plan.planHash,packageManifestSha256:written.manifestSha256,themeManifestSha256:theme.manifestSha256,themeZipSha256:theme.zipSha256};
        await verifyPreparedOutput(binding,command.requestId,artifacts,referenceComposition?prepared:undefined);
        if(hostedCompact)await inspectHostedBasicCompositionCapacity({store,session:binding,record,buildRoot,themeSource,after:true});
        await mutate(()=>store.serial(binding.projectId,async()=>{
          const {record:latest}=await store.load(binding.projectId,binding.ownerId);
          if(hash(latest)!==readiness.sourceHash)fail('SOURCE_CHANGED_DURING_BUILD');
          const outcome=stamped({...version,kind:'molyvi_basic_preparation_result',projectId:binding.projectId,ownerHash:binding.ownerHash,requestId:command.requestId,sourceHash:readiness.sourceHash,requestHash:item.request.recordHash,attemptHash:attempt.recordHash,finishedAt:now(),state:'prepared',code:'PREPARED_FOR_INSTALLATION_REVIEW',artifacts});
          await writeNew(path.join(directory,'result.json'),outcome);item.attempt=attempt;item.outcome=outcome;
        }));
      } catch(error) {
        const errorCode=/^[A-Z0-9_]{1,100}$/.test(error?.code??'')?error.code:'BUILD_STOPPED';
        const outcome=stamped({...version,kind:'molyvi_basic_preparation_result',projectId:binding.projectId,ownerHash:binding.ownerHash,requestId:command.requestId,sourceHash:readiness.sourceHash,requestHash:item.request.recordHash,attemptHash:attempt.recordHash,finishedAt:now(),state:'failed',code:errorCode,artifacts:null});
        // Never overwrite a completion or recover a partial reservation. If this
        // immutable write also fails, the reserved attempt remains unknown.
        await mutate(()=>writeNew(path.join(directory,'result.json'),outcome));
        throw new IntakeError(errorCode,409);
      }
      const result=publicStatus(readiness,list,binding.projectId);result.request.outputVerifiedNow=true;return {...result,duplicate:false};
    });
  }
  // Trusted backend handoff only. There is deliberately no HTTP route for this
  // method and no caller-provided path, target, owner, package or authorization.
  async function loadPrepared(session,command){
    if(!buildEnabled)fail('LOCAL_BUILD_DISABLED',403);
    if(!exact(command,['requestId'])||!uuid(command.requestId))fail('INVALID_REQUEST',400);
    const binding=sessionBinding(session);
    return serial(binding.projectId,async()=>{
      const record=await store.read(binding.projectId,binding.ownerId),readiness=inspectBasicSubmissionReadiness(record),list=await entries(binding),item=list.find(value=>value.request.requestId===command.requestId);
      if(!item||item.outcome?.state!=='prepared')fail('PREPARED_RESULT_REQUIRED');
      if(!readiness.ready||item.request.sourceHash!==readiness.sourceHash||item.request.selectionHash!==hash(readiness.source))fail('SOURCE_CHANGED');
      if(hostedCompact)await inspectHostedBasicCompositionCapacity({store,session:binding,record,buildRoot,themeSource,after:true});
      if(!referenceComposition)await verifyPreparedOutput(binding,command.requestId,item.outcome.artifacts);
      const {createBasicAssemblyBinding,prepareStoredBasicStorePackage}=await import('./basic-store-package.mjs');
      const prepared=referenceComposition?await openComposition(binding,record):await prepareStoredBasicStorePackage(store,binding,{targetStore,binding:createBasicAssemblyBinding(record,{targetStore})});
      if(referenceComposition)await verifyPreparedOutput(binding,command.requestId,item.outcome.artifacts,prepared);
      if(prepared.plan.planHash!==item.outcome.artifacts.planHash)fail('OUTPUT_CHANGED');
      const directory=path.join(buildRoot,`${binding.projectId}-${command.requestId}`,'theme'),manifestBytes=await fs.readFile(path.join(directory,'manifest.json')),zipBytes=await fs.readFile(path.join(directory,'MOLYVI_Basic_Draft.zip'));
      if(bytesHash(manifestBytes)!==item.outcome.artifacts.themeManifestSha256||bytesHash(zipBytes)!==item.outcome.artifacts.themeZipSha256)fail('OUTPUT_CHANGED');
      const manifest=JSON.parse(manifestBytes.toString('utf8'));
      if(hash(await store.read(binding.projectId,binding.ownerId))!==readiness.sourceHash)fail('SOURCE_CHANGED');
      const confirmation={requestId:command.requestId,sourceHash:item.request.sourceHash,requestHash:item.request.recordHash,projectId:binding.projectId,ownerHash:binding.ownerHash,planHash:prepared.plan.planHash,themeZipSha256:item.outcome.artifacts.themeZipSha256};
      if(referenceComposition)await prepared.revalidate();
      return {...(referenceComposition?{referenceComposition:prepared}:{prepared}),theme:{manifest,zipBytes},confirmation};
    });
  }
  return Object.freeze({status,request,prepare,loadPrepared});
}
