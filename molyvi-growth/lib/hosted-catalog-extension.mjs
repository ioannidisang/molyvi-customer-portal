import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PRIVATE_ROOT,canonicalJson,IntakeError} from './intake-store.mjs';
import {ordinaryFile} from './service-handoff.mjs';
import {CONTROLLED_PRO_PROJECT,CONTROLLED_PRO_ORDER} from './hosted-controlled-pro.mjs';
import {serviceProductionEligible} from './service-production-queue.mjs';
import {productPhotoPlan} from './product-photo-plan.mjs';
import {photosReady,normalizeProducts} from './product-materials.mjs';
import {validateSessionExecution} from './session-execution.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),digest=x=>sha(canonicalJson(x));
const fail=code=>{throw new IntakeError(code,503);};
const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(x),hash=x=>typeof x==='string'&&/^[a-f\d]{64}$/.test(x);
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),exact=(x,keys)=>x&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
export function validateHostedCatalogConfig(c){
  if(!exact(c,['scope','runId','createdAt','expiresAt','projectId','orderId','beforeHash','afterHash','manifestHash'])||c.scope!=='molyvi_hosted_catalog_extension_v1'||!uuid(c.runId)||c.projectId!==CONTROLLED_PRO_PROJECT||c.orderId!==CONTROLLED_PRO_ORDER||['beforeHash','afterHash','manifestHash'].some(k=>!hash(c[k])))fail('CATALOG_SCOPE_INVALID');
  const start=Date.parse(c.createdAt),end=Date.parse(c.expiresAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>1200000||start>Date.now()+60000||end<=Date.now())fail('CATALOG_WINDOW_INVALID');return structuredClone(c);
}
async function directory(folder){
 const stat=await fs.lstat(folder),real=await fs.realpath(folder),base=await fs.realpath(PRIVATE_ROOT),rel=path.relative(base,real);
 if(stat.isSymbolicLink()||!stat.isDirectory()||!rel||rel.startsWith('..')||path.isAbsolute(rel)||process.platform!=='win32'&&(stat.mode&0o077))fail('CATALOG_PRIVATE_DIRECTORY_REQUIRED');return real;
}
async function json(folder,file){const s=await fs.lstat(path.join(folder,file));if(s.isSymbolicLink()||!s.isFile()||s.size>4*1024*1024||process.platform!=='win32'&&(s.mode&0o077))fail('CATALOG_PRIVATE_FILE_REQUIRED');return JSON.parse(await ordinaryFile(folder,file));}
export async function loadHostedCatalogConfig({enabled=false,folder=path.join(PRIVATE_ROOT,'molyvi-hosted-catalog')}={}){return enabled?validateHostedCatalogConfig(await json(await directory(folder),'config.json')):null;}

