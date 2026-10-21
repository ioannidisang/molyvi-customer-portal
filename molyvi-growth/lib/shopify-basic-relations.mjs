import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {createBasicInstallationSource} from './basic-installation-source.mjs';

export const SHOPIFY_BASIC_RELATIONS_API_VERSION='2026-10';
export const SHOPIFY_BASIC_RELATIONS_STORE='molyvi-still-dev.myshopify.com';
export const SHOPIFY_BASIC_RELATIONS_SHOP_ID='108668748113';
export const SHOPIFY_BASIC_RELATIONS_APP_ID='436878311425';
export const SHOPIFY_BASIC_RELATIONS_INSTALLATION_ID='1195450433873';
export const SHOPIFY_BASIC_RELATIONS_SCOPES=Object.freeze(['write_products','read_publications','read_themes']);
const LIVE_THEME='207379235153',LOCATION='125398417745',TIMEOUT=30000,MAX_BYTES=2*1024*1024;
const endpoint=`https://${SHOPIFY_BASIC_RELATIONS_STORE}/admin/api/${SHOPIFY_BASIC_RELATIONS_API_VERSION}/graphql.json`;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonicalJson(v)),equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),id=v=>typeof v==='string'&&/^[1-9][0-9]{0,24}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const gid=(kind,value)=>`gid://shopify/${kind}/${value}`,fail=code=>{throw new IntakeError(`SHOPIFY_BASIC_RELATIONS_${code}`,422);};
const numeric=(v,kind)=>typeof v==='string'&&new RegExp(`^gid://shopify/${kind}/[1-9][0-9]{0,24}$`).test(v)?v.split('/').at(-1):null;
const identityFields=`shop { id myshopifyDomain currencyCode }
 currentAppInstallation { id app { id } accessScopes { handle } }
 themes(first:2,roles:[MAIN]) { nodes { id role } pageInfo { hasNextPage } }`;
const productFields=`id handle title descriptionHtml vendor productType status tags options { name }
 resourcePublicationsCount(onlyPublished:false) { count precision }
 variants(first:$variantLimit) { nodes { id sku price selectedOptions { name value } media(first:1) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
 media(first:$mediaLimit) { nodes { id alt status mediaContentType } pageInfo { hasNextPage } }`;
