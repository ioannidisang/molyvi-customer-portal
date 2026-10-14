import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {serviceProductionEligible,applyServiceBusinessResult} from './service-production-queue.mjs';
import {approvedBrandPresentation} from './brand-presentation.mjs';
import {catalogCounts,normalizeCatalogFields} from './catalog-model.mjs';
import {finalizeProductTexts} from './product-text.mjs';
import {gallerySelectionSnapshot} from './product-gallery.mjs';
import {productPhotoPlan} from './product-photo-plan.mjs';
import {preparePhotoExecution} from './product-photo-execution.mjs';
import {validateSessionExecution} from './session-execution.mjs';
import {readPhoto,readGeneratedPhoto,validatePhoto} from './product-assets.mjs';
import {readLogo} from './logo-assets.mjs';
import {SERVICE_OPERATION_TASK_IDS,readServiceOperation} from './service-operations.mjs';
import {previewStoreContent} from './store-content.mjs';
import {escapeStoreContentHtml as escapeHtml} from '../../molyvi-contract/lib/store-content.mjs';

export const SERVICE_PACKAGE_STORE='molyvi-still-dev.myshopify.com';
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(code,422);};
const ids=['terms','privacy','returns','shipping','about','contact','faq'];
const uuid=value=>/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value??'');
const extension=mime=>({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]);
const json=value=>JSON.stringify(value,null,2)+'\n';
const qa='Εσωτερική δοκιμή Molyvi — εικονικά στοιχεία και τιμές. Χωρίς πραγματικές αγορές.';

function checkedTask(record,id){
  const submission=record.tasks[id]?.submission;
  if(!submission||submission.hash!==hash({projectId:record.id,taskId:id,schemaVersion:record.schemaVersion,answers:submission.answers,...(submission.productCopy?{productCopy:submission.productCopy}:{})}))fail('SERVICE_PACKAGE_TASK_SOURCE_INVALID');
  const job=record.jobs[`${submission.hash}:work`];
  if(job?.status!=='succeeded'||!job.result||hash(job.result.output)!==job.result.hash||job.inputs?.submissionHash!==submission.hash||!equal(job.inputs?.answers,submission.answers))fail('SERVICE_PACKAGE_TASK_PENDING_OR_STALE');
  return {submissionHash:submission.hash,resultHash:job.result.hash,inputHash:hash(job.inputs)};
}
function checkedBytes(asset,items){
  const matches=items?.filter(item=>item.asset?.id===asset?.id)??[];
  if(!asset||matches.length!==1)fail('SERVICE_PACKAGE_IMAGE_BYTES_REQUIRED');
  const item=matches[0];
  if(!Buffer.isBuffer(item.bytes)||!equal(item.asset,asset)||asset.bytes!==item.bytes.length||asset.sha256!==bytesHash(item.bytes))fail('SERVICE_PACKAGE_IMAGE_INTEGRITY_FAILED');
  validatePhoto({name:asset.name,mime:asset.mime,data:item.bytes.toString('base64')});
  return item;
}
function checkedPhotoLineage(record,product,photo,asset,work){
  const gallery=record.productGalleries[product.id],slot=gallery.slots.find(item=>item.id===photo.slotId),candidate=slot.candidates.find(item=>item.id===photo.candidateId);
  if(candidate.kind!=='initial')fail('SERVICE_PACKAGE_INITIAL_SELECTION_REQUIRED');
  const receipts=Object.values(record.productPilotImports??{}).filter(item=>item.kind==='photos'&&item.productId===product.id&&item.slotId===photo.slotId&&item.delivered?.assetId===asset.id);
  if(receipts.length!==1)fail('SERVICE_PACKAGE_PHOTO_RECEIPT_REQUIRED');
  const receipt=receipts[0],packet=record.productPilotPackets?.[receipt.packetId],provenance=asset.photoExecution;
  if(!packet||!provenance||!equal(receipt.photoExecution,provenance)||!equal(receipt.delivered,candidate)||!equal(receipt.executionEvidence,asset.executionEvidence))fail('SERVICE_PACKAGE_PHOTO_PROVENANCE_INVALID');
  const evidence=validateSessionExecution(asset.executionEvidence,packet.payloadHash);
  if(evidence.tool!=='image_gen'||provenance.executionId!==evidence.executionId||provenance.outputSha256!==asset.sha256||provenance.planHash!==work.result.hash)fail('SERVICE_PACKAGE_PHOTO_PROVENANCE_INVALID');
  // Native execution evidence is a trusted operator attestation, not a provider
  // billing receipt or a certification that every product detail is faithful.
  const result={slotId:photo.slotId,sha256:asset.sha256,name:asset.name,mime:asset.mime};
  if(receipt.resultHash!==hash({result,evidence}))fail('SERVICE_PACKAGE_PHOTO_RECEIPT_CHANGED');
  const slotPlan=work.result.output.slots.find(item=>item.id===photo.slotId);
  if(!slotPlan||provenance.promptHash!==slotPlan.promptHash||!equal(provenance.sources,slotPlan.sources)||!uuid(evidence.executionId)||!/^[a-f\d]{64}$/.test(provenance.specHash??'')||!/^[a-f\d]{64}$/.test(provenance.executionPromptHash??''))fail('SERVICE_PACKAGE_PHOTO_PROVENANCE_INVALID');
  // Recompute immutable packet/plan/reference relationships. An operator may
  // append prompt guidance; only its preserved digest is available in record.
  preparePhotoExecution(record,packet,{slotId:photo.slotId});
  return {receiptHash:hash(receipt),packetHash:packet.payloadHash,executionId:evidence.executionId,...structuredClone(provenance),attestation:'trusted_session_operator',providerBillingVerified:false};
}

