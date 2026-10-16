import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PRIVATE_ROOT,canonicalJson,IntakeError} from './intake-store.mjs';
import {ordinaryFile} from './service-handoff.mjs';
import {CONTROLLED_PRO_PROJECT,CONTROLLED_PRO_ORDER} from './hosted-controlled-pro.mjs';
import {createServiceProductionQueue,serviceProductionEligible} from './service-production-queue.mjs';
import {approvedBrandPresentation} from './brand-presentation.mjs';
import {prepareProductPilot} from './product-pilot-import.mjs';
import {preparePhotoExecution,validatePhotoExecution,importPlannedPhoto} from './product-photo-execution.mjs';
import {validatePhoto} from './product-assets.mjs';
import {validateSessionExecution} from './session-execution.mjs';

const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const digest=x=>sha(canonicalJson(x));
const uuid=x=>typeof x==='string'&&/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(x);
const hash=x=>typeof x==='string'&&/^[a-f\d]{64}$/.test(x);
const fail=code=>{throw new IntakeError(code,503);};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const sourceKeys=['projectId','orderId','businessHash','brandingHash','approvedBrandHash','photosHash','productId','productHash','visualUnitId'];
export function validateHostedPhotoConfig(c){
  const keys=['scope','mode','runId','createdAt','expiresAt',...sourceKeys,...(c?.mode==='prepare'?['augmentations']:['images'])];
  if(!exact(c,keys)||c.scope!=='molyvi_hosted_initial_photos_v1'||!['prepare','import'].includes(c.mode)||!uuid(c.runId)||
    c.projectId!==CONTROLLED_PRO_PROJECT||c.orderId!==CONTROLLED_PRO_ORDER||!uuid(c.productId)||!uuid(c.visualUnitId)||
    ['businessHash','brandingHash','approvedBrandHash','photosHash','productHash'].some(k=>!hash(c[k])))fail('HOSTED_PHOTO_SCOPE_INVALID');
  const start=Date.parse(c.createdAt),end=Date.parse(c.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>1200000||start>Date.now()+60000||end<=Date.now())fail('HOSTED_PHOTO_WINDOW_INVALID');
  if(c.mode==='prepare'){
    if(!Array.isArray(c.augmentations)||c.augmentations.length!==3||c.augmentations.some(s=>typeof s!=='string'||s.length>8000))fail('HOSTED_PHOTO_AUGMENTATIONS_INVALID');
  }else if(!Array.isArray(c.images)||c.images.length!==3||new Set(c.images.map(i=>i.slotId)).size!==3||c.images.some((i,index)=>
    !exact(i,['slotId','file','sha256','evidence'])||i.slotId!==`${c.visualUnitId}:photo-${index+1}`||i.file!==`photo-${index+1}.png`||!hash(i.sha256)))fail('HOSTED_PHOTO_IMAGES_INVALID');
  return structuredClone(c);
}
async function privateDirectory(folder,{create=false}={}){
  if(create)await fs.mkdir(folder,{recursive:true,mode:0o700});
  const stat=await fs.lstat(folder),real=await fs.realpath(folder),base=await fs.realpath(PRIVATE_ROOT),rel=path.relative(base,real);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!rel||rel.startsWith('..')||path.isAbsolute(rel))fail('HOSTED_PHOTO_PRIVATE_DIRECTORY_REQUIRED');return real;
}
async function privateJson(folder,file,max=65536){
  const stat=await fs.lstat(path.join(folder,file));
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max||process.platform!=='win32'&&(stat.mode&0o077))fail('HOSTED_PHOTO_PRIVATE_FILE_REQUIRED');
  return JSON.parse(await ordinaryFile(folder,file));
}
export async function loadHostedPhotoConfig({enabled=false,folder=path.join(PRIVATE_ROOT,'molyvi-hosted-photos')}={}){
  return enabled?validateHostedPhotoConfig(await privateJson(await privateDirectory(folder),'config.json')):null;
}
const binding=c=>Object.fromEntries(sourceKeys.map(k=>[k,c[k]]));

