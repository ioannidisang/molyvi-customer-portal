import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {validateSessionExecution} from './session-execution.mjs';
import {packageForOrder} from './service-offer.mjs';
import {hasVisualUnits,visualUnitsFor,unitFor} from './catalog-model.mjs';
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=(code,status=409)=>{throw new IntakeError(code,status);};
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
export const PHOTO_REGENERATIONS=3;
const regenerationLimit=project=>packageForOrder(project.order).entitlements.additionalPhotoRegenerationsPerSlot;
// Legacy needs_review may hide an asset/provenance failure. It cannot be safely
// released merely because routine AI fidelity review is no longer required.
const pausedStatuses=['paused_unknown','needs_review','paused_asset','paused_budget'];
function source(project,productId){
  if(project.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
  const submitted=project.productTasks?.[productId]?.submission;
  if(!submitted)fail('PRODUCT_NOT_SUBMITTED');
  const work=project.jobs[`${submitted.hash}:work`];
  if(work?.status!=='succeeded'||!work.inputs)fail('GALLERY_NOT_READY');
  return {inputs:work.inputs,hash:hash(work.inputs)};
}
function galleryFor(project,productId,galleryHash){
  const current=source(project,productId),gallery=project.productGalleries?.[productId];
  if(!gallery)fail('GALLERY_NOT_READY');
  if(gallery.sourceHash!==current.hash||galleryHash!==gallery.sourceHash)fail('GALLERY_STALE');
  return gallery;
}
function slotFor(gallery,slotId){return gallery.slots.find(slot=>slot.id===slotId)??fail('PHOTO_SLOT_NOT_FOUND',404);}
function revision(gallery,value){if(!Number.isInteger(value)||gallery.revision!==value)fail('GALLERY_CONFLICT');}
function assetFor(project,productId,sourceHash,assetId,slot){
  const asset=project.generatedAssets?.[assetId];
  if(!asset||asset.productId!==productId||asset.sourceHash!==sourceHash||(asset.visualUnitId??null)!==(slot?.visualUnitId??null))fail('GENERATED_PHOTO_NOT_OWNED',403);
  return asset;
}
// A unit-specific projection is recomputed from the immutable full input. Other
// colors must never be supplied as identity references to a generation or claim.
export function photoSourceForSlot(gallery,slotId){
  const slot=slotFor(gallery,slotId),input=structuredClone(gallery.source),product=input.answers?.product;
  if(!product)fail('PHOTO_SOURCE_MISSING');
  if(!hasVisualUnits(product)){if(slot.visualUnitId)fail('PHOTO_SOURCE_MISSING');return input;}
  const unit=unitFor(product,slot.visualUnitId);
  const refs=input.photoEvidence?.filter(ref=>unit.sourceAssetIds.includes(ref.id));
  if(!refs||refs.length!==unit.sourceAssetIds.length||!refs.length)fail('PHOTO_SOURCE_MISSING');
  input.answers.product={...product,photos:[...unit.sourceAssetIds],variants:product.variants.filter(variant=>unit.variantIds.includes(variant.id)),visualUnits:[structuredClone(unit)]};
  input.photoEvidence=refs;
  if(input.photoReviews)input.photoReviews=input.photoReviews.filter(review=>review.visualUnitId===unit.id);
  input.visualUnitId=unit.id;
  return input;
}
function replacementEntitlementFor(project,productId,slotId,sourceHash,entitlementId){
  const entitlement=project.photoReplacementEntitlements?.[entitlementId];
  if(!entitlement||entitlement.productId!==productId||entitlement.slotId!==slotId||entitlement.sourceHash!==sourceHash)fail('PHOTO_REPLACEMENT_NOT_OWNED',403);
  return entitlement;
}
const regularRequests=slot=>slot.requests.filter(request=>request.kind!=='replacement'&&request.status!=='failed_no_output');
function regenerationInput(requestId,mode,change){
  if(!uuid(requestId)||!['same_style','specific_change'].includes(mode)||typeof change!=='string'||change.length>2000)fail('INVALID_REGENERATION',400);
  change=change.trim();if(mode==='specific_change'&&!change)fail('PHOTO_CHANGE_REQUIRED',422);
  return change;
}
function requireGenerationAvailable(project,slot){
  if(project.budget.unknown||project.budget.halted||slot.requests.some(request=>pausedStatuses.includes(request.status)))fail('PHOTO_REGENERATION_PAUSED');
}
// Trusted worker boundary only. There is no public route to create galleries or deliver candidates.
export function initializeGallery(project,{productId}){
  const current=source(project,productId);project.productGalleries??={};
  const existing=project.productGalleries[productId];
  if(existing){if(existing.sourceHash!==current.hash)fail('GALLERY_STALE');return existing;}
  const count=packageForOrder(project.order).entitlements.photoSlotsPerUnit;
  const product=current.inputs.answers?.product;
  if(!product)fail('PHOTO_SOURCE_MISSING');
  const slots=visualUnitsFor(product).flatMap(unit=>Array.from({length:count},(_,i)=>({id:unit.id?`${unit.id}:photo-${i+1}`:`photo-${i+1}`,...(unit.id?{visualUnitId:unit.id,color:unit.color,sourceAssetIds:[...unit.sourceAssetIds]}:{}),role:i===0&&current.inputs.presentation.mix==='white_lifestyle'?'white':'lifestyle',candidates:[],requests:[],selected:null})));
  const gallery={sourceHash:current.hash,revision:0,order:slots.map(slot=>slot.id),slots,source:structuredClone(current.inputs)};
  project.productGalleries[productId]=gallery;return gallery;
}
export function recordInitialPhoto(project,{productId,slotId,assetId,galleryHash}){
  const gallery=galleryFor(project,productId,galleryHash),slot=slotFor(gallery,slotId);
  // The trusted worker still supplies an owned, immutable asset. Product-fidelity
  // review is claim-triggered and is not a prerequisite for a customer candidate.
  assetFor(project,productId,galleryHash,assetId,slot);
  if(slot.candidates.length){if(slot.candidates[0].assetId===assetId)return {duplicate:true};fail('INITIAL_PHOTO_EXISTS');}
  const candidate={id:crypto.randomUUID(),assetId,kind:'initial',createdAt:new Date().toISOString()};
  slot.candidates.push(candidate);slot.selected=candidate.id;gallery.revision++;return candidate;
}
export function selectPhotoCandidate(project,{productId,slotId,candidateId,galleryHash,revision:version}){
  const gallery=galleryFor(project,productId,galleryHash),slot=slotFor(gallery,slotId);
  if(!slot.candidates.some(candidate=>candidate.id===candidateId))fail('PHOTO_CANDIDATE_NOT_FOUND',404);
  revision(gallery,version);slot.selected=candidateId;gallery.revision++;return {selected:candidateId};
}
export function setPhotoLayout(project,{productId,order,galleryHash,revision:version}){
  const gallery=galleryFor(project,productId,galleryHash);revision(gallery,version);
  if(!Array.isArray(order)||order.length!==gallery.slots.length||new Set(order).size!==order.length||order.some(id=>!gallery.slots.some(slot=>slot.id===id)))fail('INVALID_PHOTO_ORDER',400);
  gallery.order=[...order];gallery.revision++;return {order:[...order],primary:order[0]};
}
export function requestPhotoRegeneration(project,{productId,slotId,galleryHash,requestId,mode,change=''}){
  const gallery=galleryFor(project,productId,galleryHash),slot=slotFor(gallery,slotId);
  change=regenerationInput(requestId,mode,change);
  const old=gallery.slots.flatMap(item=>item.requests).find(request=>request.id===requestId);
  if(old){if(old.kind==='replacement'||old.slotId!==slotId||old.mode!==mode||old.change!==change)fail('REGENERATION_REQUEST_CONFLICT');return {id:old.id,duplicate:true};}
  if(!slot.candidates.length)fail('GALLERY_NOT_READY');
  requireGenerationAvailable(project,slot);
  const pending=slot.requests.find(request=>request.status==='awaiting_provider');if(pending)return {id:pending.id,duplicate:true};
  if(regularRequests(slot).length>=regenerationLimit(project))fail('PHOTO_REGENERATION_LIMIT');
  // Only reserve an allowance here. Provider money/attempts must be reconciled by the future adapter.
  const request={id:requestId,kind:'regeneration',slotId,mode,change,status:'awaiting_provider',sourceHash:gallery.sourceHash,source:photoSourceForSlot(gallery,slotId),createdAt:new Date().toISOString(),costEur:null};
  slot.requests.push(request);gallery.revision++;return {id:request.id,duplicate:false};
}
export function requestPhotoReplacement(project,{productId,slotId,galleryHash,requestId,entitlementId,mode,change=''}){
  const gallery=galleryFor(project,productId,galleryHash),slot=slotFor(gallery,slotId);
  change=regenerationInput(requestId,mode,change);
  const entitlement=replacementEntitlementFor(project,productId,slotId,galleryHash,entitlementId);
  const old=gallery.slots.flatMap(item=>item.requests).find(request=>request.id===requestId);
  if(old){if(old.kind!=='replacement'||old.entitlementId!==entitlementId||old.slotId!==slotId||old.mode!==mode||old.change!==change||entitlement.requestId!==requestId)fail('REGENERATION_REQUEST_CONFLICT');return {id:old.id,duplicate:true};}
  if(entitlement.status!=='available')fail('PHOTO_REPLACEMENT_UNAVAILABLE');
  if(!slot.candidates.length)fail('GALLERY_NOT_READY');
  requireGenerationAvailable(project,slot);
  if(slot.requests.some(request=>request.status==='awaiting_provider'))fail('PHOTO_REGENERATION_PENDING');
  const request={id:requestId,kind:'replacement',entitlementId,slotId,mode,change,status:'awaiting_provider',sourceHash:gallery.sourceHash,source:photoSourceForSlot(gallery,slotId),createdAt:new Date().toISOString(),costEur:null};
  entitlement.status='reserved';entitlement.requestId=requestId;
  slot.requests.push(request);gallery.revision++;return {id:request.id,duplicate:false};
}
export function recordRegeneratedPhoto(project,{productId,slotId,galleryHash,requestId,assetId,costEur,executionEvidence}){
  const gallery=galleryFor(project,productId,galleryHash),slot=slotFor(gallery,slotId),request=slot.requests.find(item=>item.id===requestId);
  if(!request)fail('REGENERATION_REQUEST_NOT_FOUND',404);
  if(request.status==='completed'){if(request.assetId===assetId&&request.costEur===costEur)return {duplicate:true};fail('REGENERATION_RESULT_CONFLICT');}
  if(request.status!=='awaiting_provider')fail('PHOTO_REGENERATION_PAUSED');
  const entitlement=request.kind==='replacement'?replacementEntitlementFor(project,productId,slotId,galleryHash,request.entitlementId):null;
  if(entitlement&&(entitlement.status!=='reserved'||entitlement.requestId!==requestId))fail('PHOTO_REPLACEMENT_UNAVAILABLE');
  const sessionEvidence=executionEvidence===undefined?null:validateSessionExecution(executionEvidence);
  if(sessionEvidence&&costEur!==null)fail('SESSION_ALLOCATION_MUST_REMAIN_UNKNOWN',422);
  if(!sessionEvidence&&(typeof costEur!=='number'||!Number.isFinite(costEur)||costEur<0)){request.status='paused_unknown';project.budget.unknown=true;gallery.revision++;return {status:request.status};}
  request.costEur=costEur;if(sessionEvidence)request.executionEvidence=sessionEvidence;else project.budget.spent+=Math.round(costEur*1e6);
  if(project.budget.spent+project.budget.reserved>project.budget.limit){project.budget.halted=true;request.status='paused_budget';gallery.revision++;return {status:request.status};}
  const asset=project.generatedAssets?.[assetId];
  if(!asset||asset.productId!==productId||asset.sourceHash!==galleryHash||(asset.visualUnitId??null)!==(slot.visualUnitId??null)){request.status='paused_asset';gallery.revision++;return {status:request.status};}
  const candidate={id:crypto.randomUUID(),assetId,kind:request.kind==='replacement'?'replacement':'regeneration',requestId,createdAt:new Date().toISOString()};
  request.status='completed';request.assetId=assetId;request.candidateId=candidate.id;slot.candidates.push(candidate);gallery.revision++;
  if(entitlement){entitlement.status='consumed';entitlement.consumedAt=candidate.createdAt;}
  // A new image never silently replaces the customer's chosen candidate.
  return {status:'completed',candidateId:candidate.id};
}
export function publicGalleries(project){
  return Object.fromEntries(Object.entries(project.productGalleries??{}).map(([productId,gallery])=>[productId,{
    sourceHash:gallery.sourceHash,revision:gallery.revision,order:[...gallery.order],primary:gallery.order[0],
    slots:gallery.slots.map(slot=>({id:slot.id,role:slot.role,selected:slot.selected,...(slot.visualUnitId?{visualUnitId:slot.visualUnitId,color:slot.color}:{}),
      remaining:Math.max(0,regenerationLimit(project)-regularRequests(slot).length),
      paused:project.budget.unknown||project.budget.halted||slot.requests.some(request=>pausedStatuses.includes(request.status)),
      replacementEntitlements:Object.values(project.photoReplacementEntitlements??{}).filter(entitlement=>entitlement.productId===productId&&entitlement.slotId===slot.id&&entitlement.sourceHash===gallery.sourceHash).map(({id,status})=>({id,status})),
      requests:slot.requests.map(({id,kind,mode,change,status})=>({id,kind:kind??'regeneration',mode,change,status})),
      candidates:slot.candidates.map(({id,assetId,kind,requestId,createdAt})=>({id,assetId,kind,...(requestId?{requestId}:{}),createdAt,url:`/api/generated-photo/${assetId}`}))}))
  }]));
}
export function gallerySelectionSnapshot(project,productId){
  const current=source(project,productId),gallery=galleryFor(project,productId,current.hash);
  const photos=gallery.order.map(slotId=>{const slot=slotFor(gallery,slotId),candidate=slot.candidates.find(item=>item.id===slot.selected);if(!candidate)fail('PHOTO_SELECTION_INCOMPLETE');const asset=assetFor(project,productId,current.hash,candidate.assetId,slot);return {slotId,candidateId:candidate.id,assetId:asset.id,sha256:asset.sha256,role:slot.role,...(slot.visualUnitId?{visualUnitId:slot.visualUnitId}: {})};});
  return {sourceHash:gallery.sourceHash,revision:gallery.revision,primarySlotId:gallery.order[0],photos};
}
