import {matchesShopifyWeight} from './shopify-weight-readback.mjs';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {createBasicInstallationSource} from './basic-installation-source.mjs';

export const SHOPIFY_BASIC_CATALOG_API_VERSION='2026-10';
export const SHOPIFY_BASIC_CATALOG_STORE='molyvi-still-dev.myshopify.com';
export const SHOPIFY_BASIC_CATALOG_SHOP_ID='108668748113';
export const SHOPIFY_BASIC_CATALOG_APP_ID='436878311425';
export const SHOPIFY_BASIC_CATALOG_INSTALLATION_ID='1195450433873';
export const SHOPIFY_BASIC_CATALOG_LIVE_THEME_ID='207379235153';
export const SHOPIFY_BASIC_CATALOG_LOCATION_ID='125398417745';
// Additional access is a proposal only. This module never provisions a grant.
export const SHOPIFY_BASIC_CATALOG_SCOPES=Object.freeze(['write_products','read_inventory','read_locations','read_themes','read_publications']);
export const SHOPIFY_BASIC_CATALOG_LIMITS=Object.freeze({variantsPerProduct:100,requestBytes:1024*1024,responseBytes:2*1024*1024,timeoutMs:30000});
const endpoint=`https://${SHOPIFY_BASIC_CATALOG_STORE}/admin/api/${SHOPIFY_BASIC_CATALOG_API_VERSION}/graphql.json`;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>sha(canonicalJson(value));
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fail=code=>{throw new IntakeError(`SHOPIFY_BASIC_CATALOG_${code}`,422);};
const gid=(kind,id)=>`gid://shopify/${kind}/${id}`;
const numericId=(value,kind)=>typeof value==='string'&&new RegExp(`^gid://shopify/${kind}/[1-9][0-9]{0,24}$`).test(value)?value.split('/').at(-1):null;
const money=minor=>`${BigInt(minor)/100n}.${String(BigInt(minor)%100n).padStart(2,'0')}`;
const tuple=(sku,optionValues)=>canonicalJson({sku,optionValues});
const identitySelection=`shop { id myshopifyDomain currencyCode }
  currentAppInstallation { id app { id } accessScopes { handle } }
  themes(first: 2, roles: [MAIN]) { nodes { id role } pageInfo { hasNextPage } }
  location(id: $locationId) { id isActive fulfillsOnlineOrders }`;

// Fixed operations only. There is deliberately no identifier or id argument in
// productSet: an existing product may never be upserted through this adapter.
export const SHOPIFY_BASIC_CATALOG_OPERATIONS=Object.freeze({
  preflight:`query MolyviBasicCatalogPreflight($query: String!, $locationId: ID!) {
    ${identitySelection}
    products(first: 2, query: $query) { nodes { id handle } pageInfo { hasNextPage } }
  }`,
  create:`mutation MolyviBasicCatalogCreate($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) { product { id } userErrors { code field message } }
  }`,
  readback:`query MolyviBasicCatalogReadback($id: ID!, $locationId: ID!, $variantLimit: Int!) {
    ${identitySelection}
    product(id: $id) {
      id handle title descriptionHtml vendor productType status tags
      options(first: 3) { name position optionValues { name } }
      resourcePublicationsCount(onlyPublished: false) { count precision }
      variants(first: $variantLimit) {
        pageInfo { hasNextPage }
        nodes {
          id sku price inventoryPolicy selectedOptions { name value }
          inventoryItem {
            id sku tracked requiresShipping measurement { weight { unit value } }
            inventoryLevels(first: 2) { pageInfo { hasNextPage } nodes { location { id } quantities(names: ["available"]) { name quantity } } }
          }
        }
      }
    }
  }`
});

function abortable(promise,signal){
  if(signal.aborted)return Promise.reject(new IntakeError('SHOPIFY_BASIC_CATALOG_REQUEST_ABORTED',422));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new IntakeError('SHOPIFY_BASIC_CATALOG_REQUEST_ABORTED',422));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
