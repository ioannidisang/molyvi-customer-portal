import {IntakeError} from './intake-store.mjs';

const fail=(code,status=422)=>{throw new IntakeError(code,status,{field:'products'});};
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameColor=value=>(value??'').trim().toLocaleLowerCase('el');
export const CATALOG_TECHNICAL_LIMITS=Object.freeze({catalogProducts:100,variantsPerProduct:100,variantsPerProject:1000,visualUnitsPerProduct:25,factsPerProduct:40,photosPerUnit:10,photosPerProduct:100});
export const hasVisualUnits=product=>Object.hasOwn(product,'visualUnits')||Object.hasOwn(product,'variants');
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
function text(value,limit,{nullable=false}={}){
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||value.length>limit)fail('INVALID_CATALOG_FIELD',400);
  return value.trim();
}
function ids(value,limit){
  if(!Array.isArray(value)||value.length>limit||value.some(id=>!uuid(id))||new Set(value).size!==value.length)fail('INVALID_CATALOG_REFERENCES',400);
  return [...value];
}
function quantity(value){if(value===null)return null;if(!Number.isSafeInteger(value)||value<0)fail('INVALID_CATALOG_NUMBER',400);return value;}

// Technical parsing ceilings prevent oversized drafts. They are not a commercial SKU allowance.
export function normalizeCatalogFields(project,product,{complete=false}={}){
  const clean={};
  if(Object.hasOwn(product,'category'))clean.category=text(product.category,300);
  if(Object.hasOwn(product,'facts')){
    if(!Array.isArray(product.facts)||product.facts.length>CATALOG_TECHNICAL_LIMITS.factsPerProduct)fail('INVALID_CATALOG_FACTS',400);
    clean.facts=product.facts.map(value=>text(value,2000));
  }
  if(!hasVisualUnits(product))return clean;
  if(!Array.isArray(product.variants)||!Array.isArray(product.visualUnits))fail('INVALID_CATALOG_MODEL',400);
  if(product.variants.length>CATALOG_TECHNICAL_LIMITS.variantsPerProduct||product.visualUnits.length>CATALOG_TECHNICAL_LIMITS.visualUnitsPerProduct)fail('CATALOG_TECHNICAL_LIMIT',413);
  const variantIds=new Set();
  clean.variants=product.variants.map(variant=>{
    if(!exact(variant,['id','sku','color','size','priceMinor','stock','weightGrams'])||!uuid(variant.id)||variantIds.has(variant.id))fail('INVALID_VARIANT',400);
    variantIds.add(variant.id);
    const result={id:variant.id};
    for(const key of ['sku','color','size'])result[key]=text(variant[key],300,{nullable:true});
    for(const key of ['priceMinor','stock','weightGrams'])result[key]=quantity(variant[key]);
    if(complete&&(result.priceMinor===null||result.stock===null))fail('INPUT_INCOMPLETE');
    return result;
  });
  const unitIds=new Set(),mappedVariants=new Set(),assetColors=new Map();
  clean.visualUnits=product.visualUnits.map(unit=>{
    if(!exact(unit,['id','color','variantIds','sourceAssetIds','representationNote'])||!uuid(unit.id)||unitIds.has(unit.id))fail('INVALID_VISUAL_UNIT',400);
    unitIds.add(unit.id);
    const result={id:unit.id,color:text(unit.color,300,{nullable:true}),variantIds:ids(unit.variantIds,CATALOG_TECHNICAL_LIMITS.variantsPerProduct),sourceAssetIds:ids(unit.sourceAssetIds,CATALOG_TECHNICAL_LIMITS.photosPerUnit),representationNote:text(unit.representationNote,8000)};
    for(const variantId of result.variantIds){
      const variant=clean.variants.find(item=>item.id===variantId);
      if(!variant||mappedVariants.has(variantId))fail('INVALID_VARIANT_ASSIGNMENT');
      if(complete&&sameColor(variant.color)!==sameColor(result.color))fail('VISUAL_UNIT_COLOR_MISMATCH');
      mappedVariants.add(variantId);
    }
    for(const assetId of result.sourceAssetIds){
      if(project.assets?.[assetId]?.productId!==product.id)fail('PHOTO_NOT_OWNED',403);
      if(complete&&assetColors.has(assetId)&&assetColors.get(assetId)!==sameColor(result.color))fail('PHOTO_COLOR_CONFLICT');
      assetColors.set(assetId,sameColor(result.color));
    }
    if(complete&&(!result.variantIds.length||!result.sourceAssetIds.length))fail('INPUT_INCOMPLETE');
    return result;
  });
  if(complete&&(!clean.variants.length||!clean.visualUnits.length||mappedVariants.size!==variantIds.size))fail('INPUT_INCOMPLETE');
  return clean;
}

// Legacy records stay byte-for-byte shaped as before; this synthetic view is not persisted.
export function visualUnitsFor(product){
  return hasVisualUnits(product)?structuredClone(product.visualUnits):[{id:null,color:null,variantIds:[],sourceAssetIds:[...(product.photos??[])],representationNote:''}];
}
export function unitFor(product,visualUnitId){
  if(hasVisualUnits(product)){
    if(!visualUnitId)fail('VISUAL_UNIT_REQUIRED');
    return product.visualUnits.find(unit=>unit.id===visualUnitId)??fail('VISUAL_UNIT_NOT_FOUND',404);
  }
  if(visualUnitId!==undefined&&visualUnitId!==null)fail('VISUAL_UNIT_NOT_FOUND',404);
  return visualUnitsFor(product)[0];
}
export function catalogCounts(products=[],photoSlotsPerUnit=3){
  const visualUnits=products.reduce((sum,product)=>sum+visualUnitsFor(product).length,0);
  return {catalogProducts:products.length,variants:products.reduce((sum,product)=>sum+(hasVisualUnits(product)?product.variants.length:1),0),visualUnits,initialPhotoSlots:visualUnits*photoSlotsPerUnit};
}
export function sourceAssetIdsFor(product){return [...new Set(visualUnitsFor(product).flatMap(unit=>unit.sourceAssetIds))];}