// Strict first full Basic service assembly. It reads an already paid workspace;
// it cannot simulate payment, finish jobs, approve a customer review or write to
// Shopify. The independent namespace also prevents collision with prior pilots.
export function prepareServiceStorePackage(record,{targetStore,assets=[],sourceAssets=[],logo=null}={}){
  if(targetStore!==SERVICE_PACKAGE_STORE)fail('SERVICE_PACKAGE_TARGET_NOT_AUTHORIZED');
  if(!uuid(record?.id)||!serviceProductionEligible(record)||record.order.packageId!=='basic'||!/^\d+$/.test(record.servicePurchase.receipt.orderId))fail('SERVICE_PACKAGE_VERIFIED_BASIC_REQUIRED');
  const products=record.tasks.catalog.draft.products??[];
  if(!equal(catalogCounts(products),{catalogProducts:10,variants:14,visualUnits:10,initialPhotoSlots:30}))fail('SERVICE_PACKAGE_EXACT_BASIC_REQUIRED');
  const common=Object.fromEntries(['business','branding','photos',...SERVICE_OPERATION_TASK_IDS].map(id=>[id,checkedTask(record,id)]));
  // Reuse the worker's validated receipt path on an isolated copy. A succeeded
  // job must still bind its provider receipt to this exact business submission.
  if(applyServiceBusinessResult(structuredClone(record),`${common.business.submissionHash}:work`).duplicate!==true)fail('SERVICE_PACKAGE_BUSINESS_RECEIPT_REQUIRED');
  const branding=approvedBrandPresentation(record);if(!branding)fail('SERVICE_PACKAGE_BRAND_APPROVAL_REQUIRED');
  const namespace=`molyvi-service-${record.servicePurchase.receipt.orderId}-${record.id.slice(0,8)}`,uploads=[],sourceEvidence=[],warnings=[];
  let logoFile=null;
  if(branding.logoMode==='existing'){
    const item=checkedBytes(record.brandAssets?.[branding.logoAssetId],logo?[logo]:[]);
    logoFile=`branding/logo.${extension(item.asset.mime)}`;uploads.push({fileName:logoFile,bytes:item.bytes,sha256:item.asset.sha256});
  }
  const skus=new Set();
  const catalog=products.map((product,index)=>{
    normalizeCatalogFields(record,product,{complete:true});
    const submission=record.productTasks?.[product.id]?.submission;
    if(!submission||!equal(submission.product,product))fail('SERVICE_PACKAGE_PRODUCT_FROZEN_REQUIRED');
    const {hash:submissionHash,submittedAt,...source}=submission;
    if(hash({projectId:record.id,productId:product.id,schemaVersion:record.schemaVersion,...source})!==submissionHash)fail('SERVICE_PACKAGE_PRODUCT_SOURCE_INVALID');
    const copy=finalizeProductTexts(record,[product])[0];if(!equal(copy,submission.productCopy))fail('SERVICE_PACKAGE_PRODUCT_COPY_STALE');
    const work=record.jobs[`${submissionHash}:work`],plan=productPhotoPlan(record,product.id),gallery=record.productGalleries?.[product.id];
    if(work?.status!=='succeeded'||work.result?.hash!==hash(plan)||!equal(work.result.output,plan)||!equal(work.inputs?.answers?.product,product)||!equal(work.inputs?.productCopy,copy)||work.inputs?.submissionHash!==submissionHash||!equal(work.inputs?.photoEvidence,submission.photoEvidence)||!equal(gallery?.source,work.inputs)||gallery.sourceHash!==hash(work.inputs))fail('SERVICE_PACKAGE_PRODUCT_JOB_STALE');
    const expectedDependencies=[{id:'branding',submissionHash:common.branding.submissionHash,resultHash:common.branding.resultHash},{id:'photos',submissionHash:common.photos.submissionHash}];
    if(!equal(work.inputs.dependencies,expectedDependencies)||!equal(work.inputs.branding,record.tasks.branding.submission.answers)||!equal(work.inputs.presentation,record.tasks.photos.submission.answers))fail('SERVICE_PACKAGE_PRODUCT_JOB_STALE');
    for(const reference of submission.photoEvidence){const asset=record.assets[reference.id],item=checkedBytes(asset,sourceAssets);if(asset.productId!==product.id||reference.sha256!==item.asset.sha256)fail('SERVICE_PACKAGE_SOURCE_REFERENCE_STALE');sourceEvidence.push({productId:product.id,assetId:asset.id,sha256:asset.sha256,bytes:asset.bytes});}
    const selection=gallerySelectionSnapshot(record,product.id);if(selection.photos.length!==3||product.visualUnits.length!==1)fail('SERVICE_PACKAGE_PRODUCT_IMAGES_INCOMPLETE');
    const photos=selection.photos.map((photo,photoIndex)=>{
      const item=checkedBytes(record.generatedAssets?.[photo.assetId],assets),asset=item.asset;
      const lineage=checkedPhotoLineage(record,product,photo,asset,work);
      const fileName=`images/${namespace}-${index+1}-${photoIndex+1}.${extension(asset.mime)}`;
      uploads.push({fileName,bytes:item.bytes,sha256:asset.sha256});
      const slot=gallery.slots.find(item=>item.id===photo.slotId);
      if(slot.requests.some(request=>!['completed','failed_no_output','cancelled'].includes(request.status)))warnings.push({code:'PHOTO_REQUEST_PENDING',productId:product.id,slotId:photo.slotId});
      return {...photo,position:photoIndex+1,fileName,mime:asset.mime,bytes:asset.bytes,alt:`${copy.title.text} — ${photo.role==='white'?'λευκό φόντο':`παρουσίαση ${photoIndex+1}`} (Molyvi Service QA)`,lineage};
    });
    const variants=product.variants.map((variant,variantIndex)=>{
      if(!variant.sku||skus.has(variant.sku)||![100,200].includes(variant.priceMinor)||!Number.isInteger(variant.stock)||variant.stock<0||variant.stock>5)fail('SERVICE_PACKAGE_QA_VARIANT_INVALID');skus.add(variant.sku);
      return {...variant,sourceSku:variant.sku,sku:`MS-${record.servicePurchase.receipt.orderId}-${record.id.slice(0,8).toUpperCase()}-${index+1}-${variantIndex+1}`,price:(variant.priceMinor/100).toFixed(2),trackInventory:true,continueSellingWhenOutOfStock:false,visualUnitId:product.visualUnits[0].id,imagePosition:1};
    });
    const descriptionText=`${qa}\n${copy.description.text}`;
    return {productId:product.id,handle:`${namespace}-${product.id.slice(0,8)}`,title:`Molyvi Service QA — ${copy.title.text}`,descriptionText,descriptionHtml:descriptionText.split('\n').map(line=>`<p>${escapeHtml(line)}</p>`).join('\n'),status:'DRAFT',publishedOnOnlineStore:false,currency:'EUR',vendor:'Molyvi Service QA',type:product.category,tags:[namespace],variants,photos,source:{submissionHash,copyHash:hash(copy),workInputHash:hash(work.inputs),workResultHash:work.result.hash,galleryHash:selection.sourceHash,selectionHash:hash(selection)}};
  });
  const operations=Object.fromEntries(SERVICE_OPERATION_TASK_IDS.map(id=>{const artifact=readServiceOperation(record,id);if(!artifact)fail('SERVICE_PACKAGE_OPERATION_PENDING');return[id,artifact];}));
  const content=previewStoreContent(record);
  if(!content.allInputsSubmitted||content.pending.length||content.documents.length!==7||ids.some(id=>content.documents.filter(document=>document.id===id).length!==1))fail('SERVICE_PACKAGE_CONTENT_INCOMPLETE');
  const pages=ids.map(id=>{
    const doc=content.documents.find(item=>item.id===id),bodyHtml=`<p><strong>${escapeHtml(qa)}</strong></p>\n${doc.publicHtml}`;
    return {documentId:id,title:`Molyvi Service QA — ${doc.title}`,handle:`${namespace}-${id}`,bodyHtml,bodyText:`${qa}\n${doc.publicText}`,bodySha256:bytesHash(bodyHtml),isPublished:false,status:'DRAFT'};
  });
  for(const claim of Object.values(record.photoClaims??{}))if(['awaiting_review','needs_specialist','escalated'].includes(claim.status))warnings.push({code:'PHOTO_CLAIM_PENDING',claimId:claim.id,productId:claim.productId,slotId:claim.slotId,status:claim.status});
  const plan={schemaVersion:1,kind:'molyvi_service_store_package',projectId:record.id,orderId:record.order.id,targetStore,namespace,status:'DRAFT',applicationAuthorized:false,publicationAuthorized:false,productionAdapter:false,overwriteExisting:false,deleteExisting:false,
    counts:{products:10,variants:14,photos:30,pages:7},branding:{...branding,logoFile},products:catalog,operations,pages,
    review:{customerAcceptance:'PENDING',contentReview:content.approval??null,legalCertification:false,publicationBlockers:content.publicationBlockers,paymentActivation:'owner_setup_pending',nativeShopifySettings:'PENDING',imageFidelity:'not_certified',warnings},
    source:{recordHash:hash(record),paymentReceiptHash:hash(record.servicePurchase.receipt),businessReceiptHash:hash(record.jobs[`${common.business.submissionHash}:work`].providerResult),common,originalImages:sourceEvidence,contentBundleHash:content.bundleHash,contentTemplateVersion:content.templateVersion,operationHashes:Object.fromEntries(Object.entries(operations).map(([id,artifact])=>[id,hash(artifact)]))}};
  return {plan:{...plan,planHash:hash(plan)},uploads};
}

