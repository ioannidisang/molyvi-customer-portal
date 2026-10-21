// One trusted, source-bound development-store permit. Customer confirmation is
// required separately and never grants store credentials or publication rights.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PRIVATE_ROOT,canonicalJson} from './intake-store.mjs';
import {createBasicPreparationService} from './basic-preparation.mjs';
import {createBasicPreparationWorker} from './basic-preparation-worker.mjs';
import {REFERENCE_PIPELINE_KIND,loadReferencePipelinePermit} from './basic-reference-pipeline-authority.mjs';
const SERVICE='srv-db7othjrjlhs73cg7lf0',STORE='molyvi-still-dev.myshopify.com';
export const HOSTED_BASIC_PIPELINE_FILE=path.join(PRIVATE_ROOT,'molyvi-hosted-staging','controlled-operations','basic-pipeline','permit.json');
const runtimes=new WeakSet(),sha=b=>crypto.createHash('sha256').update(b).digest('hex'),hash=v=>sha(canonicalJson(v));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=code=>{const e=new Error('BASIC_PIPELINE_'+code);e.code=e.message;throw e;};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
async function safePath(file){let current=path.parse(file).root;for(const bit of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,bit);const s=await fs.lstat(current);if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_PATH');}}
async function read(file,max=32768){await safePath(file);const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)fail('UNSAFE_FILE');const b=await fs.readFile(file);if(b.length!==s.size)fail('FILE_CHANGED');return b;}
async function write(file,value,max=32768){await safePath(file);const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');if(b.length>max)fail('RECORD_LIMIT');await fs.writeFile(file,b,{flag:'wx',mode:0o600});return sha(b);}
export function validateBasicPipelinePermit(value){
 const keys=['schemaVersion','kind','serviceId','targetStore','projectId','ownerId','sourceHash','jobId','authorizationSha256','operatorId','createdAt','expiresAt','credentialReference','publicationAuthorized','newChargesAuthorized','permitHash'];
 if(!exact(value,keys)||value.schemaVersion!==1||value.kind!=='molyvi_basic_pipeline_permit'||value.serviceId!==SERVICE||value.targetStore!==STORE||!['projectId','ownerId','jobId'].every(k=>uuid(value[k]))||!['sourceHash','authorizationSha256','permitHash'].every(k=>hex(value[k]))||value.operatorId!=='molyvi-full-basic-test-20261019'||value.publicationAuthorized!==false||value.newChargesAuthorized!==false)fail('PERMIT_INVALID');
 const r=value.credentialReference;if(!exact(r,['runId','packageSha256','receiverSha256'])||!uuid(r.runId)||!hex(r.packageSha256)||!hex(r.receiverSha256))fail('CREDENTIAL_REFERENCE_INVALID');
 const from=Date.parse(value.createdAt),to=Date.parse(value.expiresAt);if(!Number.isFinite(from)||!Number.isFinite(to)||new Date(from).toISOString()!==value.createdAt||new Date(to).toISOString()!==value.expiresAt||to<=from||to-from>6*60*60*1000)fail('PERMIT_WINDOW_INVALID');
 const {permitHash,...body}=value;if(hash(body)!==permitHash)fail('PERMIT_HASH_MISMATCH');return structuredClone(value);
}
export async function loadHostedBasicPipelinePermit(){
 const reference=await loadReferencePipelinePermit();if(reference)return reference;
 try{await fs.lstat(HOSTED_BASIC_PIPELINE_FILE);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(process.env.RENDER_SERVICE_ID!==SERVICE)fail('SERVICE_MISMATCH');
 return validateBasicPipelinePermit(JSON.parse(await read(HOSTED_BASIC_PIPELINE_FILE)));
}
export const isHostedBasicPipeline=value=>runtimes.has(value);

export async function createHostedBasicPipeline({permit,store,storage,acquireLease,clock=Date.now,dependencies={}}){
 if(permit?.kind===REFERENCE_PIPELINE_KIND){const {createHostedBasicReferencePipeline}=await import('./hosted-basic-reference-pipeline.mjs');const runtime=await createHostedBasicReferencePipeline({permit,store,storage,acquireLease});runtimes.add(runtime);return runtime;}
 permit=validateBasicPipelinePermit(permit);
 if(path.resolve(storage)!==path.join(PRIVATE_ROOT,'molyvi-hosted-staging')||typeof acquireLease!=='function')fail('RUNTIME_SCOPE');
 const session={projectId:permit.projectId,ownerId:permit.ownerId},operations=path.join(storage,'controlled-operations'),directory=path.join(operations,'basic-pipeline'),handoffFile=path.join(directory,'handoff.json'),completionFile=path.join(directory,'completion.json');
 const preparation=await (dependencies.createPreparation??createBasicPreparationService)({store,storage:path.join(operations,'basic-preparation'),targetStore:STORE,buildEnabled:true,hostedCompact:true,buildRoot:path.join(operations,'basic-composition')});
 let installer=null,stage='waiting_confirmation',failure=null,completion=null,stopping=false,stopPromise;
 const belongs=s=>s?.projectId===session.projectId&&s.ownerId===session.ownerId;
 const current=async()=>{const b=await read(HOSTED_BASIC_PIPELINE_FILE);if(hash(JSON.parse(b))!==hash(permit))fail('PERMIT_CHANGED');const record=await store.read(session.projectId,session.ownerId);if(hash(record)!==permit.sourceHash)fail('SOURCE_CHANGED');return record;};
 const activeWindow=()=>{if(clock()<Date.parse(permit.createdAt)||clock()>=Date.parse(permit.expiresAt))fail('PERMIT_EXPIRED');};
 const launchWindow=()=>{activeWindow();if(Date.parse(permit.expiresAt)-clock()<65*60*1000)fail('PERMIT_WINDOW_INSUFFICIENT');};
 const running=()=>{if(stopping)fail('SHUTDOWN_INTERRUPTED');};
 async function getToken(){if(dependencies.readToken)return dependencies.readToken(permit.credentialReference);const {readExactToken}=await import('./hosted-basic-installer-access.mjs');return readExactToken(permit.credentialReference);}
 async function preflight(){
  launchWindow();await current();const token=await getToken();if(Date.parse(token.expiresAt)-clock()<65*60*1000)fail('TOKEN_WINDOW_INSUFFICIENT');
  const query='query MolyviHostedInstallerIdentity { shop { id myshopifyDomain currencyCode } currentAppInstallation { id app { id } accessScopes { handle } } themes(first:2,roles:[MAIN]) { nodes { id role } pageInfo { hasNextPage } } location(id:"gid://shopify/Location/125398417745") { id isActive fulfillsOnlineOrders } }';
  const response=await fetch(`https://${STORE}/admin/api/2026-10/graphql.json`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token.accessToken},body:JSON.stringify({query})});
  if(!response.ok||response.redirected)fail('IDENTITY_HTTP');const parts=[];let size=0;for await(const p of response.body){size+=p.length;if(size>32768)fail('IDENTITY_LIMIT');parts.push(p);}const result=JSON.parse(Buffer.concat(parts).toString()),d=result.data;
  const scopes=['read_files','read_inventory','read_locations','read_online_store_pages','read_products','read_publications','read_themes','write_files','write_online_store_pages','write_products','write_themes'];
  if(result.errors||d?.shop?.id!=='gid://shopify/Shop/108668748113'||d.shop.myshopifyDomain!==STORE||d.shop.currencyCode!=='EUR'||d.currentAppInstallation?.id!=='gid://shopify/AppInstallation/1195450433873'||d.currentAppInstallation.app?.id!=='gid://shopify/App/436878311425'||canonicalJson(d.currentAppInstallation.accessScopes.map(s=>s.handle).sort())!==canonicalJson(scopes)||d.themes?.nodes?.length!==1||d.themes.nodes[0].id!=='gid://shopify/OnlineStoreTheme/207379235153'||d.themes.nodes[0].role!=='MAIN'||d.themes.pageInfo.hasNextPage||d.location?.id!=='gid://shopify/Location/125398417745'||!d.location.isActive||!d.location.fulfillsOnlineOrders)fail('IDENTITY_MISMATCH');
  const observedAt=new Date(clock()).toISOString(),evidence={identity:d,observedAt,additionalRequests:1,newRights:false};return {evidence,preflightEvidence:{operatorId:permit.operatorId,evidenceSha256:hash(evidence),observedAt,scopeConfirmed:true}};
 }
 function checkHandoff(handoff,confirmation){
  const expected=path.join(operations,'basic-prepared-installer','jobs',permit.projectId,'config.json');
  if(!exact(handoff,['permitHash','confirmationHash','configFile','configSha256'])||handoff.permitHash!==permit.permitHash||!hex(handoff.confirmationHash)||!hex(handoff.configSha256)||handoff.configFile!==expected||confirmation&&handoff.confirmationHash!==hash(confirmation))fail('HANDOFF_MISMATCH');
  return handoff;
 }
 function checkInstaller(active,handoff,confirmation){
  const c=active?.config;
  if(c?.projectId!==permit.projectId||c.jobId!==permit.jobId||c.authorizationSha256!==permit.authorizationSha256||c.runtimeProfile!=='hosted_prepared_basic_v1'||c.identity?.targetStore!==STORE||c.publicationAuthorized!==false||c.newChargesAuthorized!==false||c.confirmation?.projectId!==permit.projectId||c.confirmation.ownerHash!==hash(permit.ownerId)||c.confirmation.sourceHash!==permit.sourceHash||hash(c.confirmation)!==handoff.confirmationHash||confirmation&&hash(c.confirmation)!==hash(confirmation))fail('INSTALLER_BINDING');
 }
 async function openInstaller(handoff,confirmation){
  checkHandoff(handoff,confirmation);
  const {loadHostedPreparedBasicInstaller}=await import('./hosted-basic-prepared-installer.mjs');
  const active=await (dependencies.loadInstaller??loadHostedPreparedBasicInstaller)({configFile:handoff.configFile,configSha256:handoff.configSha256,networkEnabled:true,clock,getAccessToken:async()=>(await getToken()).accessToken,assertSourceCurrent:async value=>{activeWindow();await current();return hash(value)===handoff.confirmationHash;}});
  checkInstaller(active,handoff,confirmation);return active;
 }
 function completionRecord(report,handoff){
  if(report.phase!=='verified'||report.projectId!==permit.projectId||report.jobId!==permit.jobId||!hex(report.intentHash)||report.counts?.total<14||report.counts.total>59||report.counts.succeeded!==report.counts.total||!Array.isArray(report.resources)||report.resources.length!==report.counts.total||report.resources.filter(x=>x.kind==='theme').length!==1)fail('COMPLETION_INVALID');
  const themeId=report.resources.find(x=>x.kind==='theme').remoteId;if(!/^[1-9][0-9]{0,24}$/.test(themeId)||themeId==='207379235153')fail('COMPLETION_INVALID');
  return {permitHash:permit.permitHash,confirmationHash:handoff.confirmationHash,configSha256:handoff.configSha256,intentHash:report.intentHash,sourceHash:permit.sourceHash,themeId,counts:report.counts,counters:report.counters,resources:report.resources,published:false};
 }
 async function onPrepared(item){
  running();stage='installation_review';await current();
  const loaded=await preparation.loadPrepared(session,{requestId:item.requestId});
  const {prepareHostedPreparedBasicInstallation}=await import('./hosted-basic-prepared-installer.mjs');
  let handoff;
  try{handoff=JSON.parse(await read(handoffFile));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(handoff)checkHandoff(handoff,loaded.confirmation);
  else{
   running();launchWindow();
   // A failed/interrupted handoff claim is never retried or adopted.
   await write(path.join(directory,'handoff-claim.json'),{permitHash:permit.permitHash,requestId:item.requestId,confirmationHash:hash(loaded.confirmation)});
   const verified=await (dependencies.preflight??preflight)();
   const bundle={schemaVersion:1,kind:'molyvi_prepared_basic_bundle',ownerId:session.ownerId,plan:loaded.prepared.plan,uploads:loaded.prepared.uploads.map(x=>({...x,bytes:x.bytes.toString('base64')})),theme:{manifest:loaded.theme.manifest,zipBytes:loaded.theme.zipBytes.toString('base64')},confirmation:loaded.confirmation};
   const bundleFile=path.join(directory,'bundle.json'),bundleSha256=await write(bundleFile,bundle,3*1024*1024);
   running();launchWindow();
   const prepared=await (dependencies.prepareInstaller??prepareHostedPreparedBasicInstallation)({bundleFile,bundleSha256,jobId:permit.jobId,authorizationSha256:permit.authorizationSha256,operatorId:permit.operatorId,preflightEvidence:verified.preflightEvidence,confirmation:loaded.confirmation,clock});
   await write(path.join(directory,'preflight.json'),verified.evidence);
   handoff={permitHash:permit.permitHash,confirmationHash:hash(loaded.confirmation),configFile:prepared.configFile,configSha256:prepared.configSha256};await write(handoffFile,handoff);
  }
  running();installer=await openInstaller(handoff,loaded.confirmation);running();stage='installing';installer.start();
  while(!['verified','stopped'].includes(installer.status().phase)&&!['failed','stopped','completed'].includes(installer.status().lifecycle)){running();await new Promise(r=>setTimeout(r,100));}
  if(installer.status().phase!=='verified')fail('INSTALLATION_STOPPED');
  const body={...completionRecord(await installer.inspect(),handoff),verifiedAt:new Date(clock()).toISOString()};completion={...body,completionHash:hash(body)};
  try{await write(completionFile,completion);}catch(e){if(e.code!=='EEXIST')throw e;const previous=JSON.parse(await read(completionFile)),{verifiedAt,completionHash,...prior}=previous;if(completionHash!==hash({...prior,verifiedAt})||hash(prior)!==hash(completionRecord(await installer.inspect(),handoff)))fail('COMPLETION_CHANGED');completion=previous;}
  stage='installed_draft';return {status:'verified'};
 }
 // A terminal journal remains valid after the permit/token expires. Restore
 // presentation by reading exact durable state; never start a runner or read a
 // credential merely to redisplay a completed installation after restart.
 let saved;try{saved=JSON.parse(await read(completionFile));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(saved){const {completionHash,verifiedAt,...body}=saved;if(!hex(completionHash)||completionHash!==hash({...body,verifiedAt})||!Number.isFinite(Date.parse(verifiedAt))||new Date(verifiedAt).toISOString()!==verifiedAt)fail('COMPLETION_INVALID');const handoff=checkHandoff(JSON.parse(await read(handoffFile)));installer=await openInstaller(handoff);if(hash(body)!==hash(completionRecord(await installer.inspect(),handoff)))fail('COMPLETION_CHANGED');completion=saved;stage='installed_draft';}
 const worker=createBasicPreparationWorker({preparationService:preparation,enabled:!completion,permit:{projectId:permit.projectId,ownerHash:hash(permit.ownerId)},acquireLease,listPending:async()=>{activeWindow();await current();const s=await preparation.status(session);if(!s.request||s.request.sourceHash!==permit.sourceHash)return [];return [{session,requestId:s.request.requestId,sourceHash:permit.sourceHash}];},onPrepared:async item=>{try{return await onPrepared(item);}catch(e){stage='blocked';failure=e.code??'BASIC_PIPELINE_STOPPED';throw e;}}});
 const visibleStage=()=>failure||worker.status().lifecycle==='stopped_for_review'?'blocked':stage==='waiting_confirmation'&&worker.status().phase==='preparing'?'preparing':stage;
 const publicStatus=s=>belongs(s)?{stage:visibleStage(),controlled:true,published:false,counts:completion?.counts??null}:null;
 const runtime={service:preparation,signal:()=>{void worker.runOnce();},publicStatus,start:()=>worker.start(),pause:()=>worker.pause(),drain:()=>worker.drain(),resume:()=>worker.resume(),stop:()=>stopPromise??=(async()=>{stopping=true;worker.pause();await installer?.stop();await worker.stop();await installer?.stop();})(),status:()=>({stage:visibleStage(),worker:worker.status(),installer:installer?.status()??null,code:failure??worker.status().lastCode}),permit};
 runtimes.add(runtime);return Object.freeze(runtime);
}
