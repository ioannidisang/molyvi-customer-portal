import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {gallerySelectionSnapshot} from './product-gallery.mjs';
import {finalizeProductTexts} from './product-text.mjs';
import {readGeneratedPhoto,validatePhoto} from './product-assets.mjs';
import {escapeStoreContentHtml} from '../../molyvi-contract/lib/store-content.mjs';

export const SHOPIFY_PRODUCT_PILOT_STORE='molyvi-still-dev.myshopify.com';
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new IntakeError(code,422);};
const target=value=>{if(value!==SHOPIFY_PRODUCT_PILOT_STORE)fail('PRODUCT_PLAN_TARGET_NOT_AUTHORIZED');};
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const banner='Εσωτερική δοκιμή Molyvi — δεν πωλείται, χωρίς πραγματικές αγορές.';

// One-product smoke bridge, not a production Shopify adapter. Frozen inputs,
// final selected copy and selected image bytes must all agree. No store call.
export function prepareShopifyProductPlan(record,{targetStore,productId,selectedAssets}={}){
  target(targetStore);
  if(record?.order?.demo!==true||record.order.paymentMode!=='local_simulation')fail('PRODUCT_PLAN_FICTIONAL_RECORD_REQUIRED');
  if(!uuid(record.id)||!uuid(productId))fail('PRODUCT_PLAN_INVALID_ID');
  const submitted=record.productTasks?.[productId]?.submission,product=submitted?.product;
  if(!product||product.id!==productId||!submitted.hash)fail('PRODUCT_PLAN_FINAL_INPUT_REQUIRED');
  // This smoke deliberately excludes canonical multi-variant conversion.
  if(product.variants||product.visualUnits)fail('PRODUCT_PLAN_SINGLE_UNIT_ONLY');
  if(product.price!=='1.00'||product.stock!=='0')fail('PRODUCT_PLAN_TEST_PRICE_STOCK_REQUIRED');
  const finalCopy=finalizeProductTexts(record,[product])[0];
  if(!submitted.productCopy||hash(finalCopy)!==hash(submitted.productCopy))fail('PRODUCT_PLAN_FINAL_COPY_MISMATCH');
  for(const field of ['title','description'])if(typeof finalCopy[field]?.text!=='string'||!finalCopy[field].text.trim())fail('PRODUCT_PLAN_FINAL_COPY_REQUIRED');
  const selection=gallerySelectionSnapshot(record,productId);
  if(selection.photos.length!==3||!Array.isArray(selectedAssets)||selectedAssets.length!==3)fail('PRODUCT_PLAN_THREE_PHOTOS_REQUIRED');
  const photos=selection.photos.map((photo,index)=>{
    const matches=selectedAssets.filter(item=>item.asset?.id===photo.assetId);
    if(matches.length!==1)fail('PRODUCT_PLAN_PHOTO_BYTES_REQUIRED');
    const {asset,bytes}=matches[0],owned=record.generatedAssets[photo.assetId];
    if(!Buffer.isBuffer(bytes)||hash(asset)!==hash(owned)||asset.bytes!==bytes.length||asset.sha256!==bytesHash(bytes))fail('PRODUCT_PLAN_PHOTO_INTEGRITY_FAILED');
    const validated=validatePhoto({name:asset.name,mime:asset.mime,data:bytes.toString('base64')});
    if(validated.sha256!==photo.sha256)fail('PRODUCT_PLAN_PHOTO_INTEGRITY_FAILED');
    const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[asset.mime];
    return {...photo,position:index+1,mime:asset.mime,bytes:bytes.length,fileName:`molyvi-qa-${productId.slice(0,8)}-${index+1}-${photo.role}.${extension}`,alt:`${finalCopy.title.text} — ${photo.role==='white'?'σε λευκό φόντο':`παρουσίαση ${index+1}`} (δοκιμή Molyvi)`};
  });
  const fields={title:`Molyvi QA — ${finalCopy.title.text}`,handle:`molyvi-pilot-${productId}`,descriptionHtml:`<p><strong>${escapeStoreContentHtml(banner)}</strong></p>\n<p>${escapeStoreContentHtml(finalCopy.description.text).replaceAll('\n','<br>')}</p>`,descriptionText:`${banner}\n${finalCopy.description.text}`,status:'DRAFT',price:'1.00',currency:'EUR',sku:`MOLYVI-QA-${productId.slice(0,8).toUpperCase()}`,trackInventory:true,quantity:0,continueSellingWhenOutOfStock:false,photos};
  const productHash=hash(fields);
  const plan={schemaVersion:1,kind:'molyvi_one_product_dev_plan',targetStore,projectId:record.id,productId,
    applicationAuthorized:false,publicationAuthorized:false,productionAdapter:false,
    scope:{fictionalQa:true,oneProductOnly:true,replaceExistingProducts:false,deleteProducts:false,realPayments:false},
    source:{submissionHash:submitted.hash,copyHash:hash(finalCopy),galleryHash:selection.sourceHash,galleryRevision:selection.revision,selectionHash:hash(selection)},
    fields,productHash,idempotencyKey:hash({targetStore,projectId:record.id,productId,productHash})};
  return {...plan,planHash:hash(plan)};
}