// A trusted, finite continuation of TEST #1005. The local Pro session produces
// private results; this startup-only importer has no model or public endpoint.
// Every existing field must remain identical, except appending nine product
// drafts and their strictly scoped source, review, plan and image records.
export function validateCatalogExtension(before,after,productIds){
 if(before.id!==CONTROLLED_PRO_PROJECT||after.id!==before.id||before.order.id!==CONTROLLED_PRO_ORDER||!serviceProductionEligible(before)||before.servicePurchase.intentScope!=='molyvi_hosted_test_v1'||!Array.isArray(productIds)||productIds.length!==9||new Set(productIds).size!==9||productIds.some(id=>!uuid(id)||before.productTasks[id])||Object.keys(before.productTasks).length!==1||Object.keys(after.productTasks).length!==10)fail('CATALOG_EXTENSION_SCOPE');
 const allowed=new Set(productIds),projection=structuredClone(after),added={};
 const maps=['jobs','assets','photoReviews','productTasks','productGalleries','generatedAssets','productPilotPackets','productPilotImports'];
 for(const key of maps){
  added[key]=Object.entries(after[key]??{}).filter(([id])=>!Object.hasOwn(before[key]??{},id)).map(([,value])=>value);
  if(['productTasks','productGalleries'].includes(key)?Object.entries(after[key]).some(([id])=>!Object.hasOwn(before[key],id)&&!allowed.has(id)):added[key].some(v=>!allowed.has(v.productId)))fail('CATALOG_UNSCOPED_ADDITION');
  projection[key]=Object.fromEntries(Object.entries(after[key]??{}).filter(([id])=>Object.hasOwn(before[key]??{},id)));
 }
 const addedQueue=Object.entries(after.productProductionQueue.jobs).filter(([id])=>!Object.hasOwn(before.productProductionQueue.jobs,id)).map(([,j])=>j);
 if(addedQueue.length!==9||addedQueue.some(j=>!allowed.has(j.productId)||j.kind!=='materials'||j.status!=='completed'||!j.attemptStartedAt||!j.runId))fail('CATALOG_REVIEW_ATTEMPTS');
 projection.productProductionQueue.jobs=Object.fromEntries(Object.entries(after.productProductionQueue.jobs).filter(([id])=>Object.hasOwn(before.productProductionQueue.jobs,id)));
 if(added.assets.length<9||added.assets.length>90||added.generatedAssets.length!==27||added.productTasks.length!==9||added.productGalleries.length!==9||added.photoReviews.length!==9||added.jobs.length!==18||added.productPilotPackets.length!==18||added.productPilotImports.length!==36)fail('CATALOG_EXTENSION_COUNTS');
 const products=after.tasks.catalog.draft.products,old=before.tasks.catalog.draft.products;
 if(products.length!==10||!same(products.slice(0,old.length),old)||products.slice(old.length).some(p=>!allowed.has(p.id))||after.tasks.catalog.revision!==before.tasks.catalog.revision+27)fail('CATALOG_DRAFT_CHANGED');
 projection.tasks.catalog.draft.products=structuredClone(old);projection.tasks.catalog.revision=before.tasks.catalog.revision;
 if(!same(projection,before))fail('CATALOG_EXISTING_STATE_CHANGED');
 normalizeProducts(after,products,true);
 const executions=new Set(),newHashes=new Set();
 for(const id of productIds){
  const task=after.productTasks[id],product=task.submission?.product,unit=product?.visualUnits?.[0],gallery=after.productGalleries[id],queue=addedQueue.filter(j=>j.productId===id);
  if(!product||product.visualUnits.length!==1||queue.length!==1||!photosReady(after,product)||!same(products.find(p=>p.id===id),product)||!same(gallery?.source?.answers?.product,product))fail('CATALOG_PRODUCT_NOT_READY');
  const plan=productPhotoPlan(after,id),job=after.jobs[task.submission.hash+':work'];if(job.status!=='succeeded'||job.attempts!==1||job.result.hash!==digest(plan)||plan.slots.length!==3||gallery.slots.length!==3)fail('CATALOG_PLAN_INVALID');
  for(const slot of gallery.slots){
   if(slot.candidates.length!==1||slot.requests.length||slot.candidates[0].kind!=='initial')fail('CATALOG_REGENERATION_FORBIDDEN');
   const asset=after.generatedAssets[slot.candidates[0].assetId],receipt=added.productPilotImports.find(r=>r.productId===id&&r.slotId===slot.id),planned=plan.slots.find(s=>s.id===slot.id),packet=receipt&&after.productPilotPackets[receipt.packetId];
   if(!asset||asset.productId!==id||asset.visualUnitId!==unit.id||!receipt||packet?.kind!=='photos'||!same(asset.photoExecution,receipt.photoExecution)||asset.sha256!==receipt.photoExecution.outputSha256||receipt.photoExecution.promptHash!==planned?.promptHash||receipt.photoExecution.planHash!==job.result.hash||!same(receipt.photoExecution.sources,planned.sources))fail('CATALOG_IMAGE_PROVENANCE');
   const evidence=validateSessionExecution(receipt.executionEvidence,packet.payloadHash);if(evidence.tool!=='image_gen'||executions.has(evidence.executionId)||newHashes.has(asset.sha256)||Object.values(before.generatedAssets).some(a=>a.sha256===asset.sha256))fail('CATALOG_IMAGE_REUSED');executions.add(evidence.executionId);newHashes.add(asset.sha256);
  }
 }
 return {products:9,images:27,files:[...added.assets.map(a=>({file:'photo-'+a.id+'.bin',sha256:a.sha256,bytes:a.bytes})),...added.generatedAssets.map(a=>({file:'generated-'+a.id+'.bin',sha256:a.sha256,bytes:a.bytes}))]};
}
export async function runHostedCatalogExtension({config,store,accounts,folder=path.join(PRIVATE_ROOT,'molyvi-hosted-catalog')}={}){
 const c=validateHostedCatalogConfig(config),base=await directory(folder),manifest=await json(base,'manifest.json'),before=await json(base,'before.json'),after=await json(base,'after.json');
 if(digest(manifest)!==c.manifestHash||digest(before)!==c.beforeHash||digest(after)!==c.afterHash||!exact(manifest,['schemaVersion','productIds','files'])||manifest.schemaVersion!==1)fail('CATALOG_MANIFEST_CHANGED');
 const extension=validateCatalogExtension(before,after,manifest.productIds);if(!same(extension.files,manifest.files))fail('CATALOG_FILES_CHANGED');
 const link=accounts.db.prepare('SELECT p.status,p.owner_id,a.email FROM payment_links p JOIN accounts a ON a.id=p.account_id WHERE p.project_id=?').get(c.projectId);
 if(link?.status!=='granted'||link.owner_id!==before.ownerId||link.email!=='aioannidis@kooqie.com')fail('CATALOG_ACCOUNT_NOT_AUTHORIZED');
 const files=[];let total=0;
 for(const file of extension.files){const bytes=await ordinaryFile(base,file.file);total+=bytes.length;if(bytes.length!==file.bytes||bytes.length>10*1024*1024||total>150*1024*1024||sha(bytes)!==file.sha256)fail('CATALOG_BYTES_CHANGED');files.push([file.file,bytes]);}
 const {result}=await store.transact(c.projectId,before.ownerId,async current=>{
  const currentHash=digest(current);if(currentHash===c.afterHash)return {duplicate:true};if(currentHash!==c.beforeHash)fail('CATALOG_CURRENT_STATE_CHANGED');
  const target=await store.directory(c.projectId);
  for(const [name,bytes] of files){try{await fs.writeFile(path.join(target,name),bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||sha(await ordinaryFile(target,name))!==sha(bytes))throw e;}}
  for(const key of Object.keys(current))delete current[key];Object.assign(current,structuredClone(after));return {duplicate:false};
 });
 const receipt={status:'IMPORTED',runId:c.runId,projectId:c.projectId,beforeHash:c.beforeHash,afterHash:c.afterHash,products:9,images:27,creditsUnchanged:true,regenerationsConsumed:0};
 try{await fs.writeFile(path.join(base,'receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||!same(await json(base,'receipt.json'),receipt))throw e;}
 return {...receipt,duplicate:result.duplicate};
}