export const SHOPIFY_BASIC_RELATIONS_OPERATIONS=Object.freeze({
 preflight:`query MolyviBasicRelationsPreflight($ids:[ID!]!,$query:String!,$variantLimit:Int!,$mediaLimit:Int!) { ${identityFields} nodes(ids:$ids) { ... on Product { ${productFields} } } collections(first:2,query:$query) { nodes { id handle } pageInfo { hasNextPage } } }`,
 append:`mutation MolyviBasicVariantMediaAppend($productId:ID!,$variantMedia:[ProductVariantAppendMediaInput!]!) { productVariantAppendMedia(productId:$productId,variantMedia:$variantMedia) { product { id } userErrors { code field message } } }`,
 create:`mutation MolyviBasicCollectionCreate($collection:CollectionCreateInput!) { collectionCreate(collection:$collection) { collection { id } userErrors { field message } } }`,
 readVariants:`query MolyviBasicVariantMediaReadback($ids:[ID!]!,$variantLimit:Int!,$mediaLimit:Int!) { ${identityFields} nodes(ids:$ids) { ... on Product { ${productFields} } } }`,
 readCollection:`query MolyviBasicCollectionReadback($ids:[ID!]!,$id:ID!,$variantLimit:Int!,$mediaLimit:Int!) { ${identityFields} nodes(ids:$ids) { ... on Product { ${productFields} } } collection(id:$id) { id title handle resourcePublicationsCount(onlyPublished:false) { count precision } products(first:11) { nodes { id } pageInfo { hasNextPage } } } }`
});
function connection(value,max,code){if(!value||value.pageInfo?.hasNextPage!==false||!Array.isArray(value.nodes)||value.nodes.length>max)fail(code);return value.nodes;}
function noPublications(value){if(value?.count!==0||value.precision!=='EXACT')fail('PUBLICATION_DETECTED');}
function cents(value){if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))fail('PRICE_INVALID');const [a,b='']=value.split('.'),n=BigInt(a)*100n+BigInt(b.padEnd(2,'0'));if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('PRICE_INVALID');return Number(n);}
function abortable(promise,signal){if(signal.aborted)return Promise.reject(new IntakeError('SHOPIFY_BASIC_RELATIONS_REQUEST_ABORTED',422));return new Promise((resolve,reject)=>{const abort=()=>reject(new IntakeError('SHOPIFY_BASIC_RELATIONS_REQUEST_ABORTED',422));signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
async function responseJson(response,signal){
 if(!response||response.redirected===true||(response.url&&response.url!==endpoint))fail('REDIRECT_OR_WRONG_ORIGIN');
 if(!Number.isInteger(response.status)||response.status<200||response.status>=300)fail('HTTP_FAILURE');
 if(response.headers?.get('x-shopify-api-version')!==SHOPIFY_BASIC_RELATIONS_API_VERSION)fail('API_VERSION_MISMATCH');
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??''))fail('NON_JSON_RESPONSE');
 const size=response.headers?.get('content-length');if(size!==null&&size!==undefined&&(!/^\d+$/.test(size)||Number(size)>MAX_BYTES))fail('RESPONSE_TOO_LARGE');
 if(!response.body?.getReader)fail('RESPONSE_BODY_REQUIRED');const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{while(true){const {done,value}=await abortable(reader.read(),signal);if(done)break;if(!(value instanceof Uint8Array)||(bytes+=value.byteLength)>MAX_BYTES)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}}
 finally{try{void reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
 let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_JSON_RESPONSE');}
 if(!json||typeof json!=='object'||Array.isArray(json)||(json.errors!==undefined&&(!Array.isArray(json.errors)||json.errors.length))||!json.data||typeof json.data!=='object'||Array.isArray(json.data))fail('GRAPHQL_FAILURE');return json.data;
}
function catalogExpected(p){return {handle:p.handle,title:p.title,descriptionHtmlSha256:sha(p.descriptionHtml),vendor:p.vendor,productType:p.type,optionNames:p.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId:LOCATION,variants:p.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};}

/** Local-only new-resource links/collection transport, network OFF by default.
 * Caller must use the durable runner and exact dependency receipts. This is not
 * an access grant. Mutation IDs survive only within this adapter instance; a
 * lost response or restart remains unknown. No existing-link replacement,
 * deletion, publication, automatic network retry or handle-based adoption.
 * Re-reading media READY verifies association/state, not source pixel fidelity.
 */
export function createShopifyBasicRelationsTransport({prepared,referenceComposition,binding,liveThemeId,inventoryLocationId,accessToken,fetchImpl=globalThis.fetch,networkEnabled=false}={}){
 const source=createBasicInstallationSource({prepared,referenceComposition});
 const {plan,uploads}=source,pinned=structuredClone(binding);
 if(!pinned||!equal(Object.keys(pinned).sort(),['intentHash','targetStore','projectId','ownerHash','planHash','themeZipSha256','packageBytesHash'].sort())||!isHash(pinned.intentHash)||!isHash(pinned.themeZipSha256)||pinned.targetStore!==SHOPIFY_BASIC_RELATIONS_STORE||plan.targetStore!==pinned.targetStore||plan.projectId!==pinned.projectId||plan.binding.ownerHash!==pinned.ownerHash||plan.planHash!==pinned.planHash||pinned.packageBytesHash!==hash({plan,uploads})||liveThemeId!==LIVE_THEME||inventoryLocationId!==LOCATION)fail('BINDING_MISMATCH');
 if(typeof fetchImpl!=='function'||typeof networkEnabled!=='boolean')fail('CONFIGURATION_INVALID');
 fetchImpl=source.guardFetch(fetchImpl);
 if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>2048||!(/^[\x21-\x7e]+$/).test(accessToken))fail('CREDENTIAL_REQUIRED');
 const products=new Map(plan.products.map(p=>[`catalog:${p.productId}`,p])),steps=new Map();
 for(const p of plan.products){const parentKey=`catalog:${p.productId}`,expected={parentKey,associations:p.variants.map(v=>({localId:v.id,mediaKey:`media:${p.productId}:${v.imagePosition}`}))};steps.set(`variant_media:${p.productId}`,{key:`variant_media:${p.productId}`,kind:'variant_media',action:'link_new_resources',expected,payloadHash:hash(expected),dependsOn:[parentKey,...p.photos.map(v=>`media:${p.productId}:${v.position}`)]});}
 const expected={title:plan.branding.brandName,handle:plan.namespace,productKeys:[...products.keys()],channels:[]};steps.set('collection',{key:'collection',kind:'collection',action:'create',expected,payloadHash:hash(expected),dependsOn:[...products.keys()]});
 const attempts=new Map(),preflights=new Map(),sentSteps=new Set(),keyOf=r=>`${r.step.key}:${r.attemptId??'before-claim'}`;
 const snapshot=v=>{try{return structuredClone(v);}catch{fail('REQUEST_INVALID');}};
 function validate(r,{attemptRequired=false,readback=false}={}){
  if(!r||!equal(r.binding,pinned)||!equal(r.trustedShop,{shopId:SHOPIFY_BASIC_RELATIONS_SHOP_ID,targetStore:SHOPIFY_BASIC_RELATIONS_STORE}))fail('REQUEST_BINDING_MISMATCH');
  const step=steps.get(r.step?.key);if(!step||!equal(step,r.step))fail('UNSUPPORTED_OR_CHANGED_STEP');
  if((attemptRequired&&!uuid(r.attemptId))||(r.attemptId!==undefined&&r.attemptId!==null&&!uuid(r.attemptId)))fail('ATTEMPT_REQUIRED');
  if(readback&&(!uuid(r.readRequestId)||!['after_apply','reconcile'].includes(r.mode)))fail('READBACK_REQUEST_INVALID');
  if(!r.dependencies||!equal(Object.keys(r.dependencies).sort(),[...step.dependsOn].sort()))fail('DEPENDENCIES_MISMATCH');
  const parents=step.kind==='collection'?step.expected.productKeys:[step.expected.parentKey],allIds=new Set();
  for(const key of parents){const p=products.get(key),receipt=r.dependencies[key],expected=catalogExpected(p);if(!receipt||!id(receipt.remoteId)||allIds.has(receipt.remoteId)||receipt.payloadHash!==hash(expected)||!Array.isArray(receipt.observed?.variants))fail('CATALOG_RECEIPT_MISMATCH');allIds.add(receipt.remoteId);const withoutIds={...receipt.observed,variants:receipt.observed.variants.map(({remoteId,...fields})=>fields)};if(!equal(withoutIds,expected))fail('CATALOG_RECEIPT_MISMATCH');const variants=receipt.observed.variants.map(v=>v.remoteId);if(variants.some(v=>!id(v))||new Set(variants).size!==variants.length)fail('CATALOG_RECEIPT_MISMATCH');}
  if(step.kind==='variant_media'){const parent=r.dependencies[step.expected.parentKey],p=products.get(step.expected.parentKey),mediaIds=new Set();for(const photo of p.photos){const key=`media:${p.productId}:${photo.position}`,receipt=r.dependencies[key],expected={parentKey:step.expected.parentKey,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt};if(!receipt||!id(receipt.remoteId)||mediaIds.has(receipt.remoteId)||receipt.payloadHash!==hash(expected)||!equal(receipt.observed,{parentRemoteId:parent.remoteId,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt,loaded:true}))fail('MEDIA_RECEIPT_MISMATCH');mediaIds.add(receipt.remoteId);}}
  return {step,parents,ids:parents.map(key=>gid('Product',r.dependencies[key].remoteId))};
 }
 async function graphql(name,variables,{signal}={}){if(!networkEnabled)fail('NETWORK_DISABLED');if(signal?.aborted)fail('REQUEST_ABORTED');const own=AbortSignal.timeout(TIMEOUT),combined=signal?AbortSignal.any([signal,own]):own,body=JSON.stringify({query:SHOPIFY_BASIC_RELATIONS_OPERATIONS[name],variables});if(Buffer.byteLength(body)>MAX_BYTES)fail('REQUEST_TOO_LARGE');try{return await responseJson(await abortable(fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-Shopify-Access-Token':accessToken},body,redirect:'error',credentials:'omit',cache:'no-store',signal:combined}),combined),combined);}catch(error){if(error instanceof IntakeError&&error.code?.startsWith('SHOPIFY_BASIC_RELATIONS_'))throw error;fail(combined.aborted?'REQUEST_ABORTED':'REQUEST_FAILED');}}
 function identity(data){if(data.shop?.id!==gid('Shop',SHOPIFY_BASIC_RELATIONS_SHOP_ID)||data.shop?.myshopifyDomain!==SHOPIFY_BASIC_RELATIONS_STORE||data.shop?.currencyCode!=='EUR')fail('REMOTE_SHOP_MISMATCH');const app=data.currentAppInstallation;if(app?.id!==gid('AppInstallation',SHOPIFY_BASIC_RELATIONS_INSTALLATION_ID)||app?.app?.id!==gid('App',SHOPIFY_BASIC_RELATIONS_APP_ID))fail('REMOTE_APP_MISMATCH');if(!Array.isArray(app.accessScopes)||app.accessScopes.some(s=>typeof s?.handle!=='string')||!SHOPIFY_BASIC_RELATIONS_SCOPES.every(scope=>app.accessScopes.some(s=>s.handle===scope)))fail('REQUIRED_SCOPES_MISSING');const themes=connection(data.themes,1,'LIVE_THEME_CHANGED');if(themes.length!==1||themes[0]?.id!==gid('OnlineStoreTheme',LIVE_THEME)||themes[0]?.role!=='MAIN')fail('LIVE_THEME_CHANGED');return {shopId:SHOPIFY_BASIC_RELATIONS_SHOP_ID,targetStore:SHOPIFY_BASIC_RELATIONS_STORE,currency:'EUR'};}
 // Query one exact parent at a time using its sealed package counts, retaining
 // pageInfo to reject extra records. This bounds requested GraphQL cost rather
 // than multiplying worst-case limits by ten products. A throttle stops the
 // operation; there is no automatic mutation/read retry or budget escalation.
 async function readParents(operation,r,variables,options){
  const {ids,parents}=validate(r);
  let first,last;const nodes=[];
  for(const [index,parentId]of ids.entries()){const p=products.get(parents[index]),data=await graphql(operation,{...variables,ids:[parentId],variantLimit:p.variants.length,mediaLimit:p.photos.length},options);identity(data);if(!Array.isArray(data.nodes)||data.nodes.length!==1||data.nodes[0]?.id!==parentId)fail('PARENT_READBACK_INVALID');if(first&&(!equal(data.collections??null,first.collections??null)||!equal(data.collection??null,first.collection??null)))fail('COLLECTION_CHANGED_DURING_READ');first??=data;last=data;nodes.push(data.nodes[0]);}
  return {...last,nodes};
 }
 function parentState(data,r,{linked=false}={}){
  const {step,parents,ids}=validate(r);if(!Array.isArray(data.nodes)||data.nodes.length!==ids.length||new Set(data.nodes.map(v=>v?.id)).size!==ids.length)fail('PARENT_READBACK_INVALID');
  for(const key of parents){const receipt=r.dependencies[key],p=products.get(key),node=data.nodes.find(v=>v?.id===gid('Product',receipt.remoteId));if(!node||node.handle!==p.handle||node.title!==p.title||typeof node.descriptionHtml!=='string'||sha(node.descriptionHtml)!==sha(p.descriptionHtml)||node.vendor!==p.vendor||node.productType!==p.type||node.status!=='DRAFT'||!Array.isArray(node.tags)||!equal([...node.tags].sort(),[...p.tags].sort())||!Array.isArray(node.options)||!equal(node.options.map(v=>v.name),p.optionNames))fail('PARENT_READBACK_MISMATCH');noPublications(node.resourcePublicationsCount);
   const variants=connection(node.variants,100,'VARIANTS_INCOMPLETE');if(variants.length!==receipt.observed.variants.length)fail('VARIANTS_INCOMPLETE');const variantIds=new Set();for(const v of variants){const remote=numeric(v?.id,'ProductVariant'),local=receipt.observed.variants.find(x=>x.remoteId===remote);if(!remote||variantIds.has(remote)||!local||v.sku!==local.sku||cents(v.price)!==local.priceMinor||!Array.isArray(v.selectedOptions)||v.selectedOptions.length!==p.optionNames.length||new Set(v.selectedOptions.map(o=>o?.name)).size!==p.optionNames.length||!equal(p.optionNames.map(name=>v.selectedOptions.find(o=>o?.name===name)?.value),local.optionValues))fail('VARIANT_IDENTITY_MISMATCH');variantIds.add(remote);
    if(step.kind==='variant_media'){const links=connection(v.media,1,'VARIANT_MEDIA_MISMATCH'),association=step.expected.associations.find(a=>a.localId===local.localId),wanted=r.dependencies[association.mediaKey].remoteId;if(linked?links.length!==1||links[0]?.id!==gid('MediaImage',wanted):links.length!==0)fail(linked?'VARIANT_MEDIA_MISMATCH':'PREEXISTING_VARIANT_MEDIA');}
   }
   if(step.kind==='variant_media'){const media=connection(node.media,30,'MEDIA_INCOMPLETE');if(media.length!==p.photos.length)fail('MEDIA_INCOMPLETE');for(const [index,photo]of p.photos.entries()){const actual=media[index],expectedId=r.dependencies[`media:${p.productId}:${photo.position}`].remoteId;if(actual?.id!==gid('MediaImage',expectedId)||actual?.alt!==photo.alt||actual?.status!=='READY'||actual?.mediaContentType!=='IMAGE')fail('MEDIA_IDENTITY_MISMATCH');}}
  }
 }
 async function preflight(request,options={}){const r=snapshot(request),{step}=validate(r),key=keyOf(r);preflights.delete(key);const known=attempts.get(key),data=await readParents('preflight',r,{query:`handle:${plan.namespace}`},options),remote=identity(data);parentState(data,r,{linked:step.kind==='variant_media'&&known?.definite===true});const found=connection(data.collections,1,'COLLECTION_LOOKUP_AMBIGUOUS');if(step.kind==='collection'&&found.length&&(!known?.remoteId||found[0]?.id!==known.remoteId||found[0]?.handle!==plan.namespace))fail('COLLECTION_ALREADY_EXISTS');preflights.set(key,{at:Date.now(),dependenciesHash:hash(r.dependencies)});return {...remote,authorizedKinds:['variant_media','collection'],observedAt:new Date().toISOString()};}
 async function apply(request,options={}){const r=snapshot(request),{step,ids}=validate(r,{attemptRequired:true}),key=keyOf(r),check=preflights.get(key);if(attempts.has(key)||sentSteps.has(step.key))fail('ATTEMPT_ALREADY_SENT');if(!check||Date.now()-check.at>TIMEOUT||check.dependenciesHash!==hash(r.dependencies))fail('FRESH_PREFLIGHT_REQUIRED');attempts.set(key,{status:'unknown'});sentSteps.add(step.key);preflights.delete(key);
  if(step.kind==='variant_media'){const parent=r.dependencies[step.expected.parentKey],variantMedia=step.expected.associations.map(a=>({variantId:gid('ProductVariant',parent.observed.variants.find(v=>v.localId===a.localId).remoteId),mediaIds:[gid('MediaImage',r.dependencies[a.mediaKey].remoteId)]})),data=await graphql('append',{productId:ids[0],variantMedia},options),result=data.productVariantAppendMedia;if(!result||!Array.isArray(result.userErrors)||result.userErrors.length||result.product?.id!==ids[0])fail('APPEND_OUTCOME_UNCONFIRMED');attempts.set(key,{definite:true,remoteId:ids[0],dependenciesHash:hash(r.dependencies)});}
  else{const collection={title:step.expected.title,handle:step.expected.handle,sources:[{source:{title:step.expected.title,targetType:'PRODUCTS',inclusion:{selections:ids.map(productId=>({productId}))}}}]},data=await graphql('create',{collection},options),result=data.collectionCreate;if(!result||!Array.isArray(result.userErrors)||result.userErrors.length||!numeric(result.collection?.id,'Collection'))fail('CREATE_OUTCOME_UNCONFIRMED');attempts.set(key,{definite:true,remoteId:result.collection.id,dependenciesHash:hash(r.dependencies)});}
  return {outcome:'mutation_response_received'};
 }
 async function readback(request,options={}){const r=snapshot(request),{step,ids}=validate(r,{attemptRequired:true,readback:true}),known=attempts.get(keyOf(r)),base={kind:'molyvi_basic_installation_readback',readRequestId:r.readRequestId,shopId:SHOPIFY_BASIC_RELATIONS_SHOP_ID,targetStore:SHOPIFY_BASIC_RELATIONS_STORE,key:step.key,attemptId:r.attemptId,payloadHash:step.payloadHash,observedAt:new Date().toISOString(),correlation:{intentHash:pinned.intentHash,attemptId:r.attemptId,payloadHash:step.payloadHash}};if(!known?.definite)return {...base,outcome:'unknown'};if(known.dependenciesHash!==hash(r.dependencies))fail('DEPENDENCIES_CHANGED');const data=await readParents(step.kind==='variant_media'?'readVariants':'readCollection',r,step.kind==='collection'?{id:known.remoteId}:{},options);identity(data);parentState(data,r,{linked:step.kind==='variant_media'});
  let observed;if(step.kind==='variant_media'){const parent=r.dependencies[step.expected.parentKey],node=data.nodes[0];observed={parentRemoteId:numeric(node.id,'Product'),associations:step.expected.associations.map(a=>{const remote=parent.observed.variants.find(v=>v.localId===a.localId).remoteId,variant=node.variants.nodes.find(v=>v.id===gid('ProductVariant',remote));return {variantRemoteId:numeric(variant.id,'ProductVariant'),mediaRemoteId:numeric(variant.media.nodes[0].id,'MediaImage')};})};}
  else{const c=data.collection;if(!c)return {...base,outcome:'unknown',observedAt:new Date().toISOString()};if(c.id!==known.remoteId||c.title!==step.expected.title||c.handle!==step.expected.handle)fail('COLLECTION_READBACK_MISMATCH');noPublications(c.resourcePublicationsCount);const members=connection(c.products,10,'COLLECTION_MEMBERSHIP_MISMATCH').map(p=>p?.id);if(members.length!==ids.length||new Set(members).size!==ids.length||!equal([...members].sort(),[...ids].sort()))fail('COLLECTION_MEMBERSHIP_MISMATCH');observed={title:c.title,handle:c.handle,productRemoteIds:ids.map(value=>numeric(members.find(v=>v===value),'Product')),channels:[]};}
  return {...base,outcome:'found',remoteId:numeric(known.remoteId,step.kind==='variant_media'?'Product':'Collection'),observed,observedAt:new Date().toISOString()};
 }
 return Object.freeze({supportedKinds:Object.freeze(['variant_media','collection']),preflight:source.guardMethod(preflight),apply:source.guardMethod(apply),readback:source.guardMethod(readback)});
}