async function responseJson(response,signal){
  if(!response||response.redirected===true||(response.url&&response.url!==endpoint))fail('REDIRECT_OR_WRONG_RESPONSE_ORIGIN');
  if(!Number.isInteger(response.status)||response.status<200||response.status>=300)fail('HTTP_FAILURE');
  if(response.headers?.get('x-shopify-api-version')!==SHOPIFY_BASIC_CATALOG_API_VERSION)fail('API_VERSION_MISMATCH');
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??''))fail('NON_JSON_RESPONSE');
  const stated=response.headers?.get('content-length');
  if(stated!==null&&stated!==undefined&&(!/^\d+$/.test(stated)||Number(stated)>SHOPIFY_BASIC_CATALOG_LIMITS.responseBytes))fail('RESPONSE_TOO_LARGE');
  if(!response.body?.getReader)fail('RESPONSE_BODY_REQUIRED');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){
      if(signal.aborted)fail('REQUEST_ABORTED');
      const {done,value}=await abortable(reader.read(),signal);if(done)break;
      if(!(value instanceof Uint8Array)||(size+=value.byteLength)>SHOPIFY_BASIC_CATALOG_LIMITS.responseBytes)fail('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  }finally{try{void reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
  let decoded;try{decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_JSON_RESPONSE');}
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)||(decoded.errors!==undefined&&(!Array.isArray(decoded.errors)||decoded.errors.length)))fail('GRAPHQL_FAILURE');
  if(!decoded.data||typeof decoded.data!=='object'||Array.isArray(decoded.data))fail('GRAPHQL_DATA_REQUIRED');
  return decoded.data;
}
function cents(value){
  // Shopify Money is a decimal string. Never round or parse a floating number.
  if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))fail('PRICE_NOT_EXACT_CENTS');
  const [whole,fraction='']=value.split('.'),minor=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(minor>BigInt(Number.MAX_SAFE_INTEGER))fail('PRICE_NOT_EXACT_CENTS');
  return Number(minor);
}
function weightGrams(measurement,expected){
  if(!measurement||!Object.hasOwn(measurement,'weight')||!matchesShopifyWeight(measurement.weight,expected))fail('WEIGHT_READBACK_INVALID');
  return expected; // null remains unknown, even when Shopify returns its zero default.
}
function connection(value,maximum,code){
  if(!value||value.pageInfo?.hasNextPage!==false||!Array.isArray(value.nodes)||value.nodes.length>maximum)fail(code);
  return value.nodes;
}

/**
 * LOCAL controlled catalog transport; network defaults OFF. The durable runner
 * is required for one-attempt claims and cross-process duplicate exclusion.
 * Only ordinary physical EUR products at the pinned dev-store location. A
 * create-response ID is retained in memory; lost response/restart stays unknown.
 * No publish/update/delete/inventory-reset endpoint and no inferred ownership.
 * Tags and shipping requirement are checked in addition to the journal shape.
 * Local visual-unit/image-position identifiers are correlation metadata only:
 * this catalog receipt does NOT claim photographs have been installed/linked.
 * An omitted source weight remains unknown in the receipt. A zero returned
 * by Shopify in a valid unit is recorded as its platform default, not a
 * measured source weight. Any positive or malformed default fails closed.
 */
