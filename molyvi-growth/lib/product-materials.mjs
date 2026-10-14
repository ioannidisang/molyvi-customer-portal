import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {packageForOrder} from './service-offer.mjs';
import {CATALOG_TECHNICAL_LIMITS,hasVisualUnits,normalizeCatalogFields,visualUnitsFor,unitFor,catalogCounts,sourceAssetIdsFor} from './catalog-model.mjs';

const fail=(code,status=422)=>{throw new IntakeError(code,status,{field:'products'});};
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const digest=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
export const MATERIAL_LIMITS={maxPhotos:10,maxFileBytes:10*1024*1024,maxProjectBytes:100*1024*1024};
export function productLimit(project){return packageForOrder(project.order).entitlements.products;}

export function normalizeProducts(project,products=[],complete=false){
  if(!Array.isArray(products))fail('INVALID_PRODUCT',400);
  if(products.length>CATALOG_TECHNICAL_LIMITS.catalogProducts)fail('CATALOG_TECHNICAL_LIMIT',413);
  if(complete&&!products.length)fail('INPUT_INCOMPLETE');
  const seen=new Set();
  const normalized=products.map(product=>{
    if(!product||typeof product!=='object'||Array.isArray(product)||Object.keys(product).some(key=>!['id','title','description','price','stock','photos','improveTitle','improveDescription','category','facts','variants','visualUnits'].includes(key)))fail('INVALID_PRODUCT',400);
    if(!uuid(product.id)||seen.has(product.id))fail('INVALID_PRODUCT_ID',400);seen.add(product.id);
    const clean={id:product.id};
    for(const field of ['title','description','price','stock']){
      const value=product[field]??'';
      if(typeof value!=='string'||value.length>(field==='description'?12000:field==='title'?400:30))fail('INVALID_FIELD',400);
      clean[field]=value.trim();if(complete&&!clean[field]&&(!hasVisualUnits(product)||!['price','stock'].includes(field)))fail('INPUT_INCOMPLETE');
      if(value&&['price','stock'].includes(field)&&(!/^\d+(?:\.\d{1,2})?$/.test(value)||!Number.isFinite(Number(value))||(field==='stock'&&!Number.isInteger(Number(value)))))fail('INVALID_NUMBER');
    }
    for(const field of ['improveTitle','improveDescription']){if(product[field]!==undefined&&typeof product[field]!=='boolean')fail('INVALID_PRODUCT',400);clean[field]=product[field]===true;}
    const photos=product.photos??[];
    if(!Array.isArray(photos)||photos.length>(hasVisualUnits(product)?CATALOG_TECHNICAL_LIMITS.photosPerProduct:MATERIAL_LIMITS.maxPhotos)||new Set(photos).size!==photos.length)fail('INVALID_PHOTOS');
    clean.photos=photos.map(id=>{if(!uuid(id)||project.assets?.[id]?.productId!==product.id)fail('PHOTO_NOT_OWNED',403);return id;});
    Object.assign(clean,normalizeCatalogFields(project,product,{complete}));
    if(hasVisualUnits(clean))clean.photos=[...new Set([...clean.photos,...sourceAssetIdsFor(clean)])];
    if(clean.photos.length>CATALOG_TECHNICAL_LIMITS.photosPerProduct)fail('INVALID_PHOTOS');
    if(complete&&!hasVisualUnits(clean)&&!clean.photos.length)fail('INPUT_INCOMPLETE');
    return clean;
  });
  const counts=catalogCounts(normalized);
  if(counts.visualUnits>productLimit(project))fail('PRODUCT_LIMIT');
  if(counts.variants>CATALOG_TECHNICAL_LIMITS.variantsPerProject)fail('CATALOG_TECHNICAL_LIMIT',413);
  const allVariants=normalized.flatMap(product=>product.variants??[]),allUnits=normalized.flatMap(product=>product.visualUnits??[]);
  if(new Set(allVariants.map(item=>item.id)).size!==allVariants.length||new Set(allUnits.map(item=>item.id)).size!==allUnits.length)fail('DUPLICATE_CATALOG_ID',400);
  const skus=allVariants.map(item=>item.sku).filter(value=>value!==null&&value!=='');
  if(new Set(skus).size!==skus.length)fail('DUPLICATE_SKU');
  return normalized;
}

