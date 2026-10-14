import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {catalogCounts,normalizeCatalogFields} from './catalog-model.mjs';
import {finalizeProductTexts} from './product-text.mjs';
import {gallerySelectionSnapshot} from './product-gallery.mjs';
import {validatePhoto,readGeneratedPhoto} from './product-assets.mjs';
import {escapeStoreContentHtml} from '../../molyvi-contract/lib/store-content.mjs';
import {SHOPIFY_PRODUCT_PILOT_STORE} from './shopify-product-plan.mjs';
const hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const bytesHash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new IntakeError(code,422);};
const checkTarget=value=>{if(value!==SHOPIFY_PRODUCT_PILOT_STORE)fail('CATALOG_TARGET_NOT_AUTHORIZED');};
// Narrow private dev QA bridge. These quantities/prices are fictional test values.
// No Shopify call, production authorization or publication occurs here.
export function prepareShopifyCatalogPlan(record,{targetStore,assets}={}){
 checkTarget(targetStore);
 if(record?.order?.demo!==true||record.order.status!=='verified_paid'||record.order.paymentMode!=='local_simulation'||record.order.packageId!=='basic')fail('CATALOG_QA_RECORD_REQUIRED');
 const products=record.tasks?.catalog?.draft?.products??[];
 if(canonicalJson(catalogCounts(products))!==canonicalJson({catalogProducts:10,variants:14,visualUnits:10,initialPhotoSlots:30}))fail('CATALOG_EXACT_BASIC_REQUIRED');
 const skuSet=new Set();
 const plans=products.map(product=>{
  normalizeCatalogFields(record,product,{complete:true});
  const submission=record.productTasks?.[product.id]?.submission;if(!submission?.hash||hash(submission.product)!==hash(product))fail('CATALOG_FROZEN_INPUT_REQUIRED');
  const copy=finalizeProductTexts(record,[product])[0];if(hash(copy)!==hash(submission.productCopy))fail('CATALOG_FINAL_COPY_MISMATCH');
  if(product.visualUnits.length!==1)fail('CATALOG_ONE_UNIT_PER_PRODUCT_REQUIRED');
  const gallery=gallerySelectionSnapshot(record,product.id);if(gallery.photos.length!==3)fail('CATALOG_THREE_IMAGES_REQUIRED');
  const photos=gallery.photos.map((photo,index)=>{
   const candidates=assets?.filter(a=>a.asset.id===photo.assetId)??[];if(candidates.length!==1)fail('CATALOG_IMAGE_BYTES_REQUIRED');
   const {asset,bytes}=candidates[0],owned=record.generatedAssets?.[asset.id];
   if(!Buffer.isBuffer(bytes)||hash(asset)!==hash(owned)||asset.productId!==product.id||bytes.length!==asset.bytes||bytesHash(bytes)!==photo.sha256)fail('CATALOG_IMAGE_INTEGRITY_FAILED');
   const verified=validatePhoto({name:asset.name,mime:asset.mime,data:bytes.toString('base64')});if(verified.sha256!==photo.sha256)fail('CATALOG_IMAGE_INTEGRITY_FAILED');
   const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[asset.mime];
   return {...photo,position:index+1,fileName:`molyvi-basic-${product.id.slice(0,8)}-${index+1}.${ext}`,mime:asset.mime,bytes:bytes.length,alt:`${copy.title.text} — ${index?'lifestyle '+index:'λευκό φόντο'} (Molyvi Basic QA)`};
  });
  const variants=product.variants.map(v=>{
   if(!v.sku||skuSet.has(v.sku)||![100,200].includes(v.priceMinor)||!Number.isInteger(v.stock)||v.stock<0||v.stock>5)fail('CATALOG_QA_VARIANT_INVALID');skuSet.add(v.sku);
   return {...v,price:(v.priceMinor/100).toFixed(2),trackInventory:true,continueSellingWhenOutOfStock:false,visualUnitId:product.visualUnits[0].id,imagePosition:1};
  });
  const descriptionText=`Εσωτερική δοκιμή Molyvi Basic. Εικονικές τιμές, μεγέθη και απόθεμα. Μόνο δοκιμαστικές παραγγελίες.\n${copy.description.text}`;
  return {productId:product.id,handle:`molyvi-basic-${product.id}`,title:`Molyvi Basic QA — ${copy.title.text}`,descriptionText,descriptionHtml:descriptionText.split('\n').map(t=>`<p>${escapeStoreContentHtml(t)}</p>`).join('\n'),status:'DRAFT',publishedOnOnlineStore:false,currency:'EUR',vendor:'Molyvi Basic QA',type:product.category,tags:['molyvi-basic-20261012'],variants,photos,source:{submissionHash:submission.hash,copyHash:hash(copy),galleryHash:gallery.sourceHash,selectionHash:hash(gallery)}};
 });
 const plan={schemaVersion:1,kind:'molyvi_basic_dev_catalog',projectId:record.id,targetStore,applicationAuthorized:false,publicationAuthorized:false,productionAdapter:false,overwriteExisting:false,deleteProducts:false,counts:{products:10,variants:14,photos:30},products:plans};
 return {...plan,planHash:hash(plan)};
}
export async function prepareStoredShopifyCatalogPlan(store,session,options){
 const record=await store.read(session.projectId,session.ownerId),assets=[];
 for(const product of record.tasks.catalog.draft.products)for(const photo of gallerySelectionSnapshot(record,product.id).photos)assets.push(await readGeneratedPhoto(store,session,photo.assetId));
 const plan=prepareShopifyCatalogPlan(record,{...options,assets});
 return {plan,uploads:plan.products.flatMap(p=>p.photos.map(photo=>({fileName:photo.fileName,bytes:assets.find(a=>a.asset.id===photo.assetId).bytes,sha256:photo.sha256})))};
}
const csvCell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
export function catalogPlanCsv(plan){
 const {planHash,...unsigned}=plan;if(planHash!==hash(unsigned)||plan.kind!=='molyvi_basic_dev_catalog')fail('CATALOG_PLAN_CORRUPTED');checkTarget(plan.targetStore);
 const columns=['Handle','Title','Body (HTML)','Vendor','Type','Tags','Published','Option1 Name','Option1 Value','Variant SKU','Variant Grams','Variant Inventory Tracker','Variant Inventory Qty','Variant Inventory Policy','Variant Fulfillment Service','Variant Price','Variant Requires Shipping','Variant Taxable','Status'];
 const rows=plan.products.flatMap(p=>p.variants.map((v,index)=>[p.handle,index?'':p.title,index?'':p.descriptionHtml,index?'':p.vendor,index?'':p.type,index?'':p.tags.join(','),'FALSE',v.size?'Μέγεθος':'Title',v.size??'Default Title',v.sku,v.weightGrams,'shopify',v.stock,'deny','manual',v.price,'TRUE','TRUE','draft']));
 return [columns,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
export function inspectCatalogConflicts(plan,{targetStore,existingProducts,complete=false,receipts=[]}={}){
 checkTarget(targetStore);checkTarget(plan.targetStore);const {planHash,...unsigned}=plan;if(planHash!==hash(unsigned)||plan.kind!=='molyvi_basic_dev_catalog')fail('CATALOG_PLAN_CORRUPTED');
 if(!complete||!Array.isArray(existingProducts))fail('CATALOG_OBSERVATIONS_INCOMPLETE');
 return plan.products.map(p=>{const matches=existingProducts.filter(e=>e.handle===p.handle||e.title===p.title||p.variants.some(v=>e.skus?.includes(v.sku))),prior=receipts.filter(e=>e.productId===p.productId);
  if(matches.length===0&&prior.length===0)return{productId:p.productId,action:'create_draft'};
  if(matches.length===1&&prior.length===1&&prior[0].planHash===planHash&&prior[0].shopifyProductId===matches[0].id&&prior[0].targetStore===targetStore)return{productId:p.productId,action:'verify_existing',shopifyProductId:matches[0].id};
  return{productId:p.productId,action:'blocked_conflict'};
 });
}