export function createShopifyBasicCatalogTransport({prepared,referenceComposition,binding,liveThemeId,inventoryLocationId,accessToken,fetchImpl=globalThis.fetch,networkEnabled=false,catalogRecovery}={}){
  const source=createBasicInstallationSource({prepared,referenceComposition});
  const {plan,uploads}=source,pinned=structuredClone(binding);
  if(!pinned||!equal(Object.keys(pinned).sort(),['intentHash','targetStore','projectId','ownerHash','planHash','themeZipSha256','packageBytesHash'].sort())
    ||!isHash(pinned.intentHash)||!isHash(pinned.themeZipSha256)||pinned.targetStore!==SHOPIFY_BASIC_CATALOG_STORE
    ||plan.targetStore!==pinned.targetStore||plan.projectId!==pinned.projectId||plan.binding.ownerHash!==pinned.ownerHash||plan.planHash!==pinned.planHash
    ||pinned.packageBytesHash!==hash({plan,uploads})||liveThemeId!==SHOPIFY_BASIC_CATALOG_LIVE_THEME_ID||inventoryLocationId!==SHOPIFY_BASIC_CATALOG_LOCATION_ID)fail('BINDING_MISMATCH');
  if(typeof fetchImpl!=='function'||typeof networkEnabled!=='boolean')fail('TRANSPORT_CONFIGURATION_INVALID');
  fetchImpl=source.guardFetch(fetchImpl);
  if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>2048||!(/^[\x21-\x7e]+$/).test(accessToken))fail('CREDENTIAL_REQUIRED');
  const steps=new Map(plan.products.map(product=>{
    if(!/^[a-z0-9][a-z0-9-]*$/.test(product.handle)||product.variants.length>SHOPIFY_BASIC_CATALOG_LIMITS.variantsPerProduct)fail('PRODUCT_SOURCE_MISMATCH');
    const expected={handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.type,optionNames:product.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId,variants:product.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};
    const input={handle:product.handle,title:product.title,descriptionHtml:product.descriptionHtml,vendor:product.vendor,productType:product.type,status:'DRAFT',tags:[...product.tags],
      productOptions:product.optionNames.map((name,index)=>({name,position:index+1,values:[...new Set(product.variants.map(v=>v.optionValues[index]))].map(name=>({name}))})),
      variants:product.variants.map(v=>({sku:v.sku,price:money(v.priceMinor),inventoryPolicy:'DENY',optionValues:v.optionValues.map((name,index)=>({optionName:product.optionNames[index],name})),
        inventoryItem:{sku:v.sku,tracked:true,requiresShipping:true,...(v.weightGrams===null?{}:{measurement:{weight:{unit:'GRAMS',value:v.weightGrams}}})},
        inventoryQuantities:[{locationId:gid('Location',inventoryLocationId),name:'available',quantity:v.stock}]}))};
    return [`catalog:${product.productId}`,{step:{key:`catalog:${product.productId}`,kind:'catalog',action:'create',expected,payloadHash:hash(expected),dependsOn:[]},input}];
  }));
  const attempts=new Map(),preflights=new Map(),sentSteps=new Set();
  const snapshot=value=>{try{return structuredClone(value);}catch{fail('REQUEST_INVALID');}};
  const attemptKey=request=>`${request.step.key}:${request.attemptId??'before-claim'}`;
  if(catalogRecovery){
    const r=catalogRecovery;
    if(r.intentHash!==pinned.intentHash||!plan.products.some(p=>r.key===`catalog:${p.productId}`)||!uuid(r.attemptId)||!numericId(`gid://shopify/Product/${r.remoteId}`,'Product'))fail('RECOVERY_BINDING');
    attempts.set(`${r.key}:${r.attemptId}`,{remoteId:`gid://shopify/Product/${r.remoteId}`});sentSteps.add(r.key);
  }
  function validate(request,{attemptRequired=false,readback=false}={}){
    if(!request||!equal(request.binding,pinned)||!equal(request.trustedShop,{shopId:SHOPIFY_BASIC_CATALOG_SHOP_ID,targetStore:SHOPIFY_BASIC_CATALOG_STORE}))fail('REQUEST_BINDING_MISMATCH');
    const entry=steps.get(request.step?.key);if(!entry||request.step?.kind!=='catalog')fail('UNSUPPORTED_STEP');
    if(!equal(request.step,entry.step)||!equal(request.dependencies,{}))fail('CATALOG_STEP_MISMATCH');
    if((attemptRequired&&!uuid(request.attemptId))||(request.attemptId!==undefined&&request.attemptId!==null&&!uuid(request.attemptId)))fail('ATTEMPT_REQUIRED');
    if(readback&&(!uuid(request.readRequestId)||!['after_apply','reconcile'].includes(request.mode)))fail('READBACK_REQUEST_INVALID');
    return entry;
  }
  async function graphql(operation,variables,{signal}={}){
    if(!networkEnabled)fail('NETWORK_DISABLED');if(signal?.aborted)fail('REQUEST_ABORTED');
    const own=AbortSignal.timeout(SHOPIFY_BASIC_CATALOG_LIMITS.timeoutMs),combined=signal?AbortSignal.any([own,signal]):own;
    const body=JSON.stringify({query:SHOPIFY_BASIC_CATALOG_OPERATIONS[operation],variables});
    if(Buffer.byteLength(body)>SHOPIFY_BASIC_CATALOG_LIMITS.requestBytes)fail('REQUEST_TOO_LARGE');
    try{
      return await responseJson(await abortable(fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-Shopify-Access-Token':accessToken},body,signal:combined,redirect:'error',credentials:'omit',cache:'no-store'}),combined),combined);
    }catch(error){if(error instanceof IntakeError&&error.code?.startsWith('SHOPIFY_BASIC_CATALOG_'))throw error;fail(combined.aborted?'REQUEST_ABORTED':'REQUEST_FAILED');}
  }
  function identity(data){
    if(data.shop?.id!==gid('Shop',SHOPIFY_BASIC_CATALOG_SHOP_ID)||data.shop?.myshopifyDomain!==SHOPIFY_BASIC_CATALOG_STORE||data.shop?.currencyCode!=='EUR')fail('REMOTE_SHOP_MISMATCH');
    if(data.currentAppInstallation?.id!==gid('AppInstallation',SHOPIFY_BASIC_CATALOG_INSTALLATION_ID)||data.currentAppInstallation?.app?.id!==gid('App',SHOPIFY_BASIC_CATALOG_APP_ID))fail('REMOTE_APP_MISMATCH');
    const scopes=data.currentAppInstallation.accessScopes;
    if(!Array.isArray(scopes)||scopes.some(s=>typeof s?.handle!=='string')||!SHOPIFY_BASIC_CATALOG_SCOPES.every(scope=>scopes.some(s=>s.handle===scope)))fail('REQUIRED_SCOPES_MISSING');
    const themes=connection(data.themes,1,'LIVE_THEME_CHANGED');
    if(themes.length!==1||themes[0]?.id!==gid('OnlineStoreTheme',liveThemeId)||themes[0]?.role!=='MAIN')fail('LIVE_THEME_CHANGED');
    if(data.location?.id!==gid('Location',inventoryLocationId)||data.location?.isActive!==true||data.location?.fulfillsOnlineOrders!==true)fail('INVENTORY_LOCATION_MISMATCH');
    return {shopId:SHOPIFY_BASIC_CATALOG_SHOP_ID,targetStore:SHOPIFY_BASIC_CATALOG_STORE,currency:data.shop.currencyCode};
  }
  async function preflight(request,options={}){
    request=snapshot(request);const {step}=validate(request),key=attemptKey(request);preflights.delete(key);
    const data=await graphql('preflight',{query:`handle:${step.expected.handle}`,locationId:gid('Location',inventoryLocationId)},options),remote=identity(data),products=connection(data.products,1,'HANDLE_LOOKUP_AMBIGUOUS');
    if(products.length){const known=attempts.get(key);if(!known?.remoteId||products[0]?.id!==known.remoteId||products[0]?.handle!==step.expected.handle)fail('HANDLE_ALREADY_EXISTS');}
    preflights.set(key,Date.now());return {...remote,authorizedKinds:['catalog'],observedAt:new Date().toISOString()};
  }
  async function apply(request,options={}){
    request=snapshot(request);const {step,input}=validate(request,{attemptRequired:true}),key=attemptKey(request);
    if(attempts.has(key)||sentSteps.has(step.key))fail('ATTEMPT_ALREADY_SENT');
    const checked=preflights.get(key);if(!checked||Date.now()-checked>SHOPIFY_BASIC_CATALOG_LIMITS.timeoutMs)fail('FRESH_PREFLIGHT_REQUIRED');
    attempts.set(key,{status:'unknown'});sentSteps.add(step.key);preflights.delete(key);
    const data=await graphql('create',{input},options),result=data.productSet;
    if(!result||!Array.isArray(result.userErrors)||result.userErrors.length||!numericId(result.product?.id,'Product'))fail('CREATE_OUTCOME_UNCONFIRMED');
    attempts.set(key,{remoteId:result.product.id});return {outcome:'create_response_received'};
  }
  async function readback(request,options={}){
    request=snapshot(request);const {step,input}=validate(request,{attemptRequired:true,readback:true}),known=attempts.get(attemptKey(request));
    const base={kind:'molyvi_basic_installation_readback',readRequestId:request.readRequestId,shopId:SHOPIFY_BASIC_CATALOG_SHOP_ID,targetStore:SHOPIFY_BASIC_CATALOG_STORE,key:step.key,attemptId:request.attemptId,payloadHash:step.payloadHash,observedAt:new Date().toISOString(),correlation:{intentHash:pinned.intentHash,attemptId:request.attemptId,payloadHash:step.payloadHash}};
    if(!known?.remoteId)return {...base,outcome:'unknown'};
    const data=await graphql('readback',{id:known.remoteId,locationId:gid('Location',inventoryLocationId),variantLimit:step.expected.variants.length},options),remote=identity(data),product=data.product;
    if(!product)return {...base,outcome:'unknown',observedAt:new Date().toISOString()};
    if(product.id!==known.remoteId||['handle','title','descriptionHtml','vendor','productType','status'].some(k=>typeof product[k]!=='string')||!Array.isArray(product.tags)||!equal([...product.tags].sort(),[...input.tags].sort()))fail('READBACK_INVALID');
    if(product.resourcePublicationsCount?.count!==0||product.resourcePublicationsCount?.precision!=='EXACT')fail('PUBLICATION_DETECTED');
    if(!Array.isArray(product.options)||product.options.length!==input.productOptions.length)fail('OPTIONS_MISMATCH');
    const actualOptions=[...product.options].sort((a,b)=>a.position-b.position);
    for(const [index,option]of actualOptions.entries()){
      if(option?.position!==index+1||option.name!==input.productOptions[index].name||!Array.isArray(option.optionValues)||!equal(option.optionValues.map(o=>o?.name).sort(),input.productOptions[index].values.map(o=>o.name).sort()))fail('OPTIONS_MISMATCH');
    }
    const variants=connection(product.variants,SHOPIFY_BASIC_CATALOG_LIMITS.variantsPerProduct,'VARIANTS_INCOMPLETE');
    if(variants.length!==step.expected.variants.length)fail('VARIANTS_INCOMPLETE');
    const mapped=new Map(),ids=new Set(),inventoryIds=new Set();
    for(const variant of variants){
      const remoteId=numericId(variant?.id,'ProductVariant'),item=variant?.inventoryItem,itemId=numericId(item?.id,'InventoryItem');
      if(!remoteId||ids.has(remoteId)||!itemId||inventoryIds.has(itemId)||typeof variant.sku!=='string'||item.sku!==variant.sku||typeof item.tracked!=='boolean'||item.requiresShipping!==true||!['DENY','CONTINUE'].includes(variant.inventoryPolicy))fail('VARIANT_READBACK_INVALID');
      ids.add(remoteId);inventoryIds.add(itemId);
      if(!Array.isArray(variant.selectedOptions)||variant.selectedOptions.length!==actualOptions.length||new Set(variant.selectedOptions.map(o=>o?.name)).size!==actualOptions.length)fail('VARIANT_OPTIONS_INVALID');
      const optionValues=actualOptions.map(option=>variant.selectedOptions.find(o=>o?.name===option.name)?.value);
      if(optionValues.some(value=>typeof value!=='string'))fail('VARIANT_OPTIONS_INVALID');
      const key=tuple(variant.sku,optionValues),local=step.expected.variants.find(v=>tuple(v.sku,v.optionValues)===key);
      if(!local||mapped.has(key))fail('VARIANT_MAPPING_MISMATCH');
      const levels=connection(item.inventoryLevels,1,'INVENTORY_LEVELS_MISMATCH');
      if(levels.length!==1||levels[0]?.location?.id!==gid('Location',inventoryLocationId)||!Array.isArray(levels[0].quantities)||levels[0].quantities.length!==1||levels[0].quantities[0]?.name!=='available'||!Number.isSafeInteger(levels[0].quantities[0].quantity)||levels[0].quantities[0].quantity<0)fail('INVENTORY_LEVELS_MISMATCH');
      mapped.set(key,{localId:local.localId,remoteId,sku:variant.sku,optionValues,priceMinor:cents(variant.price),stock:levels[0].quantities[0].quantity,weightGrams:weightGrams(item.measurement,local.weightGrams),visualUnitId:local.visualUnitId,imagePosition:local.imagePosition,trackInventory:item.tracked,continueSellingWhenOutOfStock:variant.inventoryPolicy==='CONTINUE'});
    }
    const observed={handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.productType,optionNames:actualOptions.map(o=>o.name),status:product.status,channels:Array.from({length:product.resourcePublicationsCount.count}),currency:remote.currency,inventoryLocationId:data.location.id.split('/').at(-1),variants:step.expected.variants.map(local=>mapped.get(tuple(local.sku,local.optionValues)))};
    const comparable={...observed,variants:observed.variants.map(({remoteId,...fields})=>fields)};
    if(!equal(comparable,step.expected))fail('READBACK_MISMATCH');
    return {...base,outcome:'found',remoteId:numericId(known.remoteId,'Product'),observed,observedAt:new Date().toISOString()};
  }
  return Object.freeze({supportedKinds:Object.freeze(['catalog']),preflight:source.guardMethod(preflight),apply:source.guardMethod(apply),readback:source.guardMethod(readback)});
}