export function productLocked(project,id){return Boolean(project.tasks.catalog.submission||project.productTasks?.[id]?.submission);}
export function productFor(project,id){
  if(project.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
  const product=project.productTasks?.[id]?.submission?.product??(project.tasks.catalog.submission?.answers??project.tasks.catalog.draft).products?.find(item=>item.id===id);
  if(!product)fail('PRODUCT_NOT_FOUND',404);return product;
}
export const reviewKey=(productId,visualUnitId)=>visualUnitId?`${productId}:${visualUnitId}`:productId;
export function photoSetHash(project,product,visualUnitId){
  const unit=unitFor(product,visualUnitId),assets=unit.sourceAssetIds.map(id=>({sha256:project.assets[id].sha256})).sort((a,b)=>a.sha256.localeCompare(b.sha256));
  return digest(hasVisualUnits(product)?{visualUnitId:unit.id,color:unit.color,representationNote:unit.representationNote,assets}:assets);
}
export function requestPhotoReview(project,{productId,visualUnitId}){
  if(productLocked(project,productId))fail('PRODUCT_LOCKED',409);
  const product=productFor(project,productId);
  const unit=unitFor(product,visualUnitId),key=reviewKey(productId,visualUnitId);
  if(!unit.sourceAssetIds.length)fail('INPUT_INCOMPLETE');
  const fingerprint=photoSetHash(project,product,visualUnitId),old=project.photoReviews?.[key];
  if(old?.fingerprint===fingerprint)return structuredClone(old); // No duplicate analysis or free loop of unchanged materials.
  project.photoReviews??={};
  const round=old?Math.min(2,old.round+(old.status==='replacement_required'?1:0)):1;
  if(old){project.photoReviewHistory??=[];project.photoReviewHistory.push(structuredClone(old));}
  const review={id:crypto.randomUUID(),productId,...(unit.id?{visualUnitId:unit.id}:{}),fingerprint,assetIds:[...unit.sourceAssetIds],requestedAt:new Date().toISOString(),round,status:'awaiting_review',reason:null,confirmed:false};
  project.photoReviews[key]=review;
  return structuredClone(review);
}

// Trusted adapter boundary only. There is deliberately no HTTP route for supplying an AI verdict.
export function recordPhotoReview(project,{productId,visualUnitId,reviewId,fingerprint,verdict,reason}){
  const product=productFor(project,productId),review=project.photoReviews?.[reviewKey(productId,visualUnitId)];
  if(!review||review.id!==reviewId||review.fingerprint!==fingerprint||fingerprint!==photoSetHash(project,product,visualUnitId)||review.status!=='awaiting_review')fail('PHOTO_REVIEW_STALE',409);
  const reasons={match:['consistent'],mismatch:['different_object','different_color','unclear_details'],unreadable:['unreadable']};
  if(!reasons[verdict]?.includes(reason))fail('INVALID_REVIEW',400);
  review.reason=reason;
  review.reviewedAt=new Date().toISOString();
  review.status=verdict==='match'?'matched':verdict==='unreadable'?'replacement_required':review.round===1?'replacement_required':'awaiting_confirmation';
  return structuredClone(review);
}
export function confirmPhotoIdentity(project,{productId,visualUnitId,reviewId,fingerprint,acknowledged}){
  if(productLocked(project,productId))fail('PRODUCT_LOCKED',409);
  const product=productFor(project,productId),review=project.photoReviews?.[reviewKey(productId,visualUnitId)];
  if(acknowledged!==true)fail('PHOTO_CONFIRMATION_REQUIRED');
  if(!review||review.id!==reviewId||review.fingerprint!==fingerprint||fingerprint!==photoSetHash(project,product,visualUnitId))fail('PHOTO_REVIEW_STALE',409);
  if(review.status==='confirmed')return structuredClone(review);
  if(review.status!=='awaiting_confirmation')fail('PHOTO_CONFIRMATION_NOT_READY',409);
  review.status='confirmed';review.confirmed=true;review.confirmedAt=new Date().toISOString();return structuredClone(review);
}
export function photosReady(project,product){
  const units=visualUnitsFor(product);
  return Boolean(units.length&&units.every(unit=>{const review=project.photoReviews?.[reviewKey(product.id,unit.id)];return unit.sourceAssetIds.length&&review?.fingerprint===photoSetHash(project,product,unit.id)&&['matched','confirmed'].includes(review.status);}));
}
export function requirePhotoReviews(project,products){if(products.some(product=>!photosReady(project,product)))fail('PHOTO_REVIEW_REQUIRED');}
export function photoReviewSnapshot(project,product){
  requirePhotoReviews(project,[product]);
  const photoEvidence=sourceAssetIdsFor(product).map(id=>({id,sha256:project.assets[id].sha256}));
  if(!hasVisualUnits(product)){const review=project.photoReviews[product.id];return {photoEvidence,photoReview:{id:review.id,fingerprint:review.fingerprint,status:review.status}};}
  return {photoEvidence,photoReviews:product.visualUnits.map(unit=>{const review=project.photoReviews[reviewKey(product.id,unit.id)];return {visualUnitId:unit.id,id:review.id,fingerprint:review.fingerprint,status:review.status,assetIds:[...review.assetIds]};})};
}

export function publicMaterials(project){
  const products=(project.tasks.catalog.submission?.answers??project.tasks.catalog.draft).products??[];
  return {productLimit:productLimit(project),photosPerUnit:packageForOrder(project.order).entitlements.photoSlotsPerUnit,limits:MATERIAL_LIMITS,technicalLimits:CATALOG_TECHNICAL_LIMITS,counts:catalogCounts(products,packageForOrder(project.order).entitlements.photoSlotsPerUnit),
    assets:Object.values(project.assets??{}).map(({id,productId,name,mime,bytes})=>({id,productId,name,mime,bytes,url:`/api/photo/${id}`})),
    reviews:Object.fromEntries(products.map(product=>{
      const review=project.photoReviews?.[product.id];
      return [product.id,!hasVisualUnits(product)&&review?.fingerprint===photoSetHash(project,product)?structuredClone(review):null];
    })),unitReviews:Object.fromEntries(products.filter(hasVisualUnits).map(product=>[product.id,Object.fromEntries(product.visualUnits.map(unit=>{const review=project.photoReviews?.[reviewKey(product.id,unit.id)];return [unit.id,review?.fingerprint===photoSetHash(project,product,unit.id)?structuredClone(review):null];}))]))};
}
