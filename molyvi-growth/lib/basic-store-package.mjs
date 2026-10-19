import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {serviceProductionEligible,applyServiceBusinessResult} from './service-production-queue.mjs';
import {approvedBrandPresentation} from './brand-presentation.mjs';
import {catalogCounts,normalizeCatalogFields,CATALOG_TECHNICAL_LIMITS} from './catalog-model.mjs';
import {packageForOrder} from './service-offer.mjs';
import {finalizeProductTexts} from './product-text.mjs';
import {gallerySelectionSnapshot,photoSourceForSlot} from './product-gallery.mjs';
import {productPhotoPlan} from './product-photo-plan.mjs';
import {preparePhotoExecution} from './product-photo-execution.mjs';
import {validateSessionExecution} from './session-execution.mjs';
import {readPhoto,readGeneratedPhoto,validatePhoto} from './product-assets.mjs';
import {readLogo} from './logo-assets.mjs';
import {SERVICE_OPERATION_TASK_IDS,readServiceOperation} from './service-operations.mjs';
import {previewStoreContent} from './store-content.mjs';
import {escapeStoreContentHtml as escapeHtml} from '../../molyvi-contract/lib/store-content.mjs';

const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(code,422);};
const ids=['terms','privacy','returns','shipping','about','contact','faq'];
const uuid=value=>/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value??'');
const extension=mime=>({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]);
const json=value=>JSON.stringify(value,null,2)+'\n';
const preview='Ιδιωτική προετοιμασία Basic. Δεν έχει εφαρμοστεί ή δημοσιευτεί κατάστημα.';
export const BASIC_ASSEMBLY_INPUT_BYTES_CAP=128*1024*1024;
const validTarget=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(value);
const money=minor=>`${BigInt(minor)/100n}.${String(BigInt(minor)%100n).padStart(2,'0')}`;
const optionKey=value=>(value??'').trim().normalize('NFC').toLocaleLowerCase('el');
const optionNamesFor=variants=>{
  const names=[...(variants.some(v=>v.color)?['Χρώμα']:[]),...(variants.some(v=>v.size)?['Μέγεθος']:[])];
  return names.length?names:['Title'];
};
const safeCsvText=value=>{if(/^[\s]*[=+@\-\t\r\n]/u.test(String(value??'')))fail('BASIC_PACKAGE_SPREADSHEET_FORMULA');return value;};

// An exact local intent binding, NOT a credential, verified store ownership,
// payment verifier or permission to apply a package. Trusted callers supply
// the owner-scoped record. The stored wrapper reads it through the session.
export function createBasicAssemblyBinding(record,{targetStore}={}){
  if(!uuid(record?.id)||!uuid(record.ownerId)||!validTarget(targetStore))fail('BASIC_PACKAGE_BINDING_INVALID');
  const binding={schemaVersion:1,kind:'molyvi_basic_local_assembly_binding',projectId:record.id,ownerHash:hash(record.ownerId),orderId:record.order.id,targetStore,sourceRecordHash:hash(record),offerHash:hash(record.order.offerSnapshot??null),applicationAuthorized:false,publicationAuthorized:false};
  return {...binding,bindingHash:hash(binding)};
}
function checkedBinding(record,targetStore,binding){
  if(!binding||!equal(binding,createBasicAssemblyBinding(record,{targetStore})))fail('BASIC_PACKAGE_BINDING_STALE_OR_MISMATCHED');
}
function basicCounts(record,products){
  const pack=packageForOrder(record.order),ent=pack.entitlements;
  if(pack.id!=='basic'||ent.catalogUnits!==10||ent.photoSlotsPerUnit!==3||ent.photoSlots!==30||record.order.currency!=='EUR'||record.order.offerSnapshot&&(!equal(record.order.entitlements,ent)||record.order.packageId!==record.order.offerSnapshot.packageId))fail('BASIC_PACKAGE_OFFER_MISMATCH');
  const counts=catalogCounts(products,ent.photoSlotsPerUnit);
  if(!counts.catalogProducts||counts.catalogProducts>10||!counts.visualUnits||counts.visualUnits>ent.catalogUnits||counts.variants>CATALOG_TECHNICAL_LIMITS.variantsPerProject||new Set(products.map(p=>p.id)).size!==products.length||products.some(p=>!uuid(p.id)))fail('BASIC_PACKAGE_BASIC_ALLOWANCE_EXCEEDED');
  return {counts,pack};
}
// Conservative local assembly ceiling, not a customer storage allowance or a
// claim that the hosted process has been capacity-tested. Check before reads.
function checkedAssetBudget(record){
  const references=new Map();
  for(const product of record.tasks.catalog.draft.products){
    for(const photo of gallerySelectionSnapshot(record,product.id).photos)references.set(`generated:${photo.assetId}`,record.generatedAssets?.[photo.assetId]);
    for(const ref of record.productTasks?.[product.id]?.submission?.photoEvidence??[])references.set(`source:${ref.id}`,record.assets?.[ref.id]);
  }
  const branding=approvedBrandPresentation(record);if(branding?.logoAssetId)references.set(`logo:${branding.logoAssetId}`,record.brandAssets?.[branding.logoAssetId]);
  let bytes=0;for(const asset of references.values()){if(!Number.isSafeInteger(asset?.bytes)||asset.bytes<=0)fail('BASIC_PACKAGE_IMAGE_BYTES_REQUIRED');bytes+=asset.bytes;if(bytes>BASIC_ASSEMBLY_INPUT_BYTES_CAP)fail('BASIC_PACKAGE_INPUT_BYTES_LIMIT');}
  return bytes;
}

