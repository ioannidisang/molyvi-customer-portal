// Exact operator-only synthetic proof. No public endpoint, email, purchase,
// credential loading, scheduler start, deletion, retry or publication.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {PRIVATE_ROOT,WORKSPACE_ROOT,canonicalJson} from '../lib/intake-store.mjs';
import {TaskStore} from '../lib/task-store.mjs';
import {CustomerStore} from '../lib/customer-store.mjs';
import {inspectBasicSubmissionReadiness} from '../lib/basic-submission-readiness.mjs';
import {inspectHostedBasicCompositionCapacity,estimateHostedBasicCompositionOutput} from '../lib/basic-preparation-capacity.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {createBasicPreparationService} from '../lib/basic-preparation.mjs';
import {validateBasicPipelinePermit} from '../lib/hosted-basic-pipeline.mjs';
import {createRequestBoundary} from '../lib/hosted-request-boundary.mjs';
import {createBasicAssemblyFixture} from '../tests/helpers/basic-assembly-fixture.mjs';

const SERVICE='srv-db7othjrjlhs73cg7lf0',TARGET='molyvi-still-dev.myshopify.com';
const APPROVAL='Ωραία, προχώρα με τη σύνδεση της επιβεβαίωσης του πελάτη με τη σύνθεση και την ελεγχόμενη εγκατάσταση του πλήρους πακέτου Basic μέσα από την εφαρμογή, χωρίς νέες χρεώσεις ή δημοσίευση.';
const OPERATOR='molyvi-full-basic-test-20261019';
const SOURCE=path.join(PRIVATE_ROOT,'molyvi-hosted-staging'),OPS=path.join(SOURCE,'controlled-operations');
const PROOF=path.join(OPS,'basic-full-test-20261019'),PIPELINE=path.join(OPS,'basic-pipeline');
const OLD=path.join(OPS,'basic-installer'),ACTIVATION=path.join(OLD,'activation.json');
const OLD_PROJECT='4923cd43-11b7-47ed-a912-1b06458a6557';
const OLD_SOURCE_SHA='2e94d97c5bea2582ed0aa04821eb86868437e8ea3806b3a0d4ee1214033e710d';
const OLD_ACTIVATION_SHA='8dbc5c5b446812264903f231f9b9898af8cbeb0b5118499293bcc3ef3493645b';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonicalJson(v));
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,HEX=/^[a-f0-9]{64}$/;
const fail=code=>{const e=new Error('FULL_BASIC_PROOF_'+code);e.code=e.message;throw e;};
const need=(ok,code)=>{if(!ok)fail(code);};
const iso=()=>new Date().toISOString();
export function serviceGuard(){need(process.platform==='linux'&&process.env.RENDER_SERVICE_ID===SERVICE&&WORKSPACE_ROOT==='/opt/render/project/src'&&PRIVATE_ROOT==='/opt/render/project/src/briefs','SERVICE_SCOPE');}
async function safeDirectory(dir){let current=path.parse(dir).root;for(const bit of dir.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,bit);const s=await fs.lstat(current);need(s.isDirectory()&&!s.isSymbolicLink(),'UNSAFE_DIRECTORY');}}
async function regular(file){await safeDirectory(path.dirname(file));const s=await fs.lstat(file);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&Number.isSafeInteger(s.size),'UNSAFE_FILE');return s;}
async function read(file,max=2*1024*1024){const s=await regular(file);need(s.size<=max,'FILE_LIMIT');const b=await fs.readFile(file),a=await regular(file);need(b.length===s.size&&a.size===s.size&&a.ino===s.ino&&a.mtimeMs===s.mtimeMs,'FILE_CHANGED');return b;}
const json=async(file,max)=>JSON.parse(await read(file,max));
async function write(file,value,max=2*1024*1024){await safeDirectory(path.dirname(file));const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');need(b.length<=max,'WRITE_LIMIT');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(b);await h.sync();}finally{await h.close();}const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}return sha(b);}
async function absent(file){try{await fs.lstat(file);fail('ALREADY_RESERVED');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function filePin(file){const before=await regular(file),h=crypto.createHash('sha256');for await(const b of createReadStream(file))h.update(b);const after=await regular(file);need(before.size===after.size&&before.ino===after.ino&&before.mtimeMs===after.mtimeMs,'SNAPSHOT_CHANGED');return {bytes:before.size,sha256:h.digest('hex')};}
async function inventory(root){await safeDirectory(root);const files=[];async function visit(dir,prefix=''){for(const entry of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const rel=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(dir,entry.name),s=await fs.lstat(file);need(!s.isSymbolicLink(),'UNSAFE_FILE');if(s.isDirectory())await visit(file,rel);else{need(files.length<10000,'SNAPSHOT_LIMIT');files.push({file:rel,...await filePin(file)});}}}await visit(root);files.sort((a,b)=>a.file.localeCompare(b.file));return {files,bytes:files.reduce((n,f)=>n+f.bytes,0),manifestHash:hash(files)};}
async function oldBaseline(){const project=await filePin(path.join(SOURCE,'workspaces',OLD_PROJECT,'workspace.json')),activation=await filePin(ACTIVATION);need(project.sha256===OLD_SOURCE_SHA&&activation.sha256===OLD_ACTIVATION_SHA,'HISTORICAL_BASELINE_CHANGED');return {project,activation,installer:await inventory(OLD)};}
async function preservation(baseline){const now=await oldBaseline();need(hash(now)===hash(baseline),'HISTORICAL_DATA_CHANGED');return {old1005Unchanged:true,oldActivationUnchanged:true,oldInstallerUnchanged:true,installerFiles:now.installer.files.length,installerManifestHash:now.installer.manifestHash};}
async function credentialReference(){
 const raw=await read(ACTIVATION,4096);need(sha(raw)===OLD_ACTIVATION_SHA,'ACTIVATION_CHANGED');const a=JSON.parse(raw);
 need(a.schemaVersion===1&&a.mode==='real_basic_draft_test'&&UUID.test(a.jobId)&&UUID.test(a.projectId)&&HEX.test(a.packageSha256)&&HEX.test(a.receiverSha256),'REFERENCE_INVALID');
 const accepted=await json(path.join(PRIVATE_ROOT,'molyvi-basic-installer-access',a.jobId,'accepted.json'),8192),b=accepted.binding;
 need(accepted.schemaVersion===1&&accepted.status==='TOKEN_ACCEPTED_PRIVATELY'&&b?.serviceId===SERVICE&&b.targetStore===TARGET&&b.shopId==='108668748113'&&b.appId==='436878311425'&&b.installId==='1195450433873'&&b.liveThemeId==='207379235153'&&b.runId===a.jobId&&b.packageSha256===a.packageSha256&&accepted.receiverSha256===a.receiverSha256,'REFERENCE_INVALID');
 const expiry=Date.parse(accepted.tokenExpiresAt);need(Number.isFinite(expiry)&&new Date(expiry).toISOString()===accepted.tokenExpiresAt&&expiry-Date.now()>=65*60*1000,'TOKEN_WINDOW_INSUFFICIENT');
 // accepted.json has only metadata; credential.json/private-key files are never read.
 return {reference:{runId:a.jobId,packageSha256:a.packageSha256,receiverSha256:a.receiverSha256},tokenExpiresAt:accepted.tokenExpiresAt};
}
function originConfig(){const origin=process.env.MOLYVI_PORTAL_ORIGIN??process.env.RENDER_EXTERNAL_URL;createRequestBoundary({publicOrigin:origin});const u=new URL(origin),port=Number(process.env.PORT);need(Number.isSafeInteger(port)&&port>=1&&port<=65535,'PORT_INVALID');return {origin:u.origin,host:u.host,port};}
async function localRequest(config,method,route,body,{cookie,csrf}={}){
 need(['/api/customer/login','/api/customer/me','/api/basic-preparation','/api/basic-preparation-request'].includes(route),'ROUTE_INVALID');
 const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));need(!bytes||bytes.length<=1024,'REQUEST_LIMIT');
 return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:config.port,path:route,method,timeout:30000,headers:{Host:config.host,Origin:config.origin,Accept:'application/json',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'x-molyvi-csrf':csrf}:{})}},res=>{let length=0;const chunks=[];res.on('data',chunk=>{length+=chunk.length;if(length>2*1024*1024)req.destroy(new Error('RESPONSE_LIMIT'));else chunks.push(chunk);});res.on('error',()=>reject(Object.assign(new Error('HTTP_STOPPED'),{code:'FULL_BASIC_PROOF_HTTP_STOPPED'})));res.on('end',()=>{try{need(res.statusCode===200,'HTTP_STATUS_'+res.statusCode);resolve({body:JSON.parse(Buffer.concat(chunks)),cookies:res.headers['set-cookie']??[]});}catch(e){reject(e);}});});req.on('timeout',()=>req.destroy(new Error('HTTP_TIMEOUT')));req.on('error',()=>reject(Object.assign(new Error('HTTP_STOPPED'),{code:'FULL_BASIC_PROOF_HTTP_STOPPED'})));req.end(bytes??undefined);});
}
async function seed(){
 await absent(PROOF);await absent(PIPELINE);await safeDirectory(OPS);
 const store=new TaskStore(path.join(SOURCE,'workspaces'));await safeDirectory(store.storage);
 const id=crypto.randomUUID(),ownerId=crypto.randomUUID(),session={projectId:id,ownerId};
 const capacityBefore=await inspectHostedBasicCompositionCapacity({store,session,record:{id,ownerId},buildRoot:path.join(OPS,'basic-composition'),after:true});
 const access=await credentialReference(),baseline=await oldBaseline();
 const sharp=createRequire(import.meta.url)('sharp');sharp.cache(false);sharp.concurrency(1);
 const images=[];for(let i=0;i<31;i++){const bytes=await sharp({create:{width:96,height:64,channels:3,background:{r:35+(i*41)%190,g:40+(i*59)%180,b:45+(i*73)%170}}}).png().toBuffer();const decoded=await sharp(bytes).raw().toBuffer({resolveWithObject:true});need(decoded.info.width===96&&decoded.info.height===64&&decoded.data.length===96*64*3,'IMAGE_INVALID');images.push(bytes);}
 const image=(i,name)=>({bytes:images[i],name,mime:'image/png'});
 const fixture=createBasicAssemblyFixture({productCount:10,sizeProductCount:2,brandName:'MOLYVI SYNTHETIC FULL BASIC TEST',sourceImage:({productIndex})=>image(productIndex*3,`source-${productIndex+1}.png`),generatedImage:({productIndex,slotIndex})=>image(productIndex*3+slotIndex,`product-${productIndex+1}-${slotIndex+1}.png`),logoImage:()=>image(30,'synthetic-logo.png'),priceMinor:({productIndex,variantIndex})=>1990+productIndex*300+variantIndex*100,stock:({variantIndex})=>[5,0,12][variantIndex],weightGrams:200});
 // Public payment projection needs amount metadata. This remains a synthetic
 // fixture (not a Shopify order/webhook or a real financial entitlement).
 fixture.record.servicePurchase.expected={netMinor:19000,taxMinor:4560,grossMinor:23560};fixture.record.servicePurchase.checkoutEnabled=false;
 const record=fixture.record,readiness=inspectBasicSubmissionReadiness(record),variants=fixture.products.reduce((n,p)=>n+p.variants.length,0);
 need(readiness.ready&&readiness.summary.products===10&&readiness.summary.photos===30&&variants===14,'FIXTURE_NOT_READY');
 const binding={projectId:record.id,ownerId:record.ownerId},sourceHash=hash(record),jobId=crypto.randomUUID(),address=`full-basic-${record.id}@example.invalid`;
 const plannedBytes=Buffer.byteLength(JSON.stringify(record))+fixture.options.assets.concat(fixture.options.sourceAssets,[fixture.options.logo]).reduce((n,x)=>n+x.bytes.length,0)+512*1024;
 const prepared=prepareBasicStorePackage(record,{...fixture.options,binding:createBasicAssemblyBinding(record,{targetStore:TARGET})}),themeInventory=await inventory(path.join(WORKSPACE_ROOT,'forma-production-kit','theme'));
 const hero=prepared.plan.products[0].photos.find(photo=>photo.role==='lifestyle')??prepared.plan.products[0].photos[0],heroBytes=prepared.uploads.find(upload=>upload.fileName===hero.fileName).bytes.length;
 const outputEstimate=estimateHostedBasicCompositionOutput({prepared,theme:{bytes:themeInventory.bytes,files:themeInventory.files.length},heroBytes,logoBytes:fixture.options.logo.bytes.length});
 const projectedSourceBytes=capacityBefore.sourceBytes+plannedBytes+outputEstimate.outputBoundBytes+capacityBefore.reservedInstallerBytes+capacityBefore.reservedPipelineBytes+capacityBefore.reservedMetadataBytes;
 const preSeedCapacity={...capacityBefore,plannedSeedBytes:plannedBytes,...outputEstimate,projectedSourceBytes,remainingBytes:capacityBefore.backupSourceLimit-projectedSourceBytes};
 need(projectedSourceBytes<=capacityBefore.backupSourceLimit,'SEED_CAPACITY');
 // mkdir is the global one-attempt reservation. Even a failed first write must
 // not be silently retried. No cleanup path exists in this operator script.
 await fs.mkdir(PROOF,{mode:0o700});
 await write(path.join(PROOF,'seed-claim.json'),{schemaVersion:1,createdAt:iso(),...binding,sourceHash,jobId,address,authorizationSha256:sha(APPROVAL),operatorId:OPERATOR,syntheticTestOnly:true});
 await write(path.join(PROOF,'baseline.json'),baseline);
 await store.create(record);const dir=await store.directory(record.id);
 for(const [prefix,items]of [['photo',fixture.options.sourceAssets],['generated',fixture.options.assets],['logo',[fixture.options.logo]]])for(const x of items){need(UUID.test(x.asset.id)&&sha(x.bytes)===x.asset.sha256&&x.bytes.length===x.asset.bytes,'ASSET_MISMATCH');await write(path.join(dir,`${prefix}-${x.asset.id}.bin`),x.bytes,64*1024);}
 let accounts;let account;
 try{accounts=await new CustomerStore(path.join(SOURCE,'accounts')).ready();need(!accounts.db.prepare('SELECT id FROM accounts WHERE email=?').get(address),'ACCOUNT_EXISTS');account=accounts.provision({address,name:'Synthetic full Basic mechanism test'});accounts.grant({accountId:account.id,...binding,label:'SYNTHETIC — Basic 10 / 30 — not a customer order',orderId:record.order.id});}finally{accounts?.close();}
 need(hash(await store.read(record.id,record.ownerId))===sourceHash,'SEEDED_SOURCE_CHANGED');
 const capacity=await inspectHostedBasicCompositionCapacity({store,session:binding,record,buildRoot:path.join(OPS,'basic-composition')});
 const unchanged=await preservation(baseline);await credentialReference();
 const createdAt=iso(),body={schemaVersion:1,kind:'molyvi_basic_pipeline_permit',serviceId:SERVICE,targetStore:TARGET,...binding,sourceHash,jobId,authorizationSha256:sha(APPROVAL),operatorId:OPERATOR,createdAt,expiresAt:new Date(Date.parse(createdAt)+6*60*60*1000).toISOString(),credentialReference:access.reference,publicationAuthorized:false,newChargesAuthorized:false};
 const permit=validateBasicPipelinePermit({...body,permitHash:hash(body)});
 await write(path.join(PROOF,'seed-result.json'),{schemaVersion:1,state:'seeded_not_confirmed',createdAt,...binding,sourceHash,jobId,accountId:account.id,address,permitHash:permit.permitHash,counts:{products:10,variants:14,photos:30,logo:1,pages:7},image:{width:96,height:64,mime:'image/png',synthetic:true},capacityBefore,preSeedCapacity,capacity,tokenExpiresAt:access.tokenExpiresAt,preservation:unchanged,syntheticPayment:true,realOrdersCreated:0,aiCalls:0,emailsSent:0,confirmationSubmitted:false});
 await fs.mkdir(PIPELINE,{mode:0o700});await write(path.join(PIPELINE,'permit.json'),permit,32768);
 return {state:'seeded_not_confirmed',projectId:record.id,jobId,sourceHash,permitHash:permit.permitHash,counts:{products:10,variants:14,photos:30,logo:1,pages:7},preSeedCapacity,capacity,preservation:unchanged,syntheticOnly:true,requiresApplicationPermitReload:true};
}
async function confirm(){
 const seed=await json(path.join(PROOF,'seed-result.json')),baseline=await json(path.join(PROOF,'baseline.json')),permit=validateBasicPipelinePermit(await json(path.join(PIPELINE,'permit.json'),32768));
 need(permit.projectId===seed.projectId&&permit.ownerId===seed.ownerId&&permit.sourceHash===seed.sourceHash&&permit.permitHash===seed.permitHash&&Date.parse(permit.expiresAt)-Date.now()>=65*60*1000,'PERMIT_BINDING');
 await preservation(baseline);await credentialReference();const config=originConfig();
 const store=new TaskStore(path.join(SOURCE,'workspaces')),session={projectId:seed.projectId,ownerId:seed.ownerId};
 const record=await store.read(session.projectId,session.ownerId);need(hash(record)===seed.sourceHash,'SOURCE_CHANGED');
 const capacity=await inspectHostedBasicCompositionCapacity({store,session,record,buildRoot:path.join(OPS,'basic-composition')});
 await absent(path.join(PROOF,'confirm-claim.json'));
 // Reserve BEFORE creating a login credential or making a request. A timeout or
 // lost response is preserved for inspection and is never automatically repeated.
 await write(path.join(PROOF,'confirm-claim.json'),{schemaVersion:1,createdAt:iso(),projectId:seed.projectId,sourceHash:seed.sourceHash,permitHash:permit.permitHash});
 let accounts,code;
 try{accounts=await new CustomerStore(path.join(SOURCE,'accounts')).ready();const account=accounts.db.prepare('SELECT id,email FROM accounts WHERE id=?').get(seed.accountId);need(account?.email===seed.address&&seed.address.endsWith('@example.invalid'),'ACCOUNT_BINDING');const grant=accounts.project(seed.accountId,seed.projectId);need(grant.owner_id===seed.ownerId,'ACCOUNT_BINDING');code=accounts.issueCode(seed.accountId,{ttlMs:60000});}finally{accounts?.close();}
 const login=await localRequest(config,'POST','/api/customer/login',{address:seed.address,code});code=null;
 need(login.body.signedIn===true&&login.cookies.length===1,'LOGIN_RESPONSE');const cookie=login.cookies[0].split(';')[0];need(/^__Host-molyvi_customer=[a-f0-9]{64}$/.test(cookie),'COOKIE_INVALID');
 const me=(await localRequest(config,'GET','/api/customer/me',undefined,{cookie})).body;
 need(me.selectedProjectId===seed.projectId&&me.account?.email===seed.address&&HEX.test(me.csrfToken),'SESSION_BINDING');
 const before=(await localRequest(config,'GET','/api/basic-preparation',undefined,{cookie})).body;
 need(before.projectId===seed.projectId&&before.sourceHash===seed.sourceHash&&before.readiness?.ready===true&&before.request===null&&before.installation?.controlled===true&&before.installation.stage==='waiting_confirmation','CONFIRMATION_NOT_READY');
 await write(path.join(PROOF,'confirmation-before.json'),{projectId:before.projectId,sourceHash:before.sourceHash,state:before.readiness.state,summary:before.readiness.summary,installation:before.installation,capacity});
 const result=(await localRequest(config,'POST','/api/basic-preparation-request',{expectedSourceHash:seed.sourceHash,acknowledged:true},{cookie,csrf:me.csrfToken})).body;
 need(result.projectId===seed.projectId&&result.sourceHash===seed.sourceHash&&UUID.test(result.request?.requestId)&&result.request.sourceHash===seed.sourceHash&&result.duplicate===false,'CONFIRMATION_RESPONSE');
 const proof={schemaVersion:1,confirmedAt:iso(),projectId:seed.projectId,sourceHash:seed.sourceHash,requestId:result.request.requestId,requestState:result.request.state,duplicate:false,automaticPipelineSignalled:true,emailsSent:0,realOrdersCreated:0,credentialsReturned:false,published:false};await write(path.join(PROOF,'confirmation-result.json'),proof);return proof;
}
async function optional(file,max){try{return await json(file,max);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function journalProjection(directory){
 const headFile=path.join(directory,'head.json'),head=await optional(headFile,32768);if(!head)return null;
 need(Number.isSafeInteger(head.sequence)&&head.sequence>=0&&head.sequence<=1600&&HEX.test(head.eventHash),'JOURNAL_HEAD');const names=(await fs.readdir(directory)).filter(n=>/^\d{6}\.json$/.test(n)).sort();need(names.length===head.sequence,'SNAPSHOT_CHANGED');
 const operations=path.basename(directory)==='operations',anchor=operations?await json(path.join(path.dirname(directory),'config.json'),32768):await json(path.join(directory,'intent.json'));
 if(!operations){const {intentHash,...body}=anchor;need(intentHash===hash(body),'JOURNAL_ANCHOR');}
 need(anchor.intentHash===head.intentHash,'JOURNAL_ANCHOR');let previous=operations?hash(anchor):anchor.intentHash;
 const counters={graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0},resources=[],receipts=[];let phase='prepared';
 for(let i=0;i<names.length;i++){need(names[i]===`${String(i+1).padStart(6,'0')}.json`,'JOURNAL_SEQUENCE');const event=await json(path.join(directory,names[i]),32768),{eventHash,...body}=event;need(eventHash===hash(body)&&body.sequence===i+1&&body.intentHash===head.intentHash&&body.previousHash===previous,'JOURNAL_CHAIN');previous=eventHash;
  if(body.type==='reserve'){if(['graphql','mutation'].includes(body.kind))counters.graphQLRequests++;if(body.kind==='mutation')counters.mutations++;if(body.kind==='upload'){counters.stagedUploads++;counters.externalRequests++;}if(body.kind==='external')counters.externalRequests++;}
  if(['install','wait','recheck','verify','stop'].includes(body.type))phase=body.type;
  if(['receipt','reconcile'].includes(body.type)){need(typeof body.key==='string'&&typeof body.receipt?.remoteId==='string','JOURNAL_RECEIPT');resources.push({key:body.key,remoteId:body.receipt.remoteId});receipts.push(body.key);}
 }
 need(previous===head.eventHash&&hash(await json(headFile,32768))===hash(head),'SNAPSHOT_CHANGED');return {eventCount:head.sequence,head:head.eventHash,intentHash:head.intentHash,phase,counters,receipts:receipts.length,resources,verification:'passive_local_hash_chain_only'};
}
async function inspect(){
 const seed=await json(path.join(PROOF,'seed-result.json')),baseline=await json(path.join(PROOF,'baseline.json')),permit=validateBasicPipelinePermit(await json(path.join(PIPELINE,'permit.json'),32768));
 need(permit.permitHash===seed.permitHash&&permit.projectId===seed.projectId,'PERMIT_BINDING');
 const preserved=await preservation(baseline),store=new TaskStore(path.join(SOURCE,'workspaces')),session={projectId:seed.projectId,ownerId:seed.ownerId};
 const record=await store.read(seed.projectId,seed.ownerId),preparation=await createBasicPreparationService({store,storage:path.join(OPS,'basic-preparation'),targetStore:TARGET}),status=await preparation.status(session);
 const completion=await optional(path.join(PIPELINE,'completion.json'),32768),handoff=await optional(path.join(PIPELINE,'handoff.json'),32768),job=path.join(OPS,'basic-prepared-installer','jobs',seed.projectId);
 if(completion){const {completionHash,...body}=completion;need(completionHash===hash(body)&&completion.permitHash===permit.permitHash&&completion.sourceHash===seed.sourceHash&&completion.published===false,'COMPLETION_INVALID');}
 return {schemaVersion:1,inspectedAt:iso(),projectId:seed.projectId,jobId:seed.jobId,sourceUnchanged:hash(record)===seed.sourceHash,permitHash:permit.permitHash,preparation:status,confirmation:await optional(path.join(PROOF,'confirmation-result.json'),32768),handoffPresent:!!handoff,completion,operations:await journalProjection(path.join(job,'operations')),journal:await journalProjection(path.join(job,'journal')),preservation:preserved,readOnly:true,providerCalls:0,credentialReads:0,published:false};
}
export async function main(args=process.argv.slice(2)){serviceGuard();need(args.length===1&&['seed','confirm','inspect'].includes(args[0]),'MODE_INVALID');await safeDirectory(SOURCE);return await ({seed,confirm,inspect}[args[0]])();}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.code)?error.code:'FULL_BASIC_PROOF_STOPPED';process.stderr.write(JSON.stringify({status:'STOPPED',code,preserved:true,retryAuthorized:false})+'\n');process.exitCode=1;});
