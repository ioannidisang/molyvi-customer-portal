import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';

import {canonicalJson} from './intake-store.mjs';
import {createBasicPreparationService} from './basic-preparation.mjs';
import {createBasicPreparationWorker} from './basic-preparation-worker.mjs';
import {createIsolatedShopifyImageDecoder} from './shopify-image-decoder-isolated.mjs';
import {installPreparedBasicReference} from './basic-prepared-reference-installer.mjs';
import {readBasicInstallation} from './basic-installation.mjs';
import {readExactToken} from './hosted-basic-installer-access.mjs';
import {readLinuxMemorySample} from '../operations/r2-backup/hosted-memory-probe-sampler.mjs';
import {REFERENCE_PIPELINE_ROOT as ROOT,REFERENCE_PIPELINE_PERMIT as PERMIT,validateReferencePipelinePermit,createReferencePipelineAuthority,readReferencePipelineRecord as read,requireReferencePipeline as need} from './basic-reference-pipeline-authority.mjs';

const hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const STORE='molyvi-still-dev.myshopify.com';
const CONTROL=path.dirname(PERMIT);
const POLICY=Object.freeze({limitBytes:512*1024*1024,baselineRssBytes:192*1024*1024,baselineAnonBytes:192*1024*1024,rssStopBytes:416*1024*1024,anonStopBytes:416*1024*1024,currentWarningBytes:496*1024*1024});
async function save(file,value){const raw=Buffer.from(JSON.stringify(value,null,2)+'\n');need(raw.length<=256*1024,'RECORD_LIMIT');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}return crypto.createHash('sha256').update(raw).digest('hex');}
async function optional(file){try{return await read(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function capacity(storage){
 let bytes=0,files=0;async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),s=await fs.lstat(file);need(!s.isSymbolicLink(),'CAPACITY_PATH');if(s.isDirectory())await walk(file);else{need(s.isFile()&&s.nlink===1&&++files<=100000,'CAPACITY_PATH');if(!['customers.sqlite-wal','customers.sqlite-shm'].includes(entry.name))bytes+=s.size;need(bytes<=512000000,'SOURCE_CAP');}}}
 await walk(storage);const stat=await fs.statfs(storage),freeBytes=stat.bavail*stat.bsize;
 need(bytes+100*1024*1024+12*1024*1024<=512000000&&freeBytes>=1024*1024*1024,'CAPACITY_REQUIRED');
 return {sourceBytes:bytes,files,freeBytes,workReserveBytes:100*1024*1024,backupReserveBytes:12*1024*1024,sourceLimitBytes:512000000};
}
async function monitor(deadline){
 const initial=await readLinuxMemorySample();need(initial.limitBytes===POLICY.limitBytes&&initial.rssBytes<=POLICY.baselineRssBytes&&initial.nonreclaimableEstimateBytes<=POLICY.baselineAnonBytes&&!initial.events.oom&&!initial.events.oom_kill,'INITIAL_MEMORY');
 const flags=new Int32Array(new SharedArrayBuffer(12));
 const worker=new Worker(new URL('../operations/r2-backup/hosted-memory-probe-sampler.mjs',import.meta.url),{workerData:{shared:flags.buffer,logFile:CONTROL+'/memory-samples.jsonl',deadline,policy:POLICY,initial,cgroup:'/sys/fs/cgroup',proc:'/proc',pid:process.pid,threadLabel:'basic-1005-real-installation'},resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4,stackSizeMb:1}});
 let resolveReady,rejectReady,resolveEnd,rejectEnd,done=false;const ready=new Promise((a,b)=>{resolveReady=a;rejectReady=b;}),ended=new Promise((a,b)=>{resolveEnd=a;rejectEnd=b;});ended.catch(()=>{});
 worker.on('message',m=>{if(m.type==='ready')resolveReady();if(m.type==='complete'){done=true;rejectReady(Error('SAMPLER_EARLY_STOP'));resolveEnd(m);}});
 const broken=e=>{Atomics.compareExchange(flags,1,0,4);rejectReady(e);rejectEnd(e);};worker.on('error',broken);worker.on('exit',()=>{if(!done)broken(Error('SAMPLER_EXIT'));});
 await ready;return {guard(){need(!Atomics.load(flags,1)&&Date.now()<deadline,'RESOURCE_STOP');},async stop(){Atomics.store(flags,0,1);return ended;}};
}