function checkedTask(record,id){
  const submission=record.tasks[id]?.submission;
  if(!submission||submission.hash!==hash({projectId:record.id,taskId:id,schemaVersion:record.schemaVersion,answers:submission.answers,...(submission.productCopy?{productCopy:submission.productCopy}:{})}))fail('BASIC_PACKAGE_TASK_SOURCE_INVALID');
  const job=record.jobs[`${submission.hash}:work`];
  if(job?.status!=='succeeded'||!job.result||hash(job.result.output)!==job.result.hash||job.inputs?.submissionHash!==submission.hash||!equal(job.inputs?.answers,submission.answers))fail('BASIC_PACKAGE_TASK_PENDING_OR_STALE');
  return {submissionHash:submission.hash,resultHash:job.result.hash,inputHash:hash(job.inputs)};
}
function checkedBytes(asset,items){
  const matches=items?.filter(item=>item.asset?.id===asset?.id)??[];
  if(!asset||matches.length!==1)fail('BASIC_PACKAGE_IMAGE_BYTES_REQUIRED');
  const item=matches[0];
  if(!Buffer.isBuffer(item.bytes)||!equal(item.asset,asset)||asset.bytes!==item.bytes.length||asset.sha256!==bytesHash(item.bytes))fail('BASIC_PACKAGE_IMAGE_INTEGRITY_FAILED');
  validatePhoto({name:asset.name,mime:asset.mime,data:item.bytes.toString('base64')});
  return item;
}
function checkedPhotoLineage(record,product,photo,asset,work){
  const gallery=record.productGalleries[product.id],slot=gallery.slots.find(item=>item.id===photo.slotId),candidate=slot.candidates.find(item=>item.id===photo.candidateId);
  if(candidate.kind==='regeneration'){
    // Completed server-owned requests are the trusted receipt for a native
    // regeneration. They must match this exact frozen product/unit/slot and
    // output. Selection never grants acceptance or initiates another AI job.
    const requests=gallery.slots.flatMap(item=>item.requests).filter(item=>item.id===candidate.requestId),request=requests[0];
    if(requests.length!==1||!uuid(candidate.requestId)||request.kind!=='regeneration'||request.status!=='completed'||request.slotId!==slot.id||request.candidateId!==candidate.id||request.assetId!==asset.id||request.sourceHash!==gallery.sourceHash||!equal(request.source,photoSourceForSlot(gallery,slot.id))||request.costEur!==null)fail('BASIC_PACKAGE_REGENERATION_RECEIPT_INVALID');
    if(!['same_style','specific_change'].includes(request.mode)||typeof request.change!=='string'||request.change.length>2000||request.mode==='specific_change'&&!request.change.trim())fail('BASIC_PACKAGE_REGENERATION_INSTRUCTIONS_INVALID');
    const evidence=validateSessionExecution(request.executionEvidence,gallery.sourceHash);
    if(evidence.tool!=='image_gen')fail('BASIC_PACKAGE_REGENERATION_EVIDENCE_INVALID');
    const initial=slot.candidates[0],initialAsset=record.generatedAssets[initial?.assetId];
    if(initial?.kind!=='initial'||!initialAsset||initialAsset.productId!==product.id||initialAsset.sourceHash!==gallery.sourceHash||(initialAsset.visualUnitId??null)!==(slot.visualUnitId??null))fail('BASIC_PACKAGE_REGENERATION_ORIGINAL_INVALID');
    const original=checkedPhotoLineage(record,product,{...photo,candidateId:initial.id,assetId:initial.assetId},initialAsset,work);
    return {kind:'regeneration',requestId:request.id,receiptHash:hash(request),executionId:evidence.executionId,inputHash:evidence.inputHash,outputSha256:asset.sha256,instructionsHash:hash({mode:request.mode,change:request.change,source:request.source}),
      original:{candidateId:initial.id,assetId:initial.assetId,sha256:initialAsset.sha256,lineage:original},attestation:'trusted_session_regeneration_operator',providerBillingVerified:false,fullRenderedPromptHash:null};
  }
  if(candidate.kind!=='initial')fail('BASIC_PACKAGE_INITIAL_SELECTION_REQUIRED');
  const receipts=Object.values(record.productPilotImports??{}).filter(item=>item.kind==='photos'&&item.productId===product.id&&item.slotId===photo.slotId&&item.delivered?.assetId===asset.id);
  if(receipts.length!==1)fail('BASIC_PACKAGE_PHOTO_RECEIPT_REQUIRED');
  const receipt=receipts[0],packet=record.productPilotPackets?.[receipt.packetId],provenance=asset.photoExecution;
  if(!packet||!provenance||!equal(receipt.photoExecution,provenance)||!equal(receipt.delivered,candidate)||!equal(receipt.executionEvidence,asset.executionEvidence))fail('BASIC_PACKAGE_PHOTO_PROVENANCE_INVALID');
  const evidence=validateSessionExecution(asset.executionEvidence,packet.payloadHash);
  if(evidence.tool!=='image_gen'||provenance.executionId!==evidence.executionId||provenance.outputSha256!==asset.sha256||provenance.planHash!==work.result.hash)fail('BASIC_PACKAGE_PHOTO_PROVENANCE_INVALID');
  // Native execution evidence is a trusted operator attestation, not a provider
  // billing receipt or a certification that every product detail is faithful.
  const result={slotId:photo.slotId,sha256:asset.sha256,name:asset.name,mime:asset.mime};
  if(receipt.resultHash!==hash({result,evidence}))fail('BASIC_PACKAGE_PHOTO_RECEIPT_CHANGED');
  const slotPlan=work.result.output.slots.find(item=>item.id===photo.slotId);
  if(!slotPlan||provenance.promptHash!==slotPlan.promptHash||!equal(provenance.sources,slotPlan.sources)||!uuid(evidence.executionId)||!/^[a-f\d]{64}$/.test(provenance.specHash??'')||!/^[a-f\d]{64}$/.test(provenance.executionPromptHash??''))fail('BASIC_PACKAGE_PHOTO_PROVENANCE_INVALID');
  // Recompute immutable packet/plan/reference relationships. An operator may
  // append prompt guidance; only its preserved digest is available in record.
  preparePhotoExecution(record,packet,{slotId:photo.slotId});
  return {receiptHash:hash(receipt),packetHash:packet.payloadHash,executionId:evidence.executionId,...structuredClone(provenance),attestation:'trusted_session_operator',providerBillingVerified:false};
}