export async function prepareStoredServiceStorePackage(store,session,{targetStore}={}){
  const record=await store.read(session.projectId,session.ownerId),assets=[],sourceAssets=[];
  for(const product of record.tasks.catalog.draft.products){
    for(const photo of gallerySelectionSnapshot(record,product.id).photos)assets.push(await readGeneratedPhoto(store,session,photo.assetId));
    for(const ref of record.productTasks[product.id].submission.photoEvidence)sourceAssets.push(await readPhoto(store,session,ref.id));
  }
  const branding=approvedBrandPresentation(record),logo=branding?.logoAssetId?await readLogo(store,session,branding.logoAssetId):null;
  const prepared=prepareServiceStorePackage(record,{targetStore,assets,sourceAssets,logo});
  if(hash(await store.read(session.projectId,session.ownerId))!==prepared.plan.source.recordHash)fail('SERVICE_PACKAGE_RECORD_CHANGED_DURING_READ');
  return prepared;
}

function checkPlan(plan){
  const {planHash,...unsigned}=plan;
  if(plan.kind!=='molyvi_service_store_package'||planHash!==hash(unsigned)||plan.targetStore!==SERVICE_PACKAGE_STORE||plan.status!=='DRAFT'||plan.applicationAuthorized!==false||plan.publicationAuthorized!==false||plan.overwriteExisting!==false||plan.deleteExisting!==false)fail('SERVICE_PACKAGE_PLAN_CORRUPTED');
}
const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
export function serviceStoreCatalogCsv(plan){
  checkPlan(plan);
  const columns=['Handle','Title','Body (HTML)','Vendor','Type','Tags','Published','Option1 Name','Option1 Value','Variant SKU','Variant Grams','Variant Inventory Tracker','Variant Inventory Qty','Variant Inventory Policy','Variant Fulfillment Service','Variant Price','Variant Requires Shipping','Variant Taxable','Status'];
  const rows=plan.products.flatMap(product=>product.variants.map((variant,index)=>[product.handle,index?'':product.title,index?'':product.descriptionHtml,index?'':product.vendor,index?'':product.type,index?'':product.tags.join(','),'FALSE',variant.size?'Μέγεθος':'Title',variant.size??'Default Title',variant.sku,variant.weightGrams,'shopify',variant.stock,'deny','manual',variant.price,'TRUE','TRUE','draft']));
  return [columns,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
const inside=(root,child)=>{const relative=path.relative(root,child);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
async function safePrivateDestination(directory){
  const roots=[path.join(WORKSPACE_ROOT,'briefs'),path.join(WORKSPACE_ROOT,'customer-materials')];
  const resolved=path.resolve(directory),root=roots.find(root=>inside(root,resolved));if(!root)fail('SERVICE_PACKAGE_PRIVATE_OUTPUT_REQUIRED');
  const parent=path.dirname(resolved),relative=path.relative(root,parent);
  let current=root;
  for(const part of ['',...relative.split(path.sep).filter(Boolean)]){if(part)current=path.join(current,part);const info=await fs.lstat(current);if(info.isSymbolicLink()||!info.isDirectory())fail('SERVICE_PACKAGE_UNSAFE_OUTPUT');}
  return resolved;
}
async function listFiles(directory,prefix=''){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=prefix?`${prefix}/${entry.name}`:entry.name;if(entry.isSymbolicLink())fail('SERVICE_PACKAGE_UNSAFE_OUTPUT');
    if(entry.isDirectory())files.push(...await listFiles(path.join(directory,entry.name),file));else if(entry.isFile())files.push(file);else fail('SERVICE_PACKAGE_UNSAFE_OUTPUT');
  }
  return files.sort();
}
// New private folder or byte-identical replay only. Incomplete/altered output
// remains untouched for inspection; a new folder is required to recover it.
export async function writeServiceStorePackage(prepared,{outputDirectory}={}){
  checkPlan(prepared.plan);const plan=prepared.plan,directory=await safePrivateDestination(outputDirectory),files=new Map();
  const add=(file,value)=>{if(files.has(file)||/[\\:\x00-\x1f]/.test(file)||file.split('/').some(part=>!part||part==='..'||part==='.')||path.isAbsolute(file))fail('SERVICE_PACKAGE_FILE_CONFLICT');files.set(file,Buffer.isBuffer(value)?value:Buffer.from(value));};
  add('package-plan.json',json(plan));add('catalog.csv',serviceStoreCatalogCsv(plan));add('branding.json',json(plan.branding));
  for(const [id,artifact]of Object.entries(plan.operations))add(`operations/${id}.json`,json(artifact));
  for(const page of plan.pages){add(`pages/${page.documentId}.html`,page.bodyHtml);add(`pages/${page.documentId}.txt`,page.bodyText);}
  const expectedUploads=plan.products.flatMap(product=>product.photos.map(photo=>({fileName:photo.fileName,sha256:photo.sha256}))).concat(plan.branding.logoFile?[{fileName:plan.branding.logoFile,sha256:plan.branding.logoSha256}]:[]);
  if(prepared.uploads.length!==expectedUploads.length)fail('SERVICE_PACKAGE_UPLOADS_CHANGED');
  for(const expected of expectedUploads){const matches=prepared.uploads.filter(item=>item.fileName===expected.fileName);if(matches.length!==1||!Buffer.isBuffer(matches[0].bytes)||bytesHash(matches[0].bytes)!==expected.sha256||matches[0].sha256!==expected.sha256)fail('SERVICE_PACKAGE_UPLOADS_CHANGED');add(expected.fileName,matches[0].bytes);}
  add('README.md',`# Molyvi — πακέτο ελέγχου Basic\n\n${qa}\n\nΠαραγγελία: ${plan.orderId}. Κατάσταση: DRAFT.\n\n10 προϊόντα, 14 παραλλαγές, 30 επιλεγμένες εικόνες και 7 προσχέδια σελίδων. Το catalog.csv περιέχει μόνο προϊόντα σε Draft, με χωριστά αρχεία εικόνων. Οι σελίδες προορίζονται για κρυφή δοκιμαστική εφαρμογή.\n\nΔεν καταγράφεται πελατειακή αποδοχή, νομική πιστοποίηση, ενεργοποίηση πληρωμών ή εξουσιοδότηση δημοσίευσης. Οι αρχικές τιμές/αποθέματα είναι QA. Οι αποστολές, τα στοιχεία πωλητή και οι πληρωμές βρίσκονται ως σχέδια στον φάκελο operations και δεν έχουν εφαρμοστεί στο Shopify.\n\nΤα αρχεία και τα στοιχεία πωλητή είναι ιδιωτικά. Απαγορεύεται δημόσιο ανέβασμα αυτού του φακέλου. Όλα τα ψηφιακά αποτυπώματα βρίσκονται στο manifest.json.\n`);
  const manifest={schemaVersion:1,kind:'molyvi_service_store_package_manifest',projectId:plan.projectId,orderId:plan.orderId,planHash:plan.planHash,sourceRecordHash:plan.source.recordHash,files:[...files.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([file,bytes])=>({file,bytes:bytes.length,sha256:bytesHash(bytes)}))};
  add('manifest.json',json(manifest));
  let duplicate=false;
  try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;const info=await fs.lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())fail('SERVICE_PACKAGE_UNSAFE_OUTPUT');duplicate=true;}
  if(duplicate){
    if(!equal(await listFiles(directory),[...files.keys()].sort()))fail('SERVICE_PACKAGE_OUTPUT_EXISTS');
    for(const [file,bytes]of files)if(!(await fs.readFile(path.join(directory,...file.split('/')))).equals(bytes))fail('SERVICE_PACKAGE_OUTPUT_EXISTS');
  }else for(const [file,bytes]of files){const destination=path.join(directory,...file.split('/'));await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,bytes,{flag:'wx',mode:0o600});}
  return {directory,duplicate,planHash:plan.planHash,manifestSha256:bytesHash(files.get('manifest.json')),fileCount:files.size,manifest};
}