// Startup-only trusted operation, before HTTP listeners or workers start. No
// customer route, model dispatch, credentials, recurring task or regeneration.
export async function runHostedPhotoOperation({config,store,accounts,storage}={}){
  const c=validateHostedPhotoConfig(config),folder=await privateDirectory(path.join(storage,c.runId),{create:true});
  const p=JSON.parse(await ordinaryFile(await store.directory(c.projectId),'workspace.json'));
  const link=accounts.db.prepare('SELECT p.status,p.owner_id,a.email FROM payment_links p JOIN accounts a ON a.id=p.account_id WHERE p.project_id=?').get(c.projectId);
  if(!serviceProductionEligible(p)||p.order.id!==c.orderId||p.servicePurchase.intentScope!=='molyvi_hosted_test_v1'||link?.status!=='granted'||link.owner_id!==p.ownerId||link.email!=='aioannidis@kooqie.com'||
    p.tasks.business.submission?.hash!==c.businessHash||p.tasks.branding.submission?.hash!==c.brandingHash||p.tasks.branding.approvedHash!==c.approvedBrandHash||!approvedBrandPresentation(p)||
    p.tasks.photos.submission?.hash!==c.photosHash||p.productTasks[c.productId]?.submission?.hash!==c.productHash||Object.keys(p.productTasks).length!==1)fail('HOSTED_PHOTO_SOURCE_NOT_AUTHORIZED');
  const product=p.productTasks[c.productId].submission.product;
  if(product.visualUnits?.length!==1||product.visualUnits[0].id!==c.visualUnitId||product.visualUnits[0].sourceAssetIds.length!==3||p.tasks.photos.submission.answers.mix!=='white_lifestyle')fail('HOSTED_PHOTO_SOURCE_NOT_AUTHORIZED');
  const session={projectId:p.id,ownerId:p.ownerId},ledger=canonicalJson(p.creditLedger??null);
  let prepared;
  try{prepared=await privateJson(folder,'prepared.json');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(prepared&&(!exact(prepared,['schemaVersion','binding','packet','specifications'])||prepared.schemaVersion!==1||canonicalJson(prepared.binding)!==canonicalJson(binding(c))))fail('HOSTED_PHOTO_PREPARED_CONFLICT');
  if(c.mode==='prepare'){
    if(!prepared){
      const queue=createServiceProductionQueue({store,provider:async()=>fail('HOSTED_PHOTO_INFERENCE_FORBIDDEN'),enabled:true,projectIds:[p.id],taskIds:['photos','catalog'],attemptLimit:1});
      try{await queue.drain();}finally{await queue.stop();}
      const {result:packet}=await prepareProductPilot(store,session,{productId:c.productId,visualUnitId:c.visualUnitId,kind:'photos'}),current=await store.read(p.id,p.ownerId);
      const specifications=packet.slots.map((s,i)=>preparePhotoExecution(current,packet,{slotId:s.id,operatorAugmentation:c.augmentations[i]}));
      if(specifications.length!==3)fail('HOSTED_PHOTO_SLOT_LIMIT');
      prepared={schemaVersion:1,binding:binding(c),packet,specifications};
      await fs.writeFile(path.join(folder,'prepared.json'),JSON.stringify(prepared)+'\n',{flag:'wx',mode:0o600});
    }else if(prepared.specifications.some((s,i)=>s.operatorAugmentation!==c.augmentations[i]))fail('HOSTED_PHOTO_PREPARED_CONFLICT');
    const current=await store.read(p.id,p.ownerId);for(const s of prepared.specifications)validatePhotoExecution(current,prepared.packet,s);
    return {status:'PREPARED',runId:c.runId,packetHash:prepared.packet.payloadHash,slots:prepared.specifications.length};
  }
  if(!prepared)fail('HOSTED_PHOTO_PREPARATION_REQUIRED');
  const current=await store.read(p.id,p.ownerId),commands=[];
  if(current.productGalleries[c.productId]?.slots.some(s=>s.candidates.length>1||s.requests.length))fail('HOSTED_PHOTO_INITIAL_LIMIT_CONFLICT');
  for(const image of c.images){
    const spec=prepared.specifications.find(s=>s.slotId===image.slotId);validatePhotoExecution(current,prepared.packet,spec);
    const evidence=validateSessionExecution(image.evidence,prepared.packet.payloadHash);if(evidence.tool!=='image_gen')fail('HOSTED_PHOTO_TOOL_INVALID');
    const bytes=await ordinaryFile(folder,image.file);if(bytes.length>10*1024*1024||sha(bytes)!==image.sha256)fail('HOSTED_PHOTO_OUTPUT_CHANGED');
    const result={slotId:spec.slotId,name:image.file,mime:'image/png',data:bytes.toString('base64'),sha256:image.sha256};validatePhoto(result);
    commands.push({packet:prepared.packet,specification:spec,result,evidence});
  }
  const receipts=[];for(const command of commands){const imported=await importPlannedPhoto(store,session,command);receipts.push(imported.result.receipt);}
  const after=await store.read(p.id,p.ownerId);
  if(canonicalJson(after.creditLedger??null)!==ledger||after.productGalleries[c.productId].slots.some(s=>s.candidates.length!==1||s.requests.length))fail('HOSTED_PHOTO_INITIAL_LIMIT_CONFLICT');
  const receipt={status:'IMPORTED',runId:c.runId,packetHash:prepared.packet.payloadHash,images:receipts.length,receiptsHash:digest(receipts),creditsUnchanged:true,regenerationsConsumed:0};
  try{const prior=await privateJson(folder,'imported.json');if(canonicalJson(prior)!==canonicalJson(receipt))fail('HOSTED_PHOTO_RECEIPT_CONFLICT');}
  catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(path.join(folder,'imported.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});}
  return receipt;
}