// A single real #1005 run. The old compact pipeline, old proofs and credentials
// remain intact. Interruption preserves the claim and cannot replay mutations.
export async function createHostedBasicReferencePipeline({permit,store,storage,acquireLease}){
 permit=validateReferencePipelinePermit(permit,{release:process.env.RENDER_GIT_COMMIT});
 const reviewedResume=permit.resumeSha256?await read(CONTROL+'/review.json'):undefined;
 if(reviewedResume)need(hash(reviewedResume)===permit.resumeSha256,'RESUME_REVIEW_CHANGED');
 const session={projectId:permit.projectId,ownerId:permit.ownerId},receipts=ROOT+'/receipts',buildRoot=ROOT+'/builds',directory=ROOT+'/journal',registryDirectory=ROOT+'/registry';
 need(storage===path.dirname(path.dirname(ROOT))&&typeof acquireLease==='function','RUNTIME_SCOPE');
 const authority=await createReferencePipelineAuthority({permit,store,storage:receipts,buildRoot});
 const decodeImage=createIsolatedShopifyImageDecoder();
 const preparation=await createBasicPreparationService({store,storage:receipts,buildRoot,buildEnabled:true,referenceComposition:true,decodeImage,hostedReferenceAuthority:authority});
 const legacy=await createBasicPreparationService({store,storage:path.join(storage,'controlled-operations','basic-preparation')});
 const belongs=s=>s?.projectId===session.projectId&&s?.ownerId===session.ownerId;
 let stage='waiting_confirmation',failure=null,complete=await optional(CONTROL+'/complete.json'),claim=await optional(CONTROL+'/attempt.json'),stopping=false,observer=null,activeLease=false;
 const window=()=>{need(!stopping,'SHUTDOWN');validateReferencePipelinePermit(permit,{release:process.env.RENDER_GIT_COMMIT,active:true});};
 async function current(){need(hash(await read(PERMIT))===hash(permit),'PERMIT_CHANGED');const record=await store.read(session.projectId,session.ownerId);need(hash(record)===permit.sourceHash,'SOURCE_CHANGED');return record;}
 const guard=()=>{window();observer?.guard();};
 function completionCheck(value){
  const {completionHash,...body}=value??{};need(hash(body)===completionHash&&body.permitHash===permit.permitHash&&body.sourceHash===permit.sourceHash&&body.result?.status==='verified'&&body.result.publicationAuthorized===false&&body.result.newChargesAuthorized===false&&body.result.resources?.length===59&&body.result.eventCount>=118,'COMPLETION_INVALID');return body;
 }
 if(complete){
  completionCheck(complete);need(claim?.permitHash===permit.permitHash,'COMPLETION_CLAIM');
  const c=complete.result.confirmation,state=await readBasicInstallation({directory,context:{...session,targetStore:STORE,planHash:c.planHash,themeZipSha256:c.themeZipSha256}});
  need(state.intentHash===complete.result.intentHash&&state.head===complete.result.journalHead&&state.installationStatus==='installed_operator_attested'&&Object.values(state.steps).every(s=>s.status==='succeeded'),'COMPLETION_JOURNAL');stage='installed_draft';
 }else if(claim){need(claim.permitHash===permit.permitHash,'CLAIM_MISMATCH');stage='blocked';failure='BASIC_REFERENCE_PIPELINE_INTERRUPTED_REQUIRES_REVIEW';}
 async function preflight(token){
  guard();const query='query MolyviBasic1005Identity { shop { id myshopifyDomain currencyCode } currentAppInstallation { id app { id } accessScopes { handle } } themes(first:2,roles:[MAIN]) { nodes { id role } pageInfo { hasNextPage } } location(id:"gid://shopify/Location/125398417745") { id isActive fulfillsOnlineOrders } }';
  await save(CONTROL+'/identity-request.json',{permitHash:permit.permitHash,requests:1,at:new Date().toISOString()});
  const r=await fetch(`https://${STORE}/admin/api/2026-10/graphql.json`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token.accessToken},body:JSON.stringify({query})});
  need(r.ok&&!r.redirected,'IDENTITY_HTTP');let bytes=0;const parts=[];for await(const b of r.body){bytes+=b.length;need(bytes<=32768,'IDENTITY_LIMIT');parts.push(b);}const result=JSON.parse(Buffer.concat(parts)),d=result.data;
  const scopes=['read_files','read_inventory','read_locations','read_online_store_pages','read_products','read_publications','read_themes','write_files','write_online_store_pages','write_products','write_themes'];
  need(!result.errors&&d?.shop?.id==='gid://shopify/Shop/108668748113'&&d.shop.myshopifyDomain===STORE&&d.shop.currencyCode==='EUR'&&d.currentAppInstallation?.id==='gid://shopify/AppInstallation/1195450433873'&&d.currentAppInstallation.app?.id==='gid://shopify/App/436878311425'&&canonicalJson(d.currentAppInstallation.accessScopes.map(s=>s.handle).sort())===canonicalJson(scopes)&&d.themes?.nodes?.length===1&&d.themes.nodes[0].id==='gid://shopify/OnlineStoreTheme/207379235153'&&d.themes.nodes[0].role==='MAIN'&&!d.themes.pageInfo.hasNextPage&&d.location?.isActive&&d.location.fulfillsOnlineOrders,'IDENTITY_SCOPE');
  const evidence={identity:d,observedAt:new Date().toISOString(),requests:1};await save(CONTROL+'/identity.json',evidence);return {operatorId:'molyvi-basic-1005-20261021',evidenceSha256:hash(evidence),observedAt:evidence.observedAt,scopeConfirmed:true};
 }
 const service=Object.freeze({
  status:s=>belongs(s)?preparation.status(s):legacy.status(s),
  request:async(s,c)=>{need(belongs(s)&&!claim&&!complete,'REQUEST_SCOPE');window();await current();return preparation.request(s,c);},
  prepare:async(s,c)=>{need(belongs(s)&&activeLease,'PREPARATION_LEASE');guard();await current();stage='preparing';return preparation.prepare(s,c);},
  loadPrepared:async(s,c)=>{need(belongs(s)&&activeLease,'PREPARATION_LEASE');guard();await current();return preparation.loadPrepared(s,c);}
 });
 const worker=createBasicPreparationWorker({enabled:!complete&&!claim,permit:{projectId:session.projectId,ownerHash:hash(session.ownerId)},preparationService:service,
  listPending:async()=>{window();await current();const s=await preparation.status(session);return s.request?[{session,requestId:s.request.requestId,sourceHash:permit.sourceHash}]:[];},
  acquireLease:async()=>{
   const release=await acquireLease();activeLease=true;
   try{
    guard();await current();need(Date.parse(permit.expiresAt)-Date.now()>65*60000,'WINDOW_INSUFFICIENT');
    const token=await readExactToken(permit.credentialReference);need(Date.parse(token.expiresAt)-Date.now()>65*60000,'TOKEN_WINDOW');
    const space=await capacity(storage);claim={permitHash:permit.permitHash,sourceHash:permit.sourceHash,pid:process.pid,release:process.env.RENDER_GIT_COMMIT,startedAt:new Date().toISOString(),capacity:space};
    await save(CONTROL+'/attempt.json',claim);observer=await monitor(Date.now()+15*60000);
    return async()=>{try{if(observer){const memory=await observer.stop();observer=null;await save(CONTROL+'/memory.json',{...memory,processMaxRssBytes:process.resourceUsage().maxRSS*1024});}}finally{activeLease=false;release();}};
   }catch(e){activeLease=false;release();throw e;}
  },
  onPrepared:async item=>{
   try{
    guard();stage='installation_review';const loaded=await service.loadPrepared(session,{requestId:item.requestId}),token=await readExactToken(permit.credentialReference);
    const evidence=await preflight(token);if(!reviewedResume)await fs.mkdir(registryDirectory,{mode:0o700});stage='installing';
    const result=await installPreparedBasicReference({preparation:service,session,confirmation:loaded.confirmation,withResources:async fn=>{need(activeLease,'INSTALLATION_LEASE');return fn();},directory,registryDirectory,authorizationSha256:permit.authorizationSha256,preflightEvidence:evidence,operatorId:evidence.operatorId,accessToken:token.accessToken,fetchImpl:fetch,uploadFetch:fetch,decodeImage,assertActive:guard,waitForKnownTheme:true,reviewedResume,onStep:async e=>{guard();console.log(JSON.stringify({basic1005:permit.permitHash,phase:e.phase,key:e.key,kind:e.kind}));}});
    guard();await current();const body={permitHash:permit.permitHash,sourceHash:permit.sourceHash,finishedAt:new Date().toISOString(),result};complete={...body,completionHash:hash(body)};completionCheck(complete);await save(CONTROL+'/complete.json',complete);stage='installed_draft';return {status:'verified'};
   }catch(e){stage='blocked';failure=/^[A-Z0-9_]{1,100}$/.test(e.code??'')?e.code:'BASIC_REFERENCE_PIPELINE_STOPPED';await save(CONTROL+'/failure.json',{permitHash:permit.permitHash,code:failure,at:new Date().toISOString(),automaticReplay:false});throw e;}
  }});
 const visible=()=>failure||worker.status().lifecycle==='stopped_for_review'?'blocked':stage;
 return Object.freeze({service,permit,signal:()=>{void worker.runOnce();},publicStatus:s=>belongs(s)?{stage:visible(),controlled:true,published:false,counts:complete?{total:59,succeeded:59}:null}:null,start:()=>worker.start(),pause:()=>worker.pause(),drain:()=>worker.drain(),resume:()=>worker.resume(),stop:async()=>{stopping=true;await worker.stop();},status:()=>({stage:visible(),worker:worker.status(),installer:null,code:failure??worker.status().lastCode})});
}
