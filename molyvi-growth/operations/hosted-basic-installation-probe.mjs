// One-use resident composition + actual installer with injected local Shopify.
// No real Shopify, AI, mail, backup creation or customer registration.
import fs from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {installPreparedBasicReference} from '../lib/basic-prepared-reference-installer.mjs';
import {createReferenceDiskWorld} from '../tests/helpers/shopify-basic-reference-disk-world.mjs';
import {BASIC_THEME_PROGRESS_ROOT} from '../lib/basic-theme-progress.mjs';
import {canonicalJson} from '../lib/intake-store.mjs';
import {TaskStore} from '../lib/task-store.mjs';
import {createBasicPreparationService} from '../lib/basic-preparation.mjs';
import {createShopifyImageDecoder} from '../lib/shopify-image-decoder.mjs';
import {BASIC_INSTALL_PROBE_ROOT,BASIC_INSTALL_PROBE_SERVICE,validateBasicInstallProbePermit,withHostedBasicInstallReferenceScope} from '../lib/basic-reference-install-probe-scope.mjs';
import {captureHostedProbePreservation} from './r2-backup/hosted-memory-probe.mjs';
import {readLinuxMemorySample} from './r2-backup/hosted-memory-probe-sampler.mjs';

const configs=new WeakSet(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,c)=>{if(!v)throw Error(c);};
const sourceRoot='/opt/render/project/src/briefs/molyvi-hosted-staging';
const fixtureUrl=new URL('./basic-probe/fixture.json',import.meta.url);
const ownerPaths=new Set(['.photo-review-worker.lock','.product-production-worker.lock','.service-production-worker.lock'].map(x=>'workspaces/'+x+'/owner.json'));
export const BASIC_INSTALL_RESIDENT_POLICY=Object.freeze({limitBytes:512*1024*1024,baselineRssBytes:192*1024*1024,baselineAnonBytes:192*1024*1024,rssStopBytes:416*1024*1024,anonStopBytes:416*1024*1024,currentWarningBytes:496*1024*1024,deadlineMs:30*60*1000,sourceCap:512_000_000,reserve:12*1024*1024,scratchBudget:100*1024*1024,requiredFreeBytes:1024*1024*1024});
const P=BASIC_INSTALL_RESIDENT_POLICY;
async function safe(file,directory=false){
  if(file instanceof URL)file=fileURLToPath(file);
  file=path.resolve(file);let at=path.parse(file).root;
  for(const part of file.slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,part);const s=await fs.lstat(at);check(!s.isSymbolicLink()&&(at!==file||directory?s.isDirectory():s.isFile()&&s.nlink===1),'BASIC_INSTALL_PROBE_UNSAFE_PATH');}
  check(await fs.realpath(file)===file,'BASIC_INSTALL_PROBE_ALIAS');return file;
}
async function digest(file){
  await safe(file);const before=await fs.stat(file),h=crypto.createHash('sha256');let bytes=0;
  for await(const b of createReadStream(file,{highWaterMark:65536})){h.update(b);bytes+=b.length;}
  const after=await fs.stat(file);check(bytes===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ino===before.ino,'BASIC_INSTALL_PROBE_FILE_CHANGED');
  return {bytes,sha256:h.digest('hex')};
}
async function read(file,max=1024*1024){await safe(file);check((await fs.stat(file)).size<=max,'BASIC_INSTALL_PROBE_METADATA_LIMIT');const raw=await fs.readFile(file);return {raw,hash:sha(raw),value:JSON.parse(raw)};}
async function save(file,value){
  const raw=Buffer.from(JSON.stringify(value,null,2)+'\n');check(raw.length<=8*1024*1024,'BASIC_INSTALL_PROBE_METADATA_LIMIT');
  const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}
  if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
  return sha(raw);
}
async function inventory(root,prefix=''){
  const rows=[];await safe(root,true);
  for(const e of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,e.name),name=prefix?prefix+'/'+e.name:e.name;
    if(e.isDirectory()&&!e.isSymbolicLink())rows.push(...await inventory(file,name));else rows.push({file:name,...await digest(file)});
  }return rows.sort((a,b)=>a.file.localeCompare(b.file));
}
async function controls(permit){
  const rows=[];for(const p of permit.controls){const a=await digest(path.join(path.dirname(sourceRoot),p.file));check(a.sha256===p.sha256,'BASIC_INSTALL_PROBE_CONTROL_CHANGED');rows.push({file:p.file,...a});}return rows;
}
async function capture(config){
  const state=await captureHostedProbePreservation(config);
  return {...state,files:state.files.filter(x=>!ownerPaths.has(x.file)),generationControls:await controls(config.permit),excludedWorkerOwnerPaths:[...ownerPaths]};
}
export async function loadHostedBasicInstallationProbe({permitFile,source,probeRoot,release,serviceId}){
  try{await fs.lstat(permitFile);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(process.platform==='linux'&&probeRoot===BASIC_INSTALL_PROBE_ROOT&&permitFile===BASIC_INSTALL_PROBE_ROOT+'/permit.json'&&source===sourceRoot,'BASIC_INSTALL_PROBE_FIXED_SCOPE');
  await safe(probeRoot,true);const p=await read(permitFile,128*1024);
  validateBasicInstallProbePermit(p.value,{release,serviceId,checkExpiry:false});
  check((await digest(fixtureUrl)).sha256===p.value.fixtureSha256,'BASIC_INSTALL_PROBE_FIXTURE_CHANGED');
  const c=Object.freeze({permitFile,source,probeRoot,release,serviceId,permitHash:p.hash,runId:p.value.runId,permit:p.value});configs.add(c);return c;
}
async function priorOutcome(config){
  let a;try{a=await read(config.probeRoot+'/attempt.json');}catch(e){if(e.code==='ENOENT')return null;throw e;}
  check(a.value.permitHash===config.permitHash&&a.value.release===config.release&&a.value.runId===config.runId,'BASIC_INSTALL_PROBE_ATTEMPT_CONFLICT');
  try{await fs.lstat(config.probeRoot+'/failure.json');return {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:false};}catch(e){if(e.code!=='ENOENT')throw e;}
  try{const c=await read(config.probeRoot+'/complete.json'),r=await read(config.probeRoot+'/report.json');
    verifyBasicInstallProbeCompletion({permitHash:config.permitHash,release:config.release,runId:config.runId,attempt:a,complete:c.value,report:r});
    return {status:'SKIP_VERIFIED_PASS',allowAutomaticStart:true,reportHash:r.hash};
  }catch(e){if(e.code!=='ENOENT')throw e;return {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:false};}
}
export function verifyBasicInstallProbeCompletion({permitHash,release,runId,attempt,complete,report}){
  check(complete?.permitHash===permitHash&&complete.attemptHash===attempt?.hash&&complete.reportHash===report?.hash&&report.value.status==='PASS'&&report.value.permitHash===permitHash&&report.value.release===release&&report.value.runId===runId&&report.value.sourceUnchanged===true,'BASIC_INSTALL_PROBE_COMPLETION_INVALID');
  return true;
}
async function sampler(root,deadline,flags){
  const initial=await readLinuxMemorySample();check(initial.limitBytes===P.limitBytes&&initial.rssBytes<=P.baselineRssBytes&&initial.nonreclaimableEstimateBytes<=P.baselineAnonBytes,'BASIC_INSTALL_PROBE_INITIAL_MEMORY');
  check(!initial.events.oom&&!initial.events.oom_kill,'BASIC_INSTALL_PROBE_EXISTING_OOM');
  const worker=new Worker(new URL('./r2-backup/hosted-memory-probe-sampler.mjs',import.meta.url),{workerData:{shared:flags.buffer,logFile:root+'/memory-samples.jsonl',deadline,policy:P,initial,cgroup:'/sys/fs/cgroup',proc:'/proc',pid:process.pid,threadLabel:'basic-installation-observer'},resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4,stackSizeMb:1}});
  let readyResolve,readyReject,endResolve,endReject,done=false;const ready=new Promise((a,b)=>{readyResolve=a;readyReject=b;}),ended=new Promise((a,b)=>{endResolve=a;endReject=b;});ended.catch(()=>{});
  worker.on('message',m=>{if(m.type==='ready')readyResolve(m);if(m.type==='complete'){done=true;readyReject(Error(m.error??'BASIC_INSTALL_PROBE_SAMPLER_STOPPED'));endResolve(m);}});
  worker.on('error',e=>{Atomics.compareExchange(flags,1,0,4);readyReject(e);endReject(e);});worker.on('exit',code=>{if(!done){const e=Error('BASIC_INSTALL_PROBE_SAMPLER_EXIT_'+code);Atomics.compareExchange(flags,1,0,4);readyReject(e);endReject(e);}});
  await ready;return {initial,async stop(){Atomics.store(flags,0,1);return ended;}};
}
export function inspectBasicInstallProbeCapacity({sourceBytes,scratchBytes=P.scratchBudget,freeBytes}){
  check([sourceBytes,scratchBytes,freeBytes].every(x=>Number.isSafeInteger(x)&&x>=0),'BASIC_INSTALL_PROBE_CAPACITY_VALUE');
  check(scratchBytes<=P.scratchBudget&&sourceBytes+scratchBytes+P.reserve<=P.sourceCap,'BASIC_INSTALL_PROBE_SOURCE_CAPACITY');
  check(freeBytes>=P.requiredFreeBytes,'BASIC_INSTALL_PROBE_DISK_CAPACITY');
  return {sourceBytes,scratchBytes,reserve:P.reserve,projectedBytes:sourceBytes+scratchBytes+P.reserve,headroomBytes:P.sourceCap-sourceBytes-scratchBytes-P.reserve,freeBytes};
}
export function runHostedBasicInstallationProbe({app,config}){
  check(configs.has(config)&&typeof app.withStartupPreparationResources==='function','BASIC_INSTALL_PROBE_GENUINE_CONFIG');
  // Acquires the production lease before any asynchronous startup can resume.
  return app.withStartupPreparationResources(async()=>{
    const previous=await priorOutcome(config);if(previous)return previous;
    const root=config.probeRoot,startedAt=new Date().toISOString(),deadline=Date.now()+P.deadlineMs,flags=new Int32Array(new SharedArrayBuffer(12)),phases=[];
    let observer,memory,before,after,attemptHash,outputs,inputPins,counts,inputBytes,selectedCount=0,selectedBytes=0,capacity,installation,provider,progressPins;
    const guard=()=>{check(Date.now()<deadline&&!Atomics.load(flags,1),'BASIC_INSTALL_PROBE_RESOURCE_STOP');};
    const mark=async name=>{guard();phases.push({name,at:new Date().toISOString(),rssBytes:process.memoryUsage().rss});Atomics.store(flags,2,phases.length);console.log(JSON.stringify({basicProbe:config.runId,phase:name,pid:process.pid}));};
    try{
      validateBasicInstallProbePermit(config.permit,{release:config.release,serviceId:config.serviceId});
      check(sha(await fs.readFile(config.permitFile))===config.permitHash,'BASIC_INSTALL_PROBE_PERMIT_CHANGED');
      assert.deepEqual((await fs.readdir(root)).sort(),['permit.json']);
      attemptHash=await save(root+'/attempt.json',{permitHash:config.permitHash,release:config.release,runId:config.runId,pid:process.pid,startedAt});
      observer=await sampler(root,deadline,flags);await mark('preservation_before');before=await capture(config);await save(root+'/preservation-before.json',before);
      const schedule=before.controls.databases.find(x=>x.file.endsWith('/schedule.sqlite')).schedule;
      check(schedule.next_at>deadline,'BASIC_INSTALL_PROBE_SCHEDULE_TOO_SOON');
      const space=await fs.statfs(root);capacity=inspectBasicInstallProbeCapacity({sourceBytes:before.sourceLogicalBytes,freeBytes:Number(space.bavail)*Number(space.bsize)});
      await mark('copy_fixture');const fixture=(await read(fixtureUrl)).value;
      check(fixture.files.length===40&&fixture.record.id===fixture.session.projectId&&fixture.record.ownerId===fixture.session.ownerId,'BASIC_INSTALL_PROBE_FIXTURE_SCOPE');
      const scratch=root+'/scratch';await fs.mkdir(scratch,{mode:0o700});const store=await new TaskStore(scratch+'/workspaces').ready();await store.create(fixture.record);
      const dir=await store.directory(fixture.session.projectId);let copiedBytes=0;
      for(const p of fixture.files){guard();check(/^(photo|generated)-[a-f0-9-]{36}\.bin$/.test(p.file),'BASIC_INSTALL_PROBE_FIXTURE_PATH');
        const donor=config.permit.donors.find(d=>d.sha256===p.sha256&&d.bytes===p.bytes);check(donor,'BASIC_INSTALL_PROBE_DONOR_MISSING');assert.deepEqual(await digest(donor.file),{bytes:p.bytes,sha256:p.sha256});
        await fs.copyFile(donor.file,path.join(dir,p.file),constants.COPYFILE_EXCL);assert.deepEqual(await digest(path.join(dir,p.file)),{bytes:p.bytes,sha256:p.sha256});copiedBytes+=p.bytes;
      }
      check(copiedBytes===74938786,'BASIC_INSTALL_PROBE_INPUT_BYTES');inputPins=await inventory(dir);
      const sharp=createRequire(import.meta.url)('sharp');sharp.cache(false);sharp.concurrency(1);const decodeImage=createShopifyImageDecoder({sharp});
      const serviceConfig={store,storage:scratch+'/receipts',buildRoot:scratch+'/builds',buildEnabled:true,referenceComposition:true,decodeImage};
      await withHostedBasicInstallReferenceScope({permitHash:config.permitHash,...serviceConfig},async()=>{
        await mark('compose');const service=await createBasicPreparationService(serviceConfig),record=await store.read(fixture.session.projectId,fixture.session.ownerId);
        const confirmation=await service.request(fixture.session,{expectedSourceHash:sha(canonicalJson(record)),acknowledged:true}),command={requestId:confirmation.request.requestId};
        await service.prepare(fixture.session,command);await mark('reopen');const reopened=await createBasicPreparationService(serviceConfig),loaded=await reopened.loadPrepared(fixture.session,command);
        counts=loaded.referenceComposition.plan.counts;inputBytes=loaded.referenceComposition.inputBytes;await mark('installer');
        const fake=await createReferenceDiskWorld({sharp,theme:loaded.theme,assets:inputPins.filter(p=>p.file.endsWith('.bin')).map(p=>({...p,file:path.join(dir,p.file)}))});
        const registryDirectory=scratch+'/registry';await fs.mkdir(registryDirectory,{mode:0o700});
        installation=await installPreparedBasicReference({preparation:reopened,session:fixture.session,confirmation:loaded.confirmation,withResources:fn=>fn(),directory:scratch+'/journal',registryDirectory,
          authorizationSha256:config.permitHash,preflightEvidence:{operatorId:'resident-installation-probe',observedAt:new Date().toISOString(),evidenceSha256:config.permitHash,scopeConfirmed:true},operatorId:'resident-installation-probe',accessToken:'shpat_SYNTHETIC_PROBE_ONLY_NOT_A_REAL_CREDENTIAL',fetchImpl:fake.world.fetch,uploadFetch:fake.world.uploadFetch,decodeImage,
          onStep:async e=>{guard();if(e.phase==='after')console.log(JSON.stringify({basicInstallProbe:config.runId,step:e.key,kind:e.kind}));}});
        provider=fake.summary();check(installation.steps.length===59&&installation.eventCount===118&&provider.products===10&&provider.variants===14&&provider.retainedImageBuffers===0,'BASIC_INSTALL_PROBE_INSTALLATION');
        selectedCount=fake.uploads.length;selectedBytes=fake.uploads.reduce((n,x)=>n+x.bytes,0);
        progressPins=await inventory(path.join(BASIC_THEME_PROGRESS_ROOT,installation.intentHash));await save(root+'/theme-progress-inventory.json',progressPins);
        check(selectedCount===30&&selectedBytes===59525705&&counts.products===10&&counts.variants===14,'BASIC_INSTALL_PROBE_COUNTS');
        outputs=await inventory(path.join(serviceConfig.buildRoot,`${fixture.session.projectId}-${command.requestId}`));
        check(outputs.every(p=>!p.file.startsWith('package/images/')),'BASIC_INSTALL_PROBE_IMAGE_DUPLICATION');
      });
      const currentInputs=await inventory(dir);for(const pin of inputPins)assert.deepEqual(currentInputs.find(x=>x.file===pin.file),pin);await mark('preservation_after');after=await capture(config);await save(root+'/preservation-after.json',after);assert.deepEqual(after,before);
      const scratchPins=await inventory(scratch),scratchBytes=scratchPins.reduce((n,p)=>n+p.bytes,0)+progressPins.reduce((n,p)=>n+p.bytes,0);inspectBasicInstallProbeCapacity({sourceBytes:after.sourceLogicalBytes,scratchBytes,freeBytes:Number((await fs.statfs(root)).bavail)*Number(space.bsize)});
      await save(root+'/scratch-inventory.json',scratchPins);await mark('complete');memory=await observer.stop();observer=null;
      check(!memory.error&&!memory.stopReason,'BASIC_INSTALL_PROBE_MEMORY_STOP');
      const report={status:'PASS',permitHash:config.permitHash,release:config.release,runId:config.runId,startedAt,finishedAt:new Date().toISOString(),pid:process.pid,execArgv:process.execArgv,memory,processMaxRssBytes:process.resourceUsage().maxRSS*1024,phases,capacity,scratchBytes,counts,inputBytes,selectedCount,selectedBytes,outputFiles:outputs.length,outputBytes:outputs.reduce((n,p)=>n+p.bytes,0),outputs,sourceUnchanged:true,applicationTables:before.application.tables.length,realR2Calls:0,shopifyCalls:0,aiCalls:0,emailSends:0,newCharges:0,published:false,hostedProfileEnabled:false,syntheticLifecycle:true,originalsUseFirstSelectedPhoto:true,installation,provider,progressRoot:path.join(BASIC_THEME_PROGRESS_ROOT,installation.intentHash),scope:'Resident application, composition and full real installer in one PID/lease with synthetic disk-backed Shopify. General hosted activation OFF. Normal startup OAuth is separate.'};
      const reportHash=await save(root+'/report.json',report);await save(root+'/complete.json',{permitHash:config.permitHash,attemptHash,reportHash,finishedAt:report.finishedAt});
      console.log(JSON.stringify({basicProbe:config.runId,status:'PASS',reportHash}));return {status:'PASS',allowAutomaticStart:true,runId:config.runId,reportHash};
    }catch(e){
      if(observer){try{memory=await observer.stop();}catch{}}
      if(before&&!after){try{after=await capture(config);await save(root+'/preservation-after-failure.json',after);}catch{}}
      await save(root+'/failure.json',{status:'FAIL_PRESERVED',permitHash:config.permitHash,attemptHash:attemptHash??null,runId:config.runId,at:new Date().toISOString(),code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'BASIC_INSTALL_PROBE_FAILED',message:String(e.message).slice(0,2000),phases,memory:memory??null,sourceUnchanged:before&&after?canonicalJson(before)===canonicalJson(after):null});
      console.error('MOLYVI_BASIC_INSTALL_PROBE_FAILED');return {status:'FAIL_PRESERVED',allowAutomaticStart:false,runId:config.runId};
    }
  });
}