// Generic catalogue assembly from completed frozen work. Payment ingress remains
// the existing restricted TEST adapter; this does not implement real payments.
export function prepareBasicStorePackage(record,{targetStore,binding,assets=[],sourceAssets=[],logo=null}={}){
  checkedBinding(record,targetStore,binding);
  if(!uuid(record?.id)||!serviceProductionEligible(record)||record.order.packageId!=='basic'||!/^\d+$/.test(record.servicePurchase.receipt.orderId))fail('BASIC_PACKAGE_VERIFIED_BASIC_REQUIRED');
  const products=record.tasks.catalog.draft.products??[];
  const {counts,pack}=basicCounts(record,products);
  checkedAssetBudget(record);
  const common=Object.fromEntries(['business','branding','photos',...SERVICE_OPERATION_TASK_IDS].map(id=>[id,checkedTask(record,id)]));
  if(!equal(record.tasks.returns.submission.answers.returnsPlan.productCharacteristics,['ordinary_goods']))fail('BASIC_PACKAGE_PHYSICAL_GOODS_SCOPE_REQUIRED');
  // Reuse the worker's validated receipt path on an isolated copy. A succeeded
  // job must still bind its provider receipt to this exact business submission.
  if(applyServiceBusinessResult(structuredClone(record),`${common.business.submissionHash}:work`).duplicate!==true)fail('BASIC_PACKAGE_BUSINESS_RECEIPT_REQUIRED');
  const branding=approvedBrandPresentation(record);if(!branding)fail('BASIC_PACKAGE_BRAND_APPROVAL_REQUIRED');
  const namespace=`molyvi-basic-${record.id}`,uploads=[],sourceEvidence=[],warnings=[];
  let logoFile=null;
  if(branding.logoMode==='existing'){
    const item=checkedBytes(record.brandAssets?.[branding.logoAssetId],logo?[logo]:[]);
    logoFile=`branding/logo.${extension(item.asset.mime)}`;uploads.push({fileName:logoFile,bytes:item.bytes,sha256:item.asset.sha256});
  }
  const skus=new Set(),allVariantIds=new Set(),allUnitIds=new Set();
  const catalog=products.map((product,index)=>{
    const normalized=normalizeCatalogFields(record,product,{complete:true});
    if(!equal(normalized.variants,product.variants)||!equal(normalized.visualUnits,product.visualUnits))fail('BASIC_PACKAGE_NONCANONICAL_CATALOG');
    for(const variant of product.variants){if(allVariantIds.has(variant.id))fail('BASIC_PACKAGE_DUPLICATE_VARIANT');allVariantIds.add(variant.id);}
    for(const unit of product.visualUnits){if(allUnitIds.has(unit.id))fail('BASIC_PACKAGE_DUPLICATE_UNIT');allUnitIds.add(unit.id);}
    const submission=record.productTasks?.[product.id]?.submission;
    if(!submission||!equal(submission.product,product))fail('BASIC_PACKAGE_PRODUCT_FROZEN_REQUIRED');
    const {hash:submissionHash,submittedAt,...source}=submission;
    if(hash({projectId:record.id,productId:product.id,schemaVersion:record.schemaVersion,...source})!==submissionHash)fail('BASIC_PACKAGE_PRODUCT_SOURCE_INVALID');
    const copy=finalizeProductTexts(record,[product])[0];if(!equal(copy,submission.productCopy))fail('BASIC_PACKAGE_PRODUCT_COPY_STALE');
    const work=record.jobs[`${submissionHash}:work`],plan=productPhotoPlan(record,product.id),gallery=record.productGalleries?.[product.id];
    if(work?.status!=='succeeded'||work.result?.hash!==hash(plan)||!equal(work.result.output,plan)||!equal(work.inputs?.answers?.product,product)||!equal(work.inputs?.productCopy,copy)||work.inputs?.submissionHash!==submissionHash||!equal(work.inputs?.photoEvidence,submission.photoEvidence)||!equal(gallery?.source,work.inputs)||gallery.sourceHash!==hash(work.inputs))fail('BASIC_PACKAGE_PRODUCT_JOB_STALE');
    const expectedDependencies=[{id:'branding',submissionHash:common.branding.submissionHash,resultHash:common.branding.resultHash},{id:'photos',submissionHash:common.photos.submissionHash}];
    if(!equal(work.inputs.dependencies,expectedDependencies)||!equal(work.inputs.branding,record.tasks.branding.submission.answers)||!equal(work.inputs.presentation,record.tasks.photos.submission.answers))fail('BASIC_PACKAGE_PRODUCT_JOB_STALE');
    for(const reference of submission.photoEvidence){const asset=record.assets[reference.id],item=checkedBytes(asset,sourceAssets);if(asset.productId!==product.id||reference.sha256!==item.asset.sha256)fail('BASIC_PACKAGE_SOURCE_REFERENCE_STALE');sourceEvidence.push({productId:product.id,assetId:asset.id,sha256:asset.sha256,bytes:asset.bytes});}
    const expectedSlots=plan.slots.map(slot=>slot.id);
    if(!Array.isArray(gallery.order)||gallery.order.length!==expectedSlots.length||new Set(gallery.order).size!==expectedSlots.length||!equal([...gallery.order].sort(),[...expectedSlots].sort())||gallery.slots.length!==expectedSlots.length||!equal(gallery.slots.map(slot=>slot.id).sort(),[...expectedSlots].sort()))fail('BASIC_PACKAGE_GALLERY_INCOMPLETE');
    for(const slot of gallery.slots){const expected=plan.slots.find(item=>item.id===slot.id);if(slot.visualUnitId!==expected.visualUnitId||slot.role!==expected.role)fail('BASIC_PACKAGE_GALLERY_UNIT_MISMATCH');}
    const selection=gallerySelectionSnapshot(record,product.id);
    if(selection.photos.length!==product.visualUnits.length*3||product.visualUnits.some(unit=>selection.photos.filter(photo=>photo.visualUnitId===unit.id).length!==3))fail('BASIC_PACKAGE_PRODUCT_IMAGES_INCOMPLETE');
    const photos=selection.photos.map((photo,photoIndex)=>{
      const item=checkedBytes(record.generatedAssets?.[photo.assetId],assets),asset=item.asset;
      const lineage=checkedPhotoLineage(record,product,photo,asset,work);
      const fileName=`images/${namespace}-${index+1}-${photoIndex+1}.${extension(asset.mime)}`;
      uploads.push({fileName,bytes:item.bytes,sha256:asset.sha256});
      const slot=gallery.slots.find(item=>item.id===photo.slotId);
      if(slot.requests.some(request=>!['completed','failed_no_output','cancelled'].includes(request.status)))warnings.push({code:'PHOTO_REQUEST_PENDING',productId:product.id,slotId:photo.slotId});
      return {...photo,position:photoIndex+1,fileName,mime:asset.mime,bytes:asset.bytes,alt:`${copy.title.text} — ${photo.role==='white'?'λευκό φόντο':`παρουσίαση ${photoIndex+1}`}`,lineage};
    });
    const optionNames=optionNamesFor(product.variants);
    const combinations=new Set();
    const variants=product.variants.map((variant,variantIndex)=>{
      const sourceSku=variant.sku||null;
      const sku=sourceSku??`MV-${record.id}-${index+1}-${variantIndex+1}`;
      if(skus.has(sku))fail('BASIC_PACKAGE_DUPLICATE_SKU');skus.add(sku);
      if(!Number.isSafeInteger(variant.priceMinor)||variant.priceMinor<0||!Number.isSafeInteger(variant.stock)||variant.stock<0||variant.stock>2147483647||variant.weightGrams!==null&&(!Number.isSafeInteger(variant.weightGrams)||variant.weightGrams<0||variant.weightGrams>2147483647))fail('BASIC_PACKAGE_VARIANT_NUMBER_INVALID');
      const optionValues=optionNames.map(name=>name==='Χρώμα'?variant.color:name==='Μέγεθος'?variant.size:'Default Title');
      if(optionValues.some(value=>!value?.trim()))fail('BASIC_PACKAGE_VARIANT_OPTION_REQUIRED');
      const combination=canonicalJson(optionValues.map(optionKey));
      if(combinations.has(combination))fail('BASIC_PACKAGE_DUPLICATE_OPTION_COMBINATION');combinations.add(combination);
      const unit=product.visualUnits.find(unit=>unit.variantIds.includes(variant.id)),image=photos.find(photo=>photo.visualUnitId===unit?.id);
      if(!unit||!image)fail('BASIC_PACKAGE_VARIANT_IMAGE_REQUIRED');
      if(variant.weightGrams===null)warnings.push({code:'VARIANT_WEIGHT_PENDING',productId:product.id,variantId:variant.id});
      return {...variant,sourceSku,sku,skuGenerated:sourceSku===null,price:money(variant.priceMinor),optionValues,trackInventory:true,continueSellingWhenOutOfStock:false,visualUnitId:unit.id,imagePosition:image.position};
    });
    const descriptionText=copy.description.text;
    return {productId:product.id,handle:`${namespace}-${product.id}`,title:copy.title.text,descriptionText,descriptionHtml:descriptionText.split('\n').map(line=>`<p>${escapeHtml(line)}</p>`).join('\n'),status:'DRAFT',publishedOnOnlineStore:false,currency:'EUR',vendor:branding.brandName,type:product.category,tags:[namespace],optionNames,visualUnits:structuredClone(product.visualUnits),variants,photos,source:{submissionHash,copyHash:hash(copy),workInputHash:hash(work.inputs),workResultHash:work.result.hash,galleryHash:selection.sourceHash,selectionHash:hash(selection)}};
  });
  const operations=Object.fromEntries(SERVICE_OPERATION_TASK_IDS.map(id=>{const artifact=readServiceOperation(record,id);if(!artifact)fail('BASIC_PACKAGE_OPERATION_PENDING');return[id,artifact];}));
  const content=previewStoreContent(record);
  if(!content.allInputsSubmitted||content.pending.length||content.documents.length!==7||ids.some(id=>content.documents.filter(document=>document.id===id).length!==1))fail('BASIC_PACKAGE_CONTENT_INCOMPLETE');
  const pages=ids.map(id=>{
    const doc=content.documents.find(item=>item.id===id),bodyHtml=doc.publicHtml;
    return {documentId:id,title:doc.title,handle:`${namespace}-${id}`,bodyHtml,bodyText:doc.publicText,bodySha256:bytesHash(bodyHtml),isPublished:false,status:'DRAFT'};
  });
  for(const claim of Object.values(record.photoClaims??{})){
    if(['awaiting_review','needs_specialist','escalated'].includes(claim.status))warnings.push({code:'PHOTO_CLAIM_PENDING',claimId:claim.id,productId:claim.productId,slotId:claim.slotId,status:claim.status});
    if(claim.status==='confirmed'&&catalog.some(product=>product.productId===claim.productId&&product.photos.some(photo=>photo.slotId===claim.slotId&&photo.candidateId===claim.candidateId)))warnings.push({code:'SELECTED_PHOTO_CLAIM_CONFIRMED',claimId:claim.id,productId:claim.productId,slotId:claim.slotId,candidateId:claim.candidateId});
  }
  const plan={schemaVersion:1,kind:'molyvi_basic_store_package',projectId:record.id,orderId:record.order.id,targetStore,namespace,status:'DRAFT',applicationAuthorized:false,publicationAuthorized:false,productionAdapter:false,overwriteExisting:false,deleteExisting:false,
    counts:{products:counts.catalogProducts,variants:counts.variants,visualUnits:counts.visualUnits,photos:counts.initialPhotoSlots,pages:7},binding:structuredClone(binding),offer:{packageId:pack.id,offerHash:pack.offerHash,catalogUnits:10,photoSlotsPerUnit:3,skuLimit:null,skuLimitStatus:'unresolved_not_unlimited'},branding:{...branding,logoFile},products:catalog,operations,pages,
    review:{customerAcceptance:'PENDING',contentReview:content.approval??null,legalCertification:false,publicationBlockers:content.publicationBlockers,paymentActivation:'owner_setup_pending',nativeShopifySettings:'PENDING',targetStoreVerification:'PENDING',paymentIngress:'existing_restricted_shopify_test_only',inventoryApplication:'PENDING_LOCATION_MAPPING',taxApplication:'PENDING_MERCHANT_REVIEW',catalogScope:'ordinary_physical_goods_EUR',imageFidelity:'not_certified',warnings},
    source:{recordHash:hash(record),paymentReceiptHash:hash(record.servicePurchase.receipt),businessReceiptHash:hash(record.jobs[`${common.business.submissionHash}:work`].providerResult),common,originalImages:sourceEvidence,contentBundleHash:content.bundleHash,contentTemplateVersion:content.templateVersion,operationHashes:Object.fromEntries(Object.entries(operations).map(([id,artifact])=>[id,hash(artifact)]))}};
  const prepared={plan:{...plan,planHash:hash(plan)},uploads};verifyBasicStorePackage(prepared);return prepared;
}