export async function prepareStoredShopifyProductPlan(store,session,options){
  const record=await store.read(session.projectId,session.ownerId);
  const selection=gallerySelectionSnapshot(record,options.productId),selectedAssets=[];
  for(const photo of selection.photos)selectedAssets.push(await readGeneratedPhoto(store,session,photo.assetId));
  const plan=prepareShopifyProductPlan(record,{...options,selectedAssets});
  return {plan,uploads:plan.fields.photos.map(photo=>({fileName:photo.fileName,bytes:selectedAssets.find(item=>item.asset.id===photo.assetId).bytes,sha256:photo.sha256}))};
}

export function inspectShopifyProductConflicts(plan,{targetStore,existingProducts,inventoryComplete=false,priorReceipts=[]}={}){
  target(targetStore);target(plan?.targetStore);
  const {planHash,...unsigned}=plan;
  if(plan.kind!=='molyvi_one_product_dev_plan'||planHash!==hash(unsigned)||plan.productHash!==hash(plan.fields)||plan.applicationAuthorized!==false||plan.publicationAuthorized!==false||plan.fields.status!=='DRAFT'||plan.fields.quantity!==0||plan.fields.continueSellingWhenOutOfStock!==false)fail('PRODUCT_PLAN_INTEGRITY_MISMATCH');
  if(!Array.isArray(existingProducts)||!Array.isArray(priorReceipts))fail('PRODUCT_PLAN_INVALID_OBSERVATIONS');
  const matching=existingProducts.filter(p=>p.handle===plan.fields.handle||p.title===plan.fields.title||p.sku===plan.fields.sku);
  const prior=priorReceipts.filter(p=>p.productId===plan.productId||p.handle===plan.fields.handle),conflicts=[];
  if(!inventoryComplete)conflicts.push({code:'PRODUCT_PLAN_INVENTORY_INCOMPLETE'});
  if(matching.length>1||prior.length>1)conflicts.push({code:'PRODUCT_PLAN_DUPLICATE_OBSERVATION'});
  if(prior.length&&(!matching.length||prior[0].targetStore!==targetStore||prior[0].planHash!==planHash||prior[0].shopifyProductId!==matching[0]?.id))conflicts.push({code:'PRODUCT_PLAN_PRIOR_RECEIPT_CONFLICT'});
  if(matching.length&&!prior.length)conflicts.push({code:'PRODUCT_PLAN_EXISTING_PRODUCT_REQUIRES_REVIEW'});
  return {planHash,targetStore,applicationAuthorized:false,readyForSeparatelyAuthorizedApplication:conflicts.length===0,conflicts,
    actions:conflicts.length?[]:[matching.length?{kind:'verify_existing',shopifyProductId:matching[0].id}:{kind:'create_draft',handle:plan.fields.handle}]};
}