export async function prepareStoredBasicStorePackage(store,session,{targetStore,binding}={}){
  const record=await store.read(session.projectId,session.ownerId),assets=[],sourceAssets=[];
  if(record.id!==session.projectId||record.ownerId!==session.ownerId)fail('BASIC_PACKAGE_OWNER_MISMATCH');
  checkedBinding(record,targetStore,binding);checkedAssetBudget(record);
  for(const product of record.tasks.catalog.draft.products){
    for(const photo of gallerySelectionSnapshot(record,product.id).photos)assets.push(await readGeneratedPhoto(store,session,photo.assetId));
    for(const ref of record.productTasks[product.id].submission.photoEvidence)sourceAssets.push(await readPhoto(store,session,ref.id));
  }
  const branding=approvedBrandPresentation(record),logo=branding?.logoAssetId?await readLogo(store,session,branding.logoAssetId):null;
  const prepared=prepareBasicStorePackage(record,{targetStore,binding,assets,sourceAssets,logo});
  if(hash(await store.read(session.projectId,session.ownerId))!==prepared.plan.source.recordHash)fail('BASIC_PACKAGE_RECORD_CHANGED_DURING_READ');
  return prepared;
}

function checkPlan(plan){
  const {planHash,...unsigned}=plan;
  if(plan.kind!=='molyvi_basic_store_package'||planHash!==hash(unsigned)||!uuid(plan.projectId)||!validTarget(plan.targetStore)||plan.namespace!==`molyvi-basic-${plan.projectId}`||plan.status!=='DRAFT'||['applicationAuthorized','publicationAuthorized','productionAdapter','overwriteExisting','deleteExisting'].some(key=>plan[key]!==false))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
  const {bindingHash,...binding}=plan.binding??{};
  if(bindingHash!==hash(binding)||binding.kind!=='molyvi_basic_local_assembly_binding'||binding.projectId!==plan.projectId||binding.orderId!==plan.orderId||binding.targetStore!==plan.targetStore||binding.sourceRecordHash!==plan.source?.recordHash||binding.applicationAuthorized!==false||binding.publicationAuthorized!==false)fail('BASIC_PACKAGE_BINDING_INVALID');
  if(!Array.isArray(plan.products)||!plan.products.length||plan.products.length>10||!Array.isArray(plan.pages)||plan.pages.length!==7||plan.offer?.packageId!=='basic'||plan.offer.catalogUnits!==10||plan.offer.photoSlotsPerUnit!==3)fail('BASIC_PACKAGE_PLAN_CORRUPTED');
  const products=new Set(),variants=new Set(),units=new Set(),skus=new Set(),files=new Set();let photoCount=0;
  for(const product of plan.products){
    if(!uuid(product.productId)||products.has(product.productId)||product.handle!==`${plan.namespace}-${product.productId}`||product.status!=='DRAFT'||product.publishedOnOnlineStore!==false||product.currency!=='EUR'||!Array.isArray(product.variants)||!Array.isArray(product.visualUnits)||!Array.isArray(product.photos)||!Array.isArray(product.optionNames)||!equal(product.optionNames,optionNamesFor(product.variants)))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
    products.add(product.productId);
    if(typeof product.descriptionText!=='string'||product.descriptionHtml!==product.descriptionText.split('\n').map(line=>`<p>${escapeHtml(line)}</p>`).join('\n')||product.vendor!==plan.branding.brandName||!equal(product.tags,[plan.namespace]))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
    if(!product.variants.length||product.variants.length>CATALOG_TECHNICAL_LIMITS.variantsPerProduct||!product.visualUnits.length||product.photos.length!==product.visualUnits.length*3)fail('BASIC_PACKAGE_PLAN_CORRUPTED');
    for(const unit of product.visualUnits){if(!uuid(unit.id)||units.has(unit.id)||product.photos.filter(p=>p.visualUnitId===unit.id).length!==3||!unit.variantIds.length||new Set(unit.variantIds).size!==unit.variantIds.length||unit.variantIds.some(id=>!product.variants.some(v=>v.id===id&&v.visualUnitId===unit.id&&optionKey(v.color)===optionKey(unit.color))))fail('BASIC_PACKAGE_PLAN_CORRUPTED');units.add(unit.id);}
    const combinations=new Set();
    for(const variant of product.variants){
      const expectedOptions=product.optionNames.map(name=>name==='Χρώμα'?variant.color:name==='Μέγεθος'?variant.size:'Default Title');
      const image=product.photos.find(p=>p.visualUnitId===variant.visualUnitId);
      if(!uuid(variant.id)||variants.has(variant.id)||!variant.sku||skus.has(variant.sku)||!Number.isSafeInteger(variant.priceMinor)||variant.priceMinor<0||variant.price!==money(variant.priceMinor)||!Number.isSafeInteger(variant.stock)||variant.stock<0||variant.stock>2147483647||variant.weightGrams!==null&&(!Number.isSafeInteger(variant.weightGrams)||variant.weightGrams<0||variant.weightGrams>2147483647)||variant.trackInventory!==true||variant.continueSellingWhenOutOfStock!==false||expectedOptions.some(v=>!v?.trim())||!equal(variant.optionValues,expectedOptions)||!image||variant.imagePosition!==image.position||product.visualUnits.filter(u=>u.id===variant.visualUnitId&&u.variantIds.includes(variant.id)).length!==1)fail('BASIC_PACKAGE_PLAN_CORRUPTED');
      const key=canonicalJson(expectedOptions.map(optionKey));if(combinations.has(key))fail('BASIC_PACKAGE_PLAN_CORRUPTED');combinations.add(key);variants.add(variant.id);skus.add(variant.sku);
    }
    const slots=new Set();
    product.photos.forEach((photo,index)=>{if(photo.position!==index+1||!product.visualUnits.some(unit=>unit.id===photo.visualUnitId)||slots.has(photo.slotId)||!new RegExp(`^images/${plan.namespace}-[1-9][0-9]*-[1-9][0-9]*\\.(png|jpg|webp)$`).test(photo.fileName)||files.has(photo.fileName)||!/^[a-f\d]{64}$/.test(photo.sha256)||!Number.isSafeInteger(photo.bytes)||photo.bytes<=0)fail('BASIC_PACKAGE_PLAN_CORRUPTED');slots.add(photo.slotId);files.add(photo.fileName);photoCount++;});
  }
  if(units.size>10||variants.size>CATALOG_TECHNICAL_LIMITS.variantsPerProject||!equal(plan.counts,{products:products.size,variants:variants.size,visualUnits:units.size,photos:photoCount,pages:7}))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
  for(const id of ids){const matches=plan.pages.filter(p=>p.documentId===id);if(matches.length!==1||matches[0].status!=='DRAFT'||matches[0].isPublished!==false||matches[0].handle!==`${plan.namespace}-${id}`||bytesHash(matches[0].bodyHtml)!==matches[0].bodySha256)fail('BASIC_PACKAGE_PLAN_CORRUPTED');}
  if(!equal(Object.keys(plan.operations).sort(),[...SERVICE_OPERATION_TASK_IDS].sort()))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
  if(!equal(Object.fromEntries(Object.entries(plan.operations).map(([id,artifact])=>[id,hash(artifact)])),plan.source.operationHashes))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
  if(plan.branding.logoFile&&!/^branding\/logo\.(png|jpg|webp)$/.test(plan.branding.logoFile))fail('BASIC_PACKAGE_PLAN_CORRUPTED');
}
// Check data and bytes again at every export boundary. Hashes provide integrity,
// never proof of ownership or authorisation for Shopify writes.
export function verifyBasicStorePackage(prepared){
  const plan=prepared?.plan;if(!plan)fail('BASIC_PACKAGE_PLAN_CORRUPTED');checkPlan(plan);
  const expected=plan.products.flatMap(product=>product.photos.map(photo=>({fileName:photo.fileName,sha256:photo.sha256,bytes:photo.bytes}))).concat(plan.branding.logoFile?[{fileName:plan.branding.logoFile,sha256:plan.branding.logoSha256}]:[]);
  if(!Array.isArray(prepared.uploads)||prepared.uploads.length!==expected.length)fail('BASIC_PACKAGE_UPLOADS_CHANGED');
  for(const entry of expected){const matches=prepared.uploads.filter(item=>item.fileName===entry.fileName);if(matches.length!==1||!Buffer.isBuffer(matches[0].bytes)||bytesHash(matches[0].bytes)!==entry.sha256||matches[0].sha256!==entry.sha256||entry.bytes!==undefined&&matches[0].bytes.length!==entry.bytes)fail('BASIC_PACKAGE_UPLOADS_CHANGED');}
  if(prepared.uploads.reduce((sum,item)=>sum+item.bytes.length,0)>BASIC_ASSEMBLY_INPUT_BYTES_CAP)fail('BASIC_PACKAGE_INPUT_BYTES_LIMIT');
  return plan;
}
const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
export function basicStoreCatalogCsv(plan){
  checkPlan(plan);
  const columns=['Handle','Title','Body (HTML)','Vendor','Type','Tags','Published','Option1 Name','Option1 Value','Option2 Name','Option2 Value','Variant SKU','Variant Grams','Variant Inventory Tracker','Variant Inventory Qty','Variant Inventory Policy','Variant Fulfillment Service','Variant Price','Variant Requires Shipping','Variant Taxable','Status'];
  const rows=plan.products.flatMap(product=>product.variants.map((variant,index)=>[product.handle,index?'':product.title,index?'':product.descriptionHtml,index?'':product.vendor,index?'':product.type,index?'':product.tags.join(','),'FALSE',product.optionNames[0],variant.optionValues[0],product.optionNames[1]??'',variant.optionValues[1]??'',variant.sku,variant.weightGrams,'shopify',variant.stock,'deny','manual',variant.price,'TRUE','TRUE','draft'].map(safeCsvText)));
  return [columns,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
const inside=(root,child)=>{const relative=path.relative(root,child);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
async function safePrivateDestination(directory){
  if(typeof directory!=='string'||!directory||/[\x00-\x1f]/.test(directory))fail('BASIC_PACKAGE_PRIVATE_OUTPUT_REQUIRED');
  const roots=[path.join(WORKSPACE_ROOT,'briefs'),path.join(WORKSPACE_ROOT,'customer-materials')];
  const resolved=path.resolve(directory),root=roots.find(root=>inside(root,resolved));if(!root)fail('BASIC_PACKAGE_PRIVATE_OUTPUT_REQUIRED');
  const parent=path.dirname(resolved),relative=path.relative(root,parent);
  let current=root;
  for(const part of ['',...relative.split(path.sep).filter(Boolean)]){if(part)current=path.join(current,part);const info=await fs.lstat(current);if(info.isSymbolicLink()||!info.isDirectory())fail('BASIC_PACKAGE_UNSAFE_OUTPUT');}
  return resolved;
}
async function listFiles(directory,prefix=''){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=prefix?`${prefix}/${entry.name}`:entry.name;if(entry.isSymbolicLink())fail('BASIC_PACKAGE_UNSAFE_OUTPUT');
    if(entry.isDirectory())files.push(...await listFiles(path.join(directory,entry.name),file));else if(entry.isFile())files.push(file);else fail('BASIC_PACKAGE_UNSAFE_OUTPUT');
  }
  return files.sort();
}
// New private folder or byte-identical replay only. Incomplete/altered output
// remains untouched for inspection; a new folder is required to recover it.
export async function writeBasicStorePackage(prepared,{outputDirectory}={}){
  verifyBasicStorePackage(prepared);
  // Snapshot before the first await: caller mutation cannot change bytes or plan
  // while destination and filesystem checks are in progress.
  prepared={plan:structuredClone(prepared.plan),uploads:prepared.uploads.map(item=>({...item,bytes:Buffer.from(item.bytes)}))};
  const plan=prepared.plan,directory=await safePrivateDestination(outputDirectory),files=new Map();
  const add=(file,value)=>{if(files.has(file)||/[\\:\x00-\x1f]/.test(file)||file.split('/').some(part=>!part||part==='..'||part==='.')||path.isAbsolute(file))fail('BASIC_PACKAGE_FILE_CONFLICT');files.set(file,Buffer.isBuffer(value)?value:Buffer.from(value));};
  add('package-plan.json',json(plan));add('catalog.csv',basicStoreCatalogCsv(plan));add('branding.json',json(plan.branding));
  for(const [id,artifact]of Object.entries(plan.operations))add(`operations/${id}.json`,json(artifact));
  for(const page of plan.pages){add(`pages/${page.documentId}.html`,page.bodyHtml);add(`pages/${page.documentId}.txt`,page.bodyText);}
  const expectedUploads=plan.products.flatMap(product=>product.photos.map(photo=>({fileName:photo.fileName,sha256:photo.sha256}))).concat(plan.branding.logoFile?[{fileName:plan.branding.logoFile,sha256:plan.branding.logoSha256}]:[]);
  if(prepared.uploads.length!==expectedUploads.length)fail('BASIC_PACKAGE_UPLOADS_CHANGED');
  for(const expected of expectedUploads){const matches=prepared.uploads.filter(item=>item.fileName===expected.fileName);if(matches.length!==1||!Buffer.isBuffer(matches[0].bytes)||bytesHash(matches[0].bytes)!==expected.sha256||matches[0].sha256!==expected.sha256)fail('BASIC_PACKAGE_UPLOADS_CHANGED');add(expected.fileName,matches[0].bytes);}
  add('README.md',`# Molyvi — ιδιωτικό πακέτο Basic\n\n${preview}\n\nΠαραγγελία: ${plan.orderId}. Κατάσταση: DRAFT.\n\n${plan.counts.products} προϊόντα, ${plan.counts.variants} παραλλαγές, ${plan.counts.visualUnits} φωτογραφικές μονάδες, ${plan.counts.photos} εικόνες και 7 προσχέδια σελίδων. Οι τιμές/ποσότητες/SKU προέρχονται από τις οριστικές υποβολές. Αυτόματοι κωδικοί δημιουργούνται μόνο όπου λείπει SKU και δεν αλλάζουν την αρχική υποβολή.\n\nΤο CSV είναι για νέα Draft προϊόντα, χωρίς overwrite, με χωριστά ιδιωτικά αρχεία εικόνων. Οι φωτογραφίες παραλλαγών αντιστοιχίζονται στο package-plan.json και χρειάζονται ξεχωριστή εφαρμογή. Οι ποσότητες CSV απαιτούν επιβεβαίωση μοναδικής τοποθεσίας αποθέματος· πολλαπλές τοποθεσίες απαιτούν διαφορετικό adapter. Κενό βάρος παραμένει εκκρεμότητα, όχι επιβεβαιωμένο μηδενικό βάρος.\n\nΔεν έχει γίνει πελατειακή αποδοχή, νομική πιστοποίηση, ενεργοποίηση πληρωμών ή εξουσιοδότηση εφαρμογής/δημοσίευσης. Τα operations είναι σχέδια. Η διαδρομή παραλαβής πληρωμής παραμένει η περιορισμένη TEST σύνδεση. Το targetStore αποτελεί μόνο τοπικό δεσμευμένο προορισμό, όχι απόδειξη πρόσβασης.\n\nΤα αρχεία είναι ιδιωτικά. Τα ψηφιακά αποτυπώματα βρίσκονται στο manifest.json.\n`);
  const manifest={schemaVersion:1,kind:'molyvi_basic_store_package_manifest',projectId:plan.projectId,orderId:plan.orderId,planHash:plan.planHash,sourceRecordHash:plan.source.recordHash,files:[...files.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([file,bytes])=>({file,bytes:bytes.length,sha256:bytesHash(bytes)}))};
  add('manifest.json',json(manifest));
  let duplicate=false;
  try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;const info=await fs.lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())fail('BASIC_PACKAGE_UNSAFE_OUTPUT');duplicate=true;}
  if(duplicate){
    if(!equal(await listFiles(directory),[...files.keys()].sort()))fail('BASIC_PACKAGE_OUTPUT_EXISTS');
    for(const [file,bytes]of files)if(!(await fs.readFile(path.join(directory,...file.split('/')))).equals(bytes))fail('BASIC_PACKAGE_OUTPUT_EXISTS');
  }else for(const [file,bytes]of files){const destination=path.join(directory,...file.split('/'));await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,bytes,{flag:'wx',mode:0o600});}
  return {directory,duplicate,planHash:plan.planHash,manifestSha256:bytesHash(files.get('manifest.json')),fileCount:files.size,manifest};
}
