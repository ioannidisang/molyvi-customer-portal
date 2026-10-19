import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {verifyBasicStorePackage} from './basic-store-package.mjs';
import {verifyShopifyThemeProviderBody} from './shopify-theme-provider-body.mjs';

const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
export const SHOPIFY_BASIC_THEME_API_VERSION='2026-10';
export const SHOPIFY_BASIC_THEME_STORE='molyvi-still-dev.myshopify.com';
export const SHOPIFY_BASIC_THEME_SHOP_ID='108668748113';
export const SHOPIFY_BASIC_THEME_SCOPES=Object.freeze(['write_themes','write_files','write_products','write_online_store_pages','read_publications','read_inventory','read_locations']);
const APP='436878311425',INSTALLATION='1195450433873',LIVE='207379235153',LOCATION='125398417745';
const ENDPOINT=`https://${SHOPIFY_BASIC_THEME_STORE}/admin/api/${SHOPIFY_BASIC_THEME_API_VERSION}/graphql.json`;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),md5=v=>crypto.createHash('md5').update(v).digest('hex'),hash=v=>sha(canonicalJson(v)),equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,24}$/.test(v),isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v),gid=(kind,v)=>`gid://shopify/${kind}/${v}`;
const fail=code=>{throw new IntakeError(`SHOPIFY_BASIC_THEME_${code}`,422);};
const MAX_ZIP=32*1024*1024,MAX_TOTAL=64*1024*1024,MAX_FILE=8*1024*1024,MAX_FILES=1500,TIMEOUT=30_000;
const folders=new Set(['assets','config','layout','locales','sections','snippets','templates','blocks']);
const IDENTITY=`shop { id myshopifyDomain currencyCode }
 currentAppInstallation { id app { id } accessScopes { handle } }
 themes(first:2,roles:[MAIN]) { nodes { id role } pageInfo { hasNextPage } }`;
const STATE='id name role processing processingFailed';
export const SHOPIFY_BASIC_THEME_OPERATIONS=Object.freeze({
 preflight:`query MolyviBasicThemePreflight { ${IDENTITY} }`,
 product:`query MolyviBasicThemeProduct($id:ID!,$locationId:ID!,$variantLimit:Int!) { ${IDENTITY} location(id:$locationId) { id isActive fulfillsOnlineOrders } product(id:$id) { id handle title descriptionHtml vendor productType status options(first:3) { name } resourcePublicationsCount(onlyPublished:false) { count precision } variants(first:$variantLimit) { nodes { id sku price inventoryPolicy selectedOptions { name value } inventoryItem { id sku tracked requiresShipping measurement { weight { unit value } } inventoryLevels(first:2) { nodes { location { id } quantities(names:["available"]) { name quantity } } pageInfo { hasNextPage } } } media(first:2) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } media(first:31) { nodes { id alt mediaContentType status } pageInfo { hasNextPage } } } }`,
 page:`query MolyviBasicThemePage($id:ID!) { ${IDENTITY} page(id:$id) { id title handle body isPublished } }`,
 collection:`query MolyviBasicThemeCollection($id:ID!) { ${IDENTITY} collection(id:$id) { id title handle resourcePublicationsCount(onlyPublished:false) { count precision } products(first:11) { nodes { id } pageInfo { hasNextPage } } } }`,
 stage:`mutation MolyviBasicThemeStage($input:[StagedUploadInput!]!) { stagedUploadsCreate(input:$input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
 create:`mutation MolyviBasicThemeCreate($source:URL!,$name:String!) { themeCreate(source:$source,name:$name,role:UNPUBLISHED) { theme { ${STATE} } userErrors { code field message } } }`,
 state:`query MolyviBasicThemeState($id:ID!) { ${IDENTITY} theme(id:$id) { ${STATE} } }`,
 files:`query MolyviBasicThemeFiles($id:ID!,$after:String) { ${IDENTITY} theme(id:$id) { ${STATE} files(first:50,after:$after) { nodes { filename size checksumMd5 body { __typename ... on OnlineStoreThemeFileBodyText { content } ... on OnlineStoreThemeFileBodyBase64 { contentBase64 } ... on OnlineStoreThemeFileBodyUrl { url } } } pageInfo { hasNextPage endCursor } userErrors { code filename } } } }`
});

function abortable(promise,signal){
 if(signal.aborted)return Promise.reject(new IntakeError('SHOPIFY_BASIC_THEME_REQUEST_ABORTED',422));
 return new Promise((resolve,reject)=>{const abort=()=>reject(new IntakeError('SHOPIFY_BASIC_THEME_REQUEST_ABORTED',422));signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
async function body(response,signal,limit){
 if(!response?.ok||response.redirected||response.status<200||response.status>=300)fail('HTTP_UNCONFIRMED');
 const stated=response.headers?.get('content-length');if(stated!=null&&(!/^\d+$/.test(stated)||Number(stated)>limit))fail('RESPONSE_TOO_LARGE');
 if(!response.body?.getReader){if(response.status===204||stated==='0')return Buffer.alloc(0);fail('RESPONSE_INVALID');}
 const reader=response.body.getReader(),parts=[];let size=0;
 try{while(true){const item=await abortable(reader.read(),signal);if(item.done)break;if(!(item.value instanceof Uint8Array)||(size+=item.value.byteLength)>limit)fail('RESPONSE_TOO_LARGE');parts.push(Buffer.from(item.value));}}
 finally{try{void reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
 return Buffer.concat(parts,size);
}
function safeUrl(value,kind){
 let url;try{url=new URL(value);}catch{fail('UNSAFE_URL');}
 if(typeof value!=='string'||/[\x00-\x20\\]/.test(value)||url.protocol!=='https:'||url.port||url.username||url.password||url.hash)fail('UNSAFE_URL');
 const staged=url.hostname==='shopify-staged-uploads.storage.googleapis.com';
 const cdn=url.hostname==='cdn.shopify.com'&&url.pathname.startsWith('/s/files/');
 if(kind==='stage'?!staged:!cdn)fail('UNSAFE_URL');
 return url.href;
}
function expectedCatalog(p){return {handle:p.handle,title:p.title,descriptionHtmlSha256:sha(p.descriptionHtml),vendor:p.vendor,productType:p.type,optionNames:p.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId:LOCATION,variants:p.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};}
function cents(value){if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))fail('REMOTE_VARIANT_MISMATCH');const [whole,fraction='']=value.split('.'),minor=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(minor>BigInt(Number.MAX_SAFE_INTEGER))fail('REMOTE_VARIANT_MISMATCH');return Number(minor);}
function fileSize(value){if(typeof value==='string'&&/^(?:0|[1-9]\d*)$/.test(value)&&value.length<16)value=Number(value);if(!Number.isSafeInteger(value)||value<0||value>MAX_FILE)fail('FILE_READBACK_MISMATCH');return value;}
function makeDependencies(plan){
 const result=[];const add=(key,kind,expected,dependsOn=[])=>result.push({key,kind,action:kind==='variant_media'?'link_new_resources':'create',expected,payloadHash:hash(expected),dependsOn});
 for(const p of plan.products){const parent=`catalog:${p.productId}`;add(parent,'catalog',expectedCatalog(p));for(const photo of p.photos)add(`media:${p.productId}:${photo.position}`,'media',{parentKey:parent,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt},[parent]);add(`variant_media:${p.productId}`,'variant_media',{parentKey:parent,associations:p.variants.map(v=>({localId:v.id,mediaKey:`media:${p.productId}:${v.imagePosition}`}))},[parent,...p.photos.map(photo=>`media:${p.productId}:${photo.position}`)]);}
 add('collection','collection',{title:plan.branding.brandName,handle:plan.namespace,productKeys:plan.products.map(p=>`catalog:${p.productId}`),channels:[]},result.filter(s=>s.kind==='catalog').map(s=>s.key));
 for(const page of plan.pages)add(`page:${page.documentId}`,'page',{title:page.title,handle:page.handle,bodySha256:page.bodySha256,visibility:'Hidden'});
 return result;
}

/** Create-only Draft theme adapter. A durable runner must own the one-attempt
 * claim. Staged ZIP bytes are sent once; one themeCreate is the only theme write.
 * No update, publication, deletion, retry, name adoption or credential discovery.
 * ZIP SHA identifies uploaded source, not a remote ZIP. Fresh readback verifies
 * each source against returned bodies and stored metadata separately. Two exact
 * provider comment headers and four source-hashed template transformations have
 * explicit proof categories. LICENSE.md is source-only metadata that Shopify
 * may omit; no other omission or arbitrary normalization is accepted.
 * Durable progress is optional; when supplied it owns cumulative budgets and
 * the definite returned ID across restarts. Network remains OFF by default.
 */
export function createShopifyBasicThemeTransport({prepared,theme,binding,liveThemeId,accessToken,fetchImpl,uploadFetch,networkEnabled=false}={}){
 verifyBasicStorePackage(prepared);
 const plan=structuredClone(prepared.plan),pinned=structuredClone(binding),manifest=structuredClone(theme?.manifest),zipBytes=Buffer.isBuffer(theme?.zipBytes)?Buffer.from(theme.zipBytes):null;
 const uploads=prepared.uploads.map(u=>({fileName:u.fileName,sha256:sha(u.bytes),bytes:u.bytes.length}));
 if(!pinned||!equal(Object.keys(pinned).sort(),['intentHash','targetStore','projectId','ownerHash','planHash','themeZipSha256','packageBytesHash'].sort())||!isHash(pinned.intentHash)||pinned.targetStore!==SHOPIFY_BASIC_THEME_STORE||plan.targetStore!==pinned.targetStore||plan.projectId!==pinned.projectId||plan.binding.ownerHash!==pinned.ownerHash||plan.planHash!==pinned.planHash||pinned.packageBytesHash!==hash({plan,uploads})||liveThemeId!==LIVE)fail('BINDING_MISMATCH');
 if(!zipBytes||zipBytes.length>MAX_ZIP||sha(zipBytes)!==pinned.themeZipSha256||manifest?.kind!=='molyvi_basic_theme_package'||manifest.schemaVersion!==1||manifest.planHash!==plan.planHash||manifest.projectId!==plan.projectId||manifest.targetStore!==plan.targetStore||manifest.applicationAuthorized!==false||manifest.publicationAuthorized!==false||manifest.status!=='UNPUBLISHED_NOT_APPLIED'||manifest.zip?.bytes!==zipBytes.length||manifest.zip.sha256!==pinned.themeZipSha256||!Array.isArray(manifest.files))fail('THEME_MISMATCH');
 if(!equal(manifest.resources?.counts,plan.counts)||manifest.resources?.collectionHandle!==plan.namespace||!equal(manifest.resources?.pages,plan.pages.map(({documentId,handle})=>({documentId,handle}))))fail('THEME_RESOURCES_MISMATCH');
 if(typeof fetchImpl!=='function'||typeof uploadFetch!=='function'||typeof networkEnabled!=='boolean')fail('TRANSPORT_CONFIGURATION_INVALID');
 if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>2048||!(/^[\x21-\x7e]+$/).test(accessToken))fail('CREDENTIAL_REQUIRED');
 const dependencies=makeDependencies(plan),expected={zipSha256:pinned.themeZipSha256,status:'Draft'},step={key:'theme',kind:'theme',action:'create',expected,payloadHash:hash(expected),dependsOn:dependencies.map(s=>s.key)},name=`Molyvi Basic ${plan.projectId}`;
 const attempts=new Map(),preflights=new Map();let sent=false,sourcePromise,requestCount=0,externalCount=0;
 const key=r=>r.attemptId??'before-claim';
 async function progressState(r,options){
  const progress=options.themeProgress;if(progress===undefined)return null;
  if(!r.attemptId||!progress||!['read','reserve','recordCreated','scheduleCheck'].every(k=>typeof progress[k]==='function'))fail('PROGRESS_CONTROL_INVALID');
  const state=await progress.read(),expectedBinding={...pinned,shopId:SHOPIFY_BASIC_THEME_SHOP_ID,appId:APP,installId:INSTALLATION,liveThemeId:LIVE};
  if(!state||!equal(state.binding,expectedBinding)||state.attemptId!==r.attemptId||state.dependenciesHash!==hash(r.dependencies)||!['started','created','checking','waiting','verified','complete','stopped'].includes(state.status)||state.themeId!==null&&(!id(state.themeId)||state.themeId===LIVE))fail('PROGRESS_BINDING_MISMATCH');
  if(state.status==='stopped')fail('PROGRESS_STOPPED');
  return state;
 }
 async function knownTheme(r,options){
  const state=await progressState(r,options);if(options.themeProgress)return state?.themeId?{uploaded:true,remoteId:gid('OnlineStoreTheme',state.themeId)}:null;
  return attempts.get(key(r));
 }
 async function source(){
  if(!sourcePromise)sourcePromise=(async()=>{
   let archive;try{archive=await JSZip.loadAsync(zipBytes);}catch{fail('ZIP_INVALID');}
   const declared=manifest.files.filter(f=>typeof f.file==='string'&&!f.file.split('/').some(p=>p.startsWith('.'))),entries=Object.values(archive.files).filter(f=>!f.dir);
   if(declared.length<4||declared.length>MAX_FILES||entries.length!==declared.length||new Set(declared.map(f=>f.file)).size!==declared.length)fail('ZIP_INVALID');
   const files=new Map();let total=0;
   for(const f of declared){
    const parts=f.file.split('/');if(f.file.includes('\\')||parts.some(p=>!p||p==='..'||p==='.')||(f.file!=='LICENSE.md'&&(!folders.has(parts[0])||parts.length<2))||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>MAX_FILE||(total+=f.bytes)>MAX_TOTAL||!isHash(f.sha256))fail('ZIP_INVALID');
    const entry=archive.file(f.file);if(!entry||entry._data?.uncompressedSize!==f.bytes||entry.unsafeOriginalName!==undefined&&entry.unsafeOriginalName!==f.file)fail('ZIP_INVALID');
    const bytes=await entry.async('nodebuffer');if(bytes.length!==f.bytes||sha(bytes)!==f.sha256)fail('ZIP_INVALID');files.set(f.file,{...f,bytes,md5:md5(bytes)});
   }
   if(files.get('LICENSE.md')?.sha256!=='189bbb2c31786bdbaa2c6b02a4cb8f8308e1303b176e0955658a26bc90154034'||manifest.upstream?.licenseSha256!==files.get('LICENSE.md').sha256)fail('LICENSE_MISMATCH');
   const nav=files.get('snippets/molyvi-basic-navigation.liquid')?.bytes.toString('utf8');let index;try{index=JSON.parse(files.get('templates/index.json')?.bytes.toString('utf8'));}catch{fail('THEME_LINKS_MISMATCH');}
   if(!files.has('layout/theme.liquid')||!nav||!nav.includes(`{{ routes.collections_url }}/${plan.namespace}`)||plan.pages.some(p=>!nav.includes(`/pages/${p.handle}`))||index?.sections?.featured_collection?.settings?.collection!==plan.namespace||index?.sections?.forma_hero?.settings?.link!==`shopify://collections/${plan.namespace}`)fail('THEME_LINKS_MISMATCH');
   const hero=files.get(manifest.hero?.file);if(!hero||hero.sha256!==manifest.hero.sha256||!uploads.some(u=>u.fileName===manifest.hero.sourceFile&&u.sha256===hero.sha256))fail('THEME_HERO_MISMATCH');
   return files;
  })();
  return sourcePromise;
 }
 function validate(r,{attempt=false,read=false}={}){
  if(!r||!equal(r.binding,pinned)||!equal(r.trustedShop,{shopId:SHOPIFY_BASIC_THEME_SHOP_ID,targetStore:SHOPIFY_BASIC_THEME_STORE})||!equal(r.step,step))fail('REQUEST_BINDING_MISMATCH');
  if(attempt&&!uuid(r.attemptId)||r.attemptId!=null&&!uuid(r.attemptId))fail('ATTEMPT_REQUIRED');
  if(read&&(!uuid(r.readRequestId)||!['after_apply','reconcile'].includes(r.mode)))fail('READBACK_REQUEST_INVALID');
  if(!r.dependencies||!equal(Object.keys(r.dependencies).sort(),step.dependsOn.toSorted()))fail('DEPENDENCIES_REQUIRED');
  const seen=new Set();
  for(const d of dependencies){const receipt=r.dependencies[d.key];if(!receipt||!id(receipt.remoteId)||receipt.payloadHash!==d.payloadHash)fail('DEPENDENCY_RECEIPT_MISMATCH');
   let observed=d.expected;
   if(d.kind==='catalog'){const variants=receipt.observed?.variants;if(!Array.isArray(variants)||variants.length!==d.expected.variants.length||new Set(variants.map(v=>v.remoteId)).size!==variants.length||variants.some((v,i)=>!id(v.remoteId)||!equal(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='remoteId')),d.expected.variants[i])))fail('DEPENDENCY_RECEIPT_MISMATCH');observed={...d.expected,variants};}
   if(d.kind==='media')observed={parentRemoteId:r.dependencies[d.expected.parentKey].remoteId,position:d.expected.position,sourceSha256:d.expected.sourceSha256,alt:d.expected.alt,loaded:true};
   if(d.kind==='variant_media'){const parent=r.dependencies[d.expected.parentKey];if(receipt.remoteId!==parent.remoteId)fail('DEPENDENCY_RECEIPT_MISMATCH');observed={parentRemoteId:parent.remoteId,associations:d.expected.associations.map(a=>({variantRemoteId:parent.observed.variants.find(v=>v.localId===a.localId)?.remoteId,mediaRemoteId:r.dependencies[a.mediaKey]?.remoteId}))};}
   if(d.kind==='collection')observed={title:d.expected.title,handle:d.expected.handle,productRemoteIds:d.expected.productKeys.map(k=>r.dependencies[k].remoteId),channels:[]};
   if(!equal(receipt.observed,observed))fail('DEPENDENCY_RECEIPT_MISMATCH');
   const typed=`${d.kind}:${receipt.remoteId}`;if(seen.has(typed))fail('DEPENDENCY_ID_CONFLICT');seen.add(typed);
  }
 }
 function identity(data){
  if(data.shop?.id!==gid('Shop',SHOPIFY_BASIC_THEME_SHOP_ID)||data.shop.myshopifyDomain!==SHOPIFY_BASIC_THEME_STORE||data.shop.currencyCode!=='EUR'||data.currentAppInstallation?.app?.id!==gid('App',APP)||data.currentAppInstallation?.id!==gid('AppInstallation',INSTALLATION))fail('REMOTE_SHOP_OR_APP_MISMATCH');
  const scopes=data.currentAppInstallation.accessScopes;if(!Array.isArray(scopes)||!SHOPIFY_BASIC_THEME_SCOPES.every(s=>scopes.some(v=>v.handle===s)))fail('REQUIRED_SCOPES_MISSING');
  if(data.themes?.pageInfo?.hasNextPage!==false||!equal(data.themes.nodes,[{id:gid('OnlineStoreTheme',LIVE),role:'MAIN'}]))fail('LIVE_THEME_CHANGED');
 }
 async function guarded(work,signal){
  if(!networkEnabled)fail('NETWORK_DISABLED');const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT)]):AbortSignal.timeout(TIMEOUT);
  try{return await work(combined);}catch(error){if(error instanceof IntakeError&&error.code?.startsWith('SHOPIFY_BASIC_THEME_'))throw error;fail(combined.aborted?'REQUEST_ABORTED':'REQUEST_FAILED');}
 }
 async function graphql(operation,variables,options={}){
  if(options.themeProgress)await options.themeProgress.reserve(operation==='create'?'theme_create':'graphql');
  return guarded(async signal=>{
  if(++requestCount>160)fail('REQUEST_BUDGET_EXHAUSTED');const payload=JSON.stringify({query:SHOPIFY_BASIC_THEME_OPERATIONS[operation],variables});if(Buffer.byteLength(payload)>128*1024)fail('REQUEST_TOO_LARGE');
  const response=await abortable(fetchImpl(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-Shopify-Access-Token':accessToken},body:payload,redirect:'error',credentials:'omit',cache:'no-store',signal}),signal);
  if(response.url&&response.url!==ENDPOINT)fail('RESPONSE_ORIGIN_MISMATCH');if(response.headers?.get('x-shopify-api-version')!==SHOPIFY_BASIC_THEME_API_VERSION)fail('API_VERSION_MISMATCH');if(!/^application\/json(?:;|$)/i.test(response.headers?.get('content-type')??''))fail('RESPONSE_CONTENT_TYPE');
  const bytes=await body(response,signal,16*1024*1024);let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('INVALID_JSON');}if(value.errors?.length||!value.data||typeof value.data!=='object')fail('GRAPHQL_UNCONFIRMED');return value.data;
 },options.signal);}
 const noPublication=value=>equal(value,{count:0,precision:'EXACT'});
 async function remoteDependencies(r,options){
  for(const p of plan.products){const receipt=r.dependencies[`catalog:${p.productId}`],data=await graphql('product',{id:gid('Product',receipt.remoteId),locationId:gid('Location',LOCATION),variantLimit:p.variants.length},options);identity(data);const actual=data.product;
   if(!equal(data.location,{id:gid('Location',LOCATION),isActive:true,fulfillsOnlineOrders:true})||actual?.id!==gid('Product',receipt.remoteId)||actual.status!=='DRAFT'||actual.handle!==p.handle||actual.title!==p.title||actual.vendor!==p.vendor||actual.productType!==p.type||!equal(actual.options?.map(o=>o.name),p.optionNames)||typeof actual.descriptionHtml!=='string'||sha(actual.descriptionHtml)!==sha(p.descriptionHtml)||!noPublication(actual.resourcePublicationsCount)||actual.variants?.pageInfo?.hasNextPage!==false||actual.variants.nodes?.length!==p.variants.length||actual.media?.pageInfo?.hasNextPage!==false||actual.media.nodes?.length!==p.photos.length)fail('REMOTE_PRODUCT_MISMATCH');
   for(const [i,photo]of p.photos.entries()){const m=actual.media.nodes[i],expected=r.dependencies[`media:${p.productId}:${photo.position}`];if(m?.id!==gid('MediaImage',expected.remoteId)||m.alt!==photo.alt||m.status!=='READY'||m.mediaContentType!=='IMAGE')fail('REMOTE_MEDIA_MISMATCH');}
   for(const v of receipt.observed.variants){const actualVariant=actual.variants.nodes.find(a=>a.id===gid('ProductVariant',v.remoteId));if(!actualVariant||actualVariant.sku!==(v.sku??'')||cents(actualVariant.price)!==v.priceMinor||actualVariant.inventoryPolicy!=='DENY'||!equal(actualVariant.selectedOptions,p.optionNames.map((name,i)=>({name,value:v.optionValues[i]})))||actualVariant.media?.pageInfo?.hasNextPage!==false||!equal(actualVariant.media.nodes,[{id:gid('MediaImage',r.dependencies[`media:${p.productId}:${v.imagePosition}`].remoteId)}]))fail('REMOTE_VARIANT_MISMATCH');
    const inv=actualVariant.inventoryItem,weight=inv?.measurement?.weight,levels=inv?.inventoryLevels;
    if(inv?.sku!==(v.sku??'')||inv.tracked!==true||inv.requiresShipping!==true||(v.weightGrams===null?weight!==null:weight?.unit!=='GRAMS'||weight.value!==v.weightGrams)||levels?.pageInfo?.hasNextPage!==false||!equal(levels.nodes,[{location:{id:gid('Location',LOCATION)},quantities:[{name:'available',quantity:v.stock}]}]))fail('REMOTE_INVENTORY_MISMATCH');
   }
  }
  for(const p of plan.pages){const data=await graphql('page',{id:gid('Page',r.dependencies[`page:${p.documentId}`].remoteId)},options);identity(data);if(data.page?.id!==gid('Page',r.dependencies[`page:${p.documentId}`].remoteId)||data.page.handle!==p.handle||data.page.title!==p.title||data.page.isPublished!==false||typeof data.page.body!=='string'||sha(data.page.body)!==p.bodySha256)fail('REMOTE_PAGE_MISMATCH');}
  const collection=r.dependencies.collection,data=await graphql('collection',{id:gid('Collection',collection.remoteId)},options);identity(data);const c=data.collection;
  if(c?.id!==gid('Collection',collection.remoteId)||c.handle!==plan.namespace||c.title!==plan.branding.brandName||!noPublication(c.resourcePublicationsCount)||c.products?.pageInfo?.hasNextPage!==false||!equal(c.products.nodes.map(p=>p.id).sort(),collection.observed.productRemoteIds.map(v=>gid('Product',v)).sort()))fail('REMOTE_COLLECTION_MISMATCH');
 }
 function themeState(data,remoteId,{ready=false}={}){
  identity(data);const t=data.theme;if(!t||t.id!==remoteId||t.id===gid('OnlineStoreTheme',LIVE)||t.name!==name||t.role!=='UNPUBLISHED'||typeof t.processing!=='boolean'||t.processingFailed!==false)fail('REMOTE_THEME_MISMATCH');
  if(ready&&t.processing)fail('THEME_STILL_PROCESSING');return !t.processing;
 }
 async function preflight(input,options={}){
  const r=structuredClone(input);validate(r);preflights.delete(key(r));const known=await knownTheme(r,options);await source();identity(await graphql('preflight',{},options));await remoteDependencies(r,options);
  if(known?.remoteId)themeState(await graphql('state',{id:known.remoteId},options),known.remoteId);
  preflights.set(key(r),Date.now());return {shopId:SHOPIFY_BASIC_THEME_SHOP_ID,targetStore:SHOPIFY_BASIC_THEME_STORE,currency:'EUR',authorizedKinds:['theme'],observedAt:new Date().toISOString()};
 }
 async function apply(input,options={}){
  const r=structuredClone(input);validate(r,{attempt:true});if(sent||attempts.has(key(r)))fail('ATTEMPT_ALREADY_SENT');if(!preflights.has(key(r))||Date.now()-preflights.get(key(r))>TIMEOUT)fail('FRESH_PREFLIGHT_REQUIRED');await source();
  const persisted=await progressState(r,options);if(persisted&&(persisted.themeId||persisted.counters.stagedUploads||persisted.counters.themeCreateAttempts))fail('ATTEMPT_ALREADY_SENT');
  const known={uploaded:false,remoteId:null};sent=true;attempts.set(key(r),known);preflights.delete(key(r));
  const filename=`molyvi-basic-${pinned.themeZipSha256}.zip`,d=await graphql('stage',{input:[{filename,mimeType:'application/zip',httpMethod:'POST',resource:'FILE',fileSize:String(zipBytes.length)}]},options),s=d.stagedUploadsCreate;
  if(!s||!Array.isArray(s.userErrors)||s.userErrors.length||s.stagedTargets?.length!==1)fail('STAGING_UNCONFIRMED');const target=s.stagedTargets[0],uploadUrl=safeUrl(target.url,'stage'),resourceUrl=safeUrl(target.resourceUrl,'stage');
  if(!Array.isArray(target.parameters)||target.parameters.length<2||target.parameters.length>20||new Set(target.parameters.map(p=>p.name)).size!==target.parameters.length)fail('UNSAFE_UPLOAD_PARAMETERS');
  const form=new FormData();for(const p of target.parameters){if(typeof p.name!=='string'||!(/^(?:key|policy|acl|success_action_status|Content-Type|x-goog-[a-z0-9-]+|GoogleAccessId|signature)$/).test(p.name)||typeof p.value!=='string'||p.value.length>16_384||/[\x00-\x1f]/.test(p.value))fail('UNSAFE_UPLOAD_PARAMETERS');form.append(p.name,p.value);}
  const uploadKey=target.parameters.find(p=>p.name==='key')?.value;let resourcePath;try{resourcePath=decodeURIComponent(new URL(resourceUrl).pathname);}catch{fail('UNSAFE_UPLOAD_PARAMETERS');}
  if(target.parameters.find(p=>p.name==='Content-Type')?.value!=='application/zip'||typeof uploadKey!=='string'||!uploadKey.endsWith(`/${filename}`)||uploadKey.startsWith('/')||uploadKey.includes('..')||resourcePath!==`/${uploadKey}`)fail('UNSAFE_UPLOAD_PARAMETERS');
  form.append('file',new Blob([zipBytes],{type:'application/zip'}),filename);
  if(options.themeProgress)await options.themeProgress.reserve('staged_upload');
  await guarded(async signal=>{externalCount++;const response=await abortable(uploadFetch(uploadUrl,{method:'POST',body:form,redirect:'error',credentials:'omit',cache:'no-store',signal}),signal);if(response.url&&response.url!==uploadUrl)fail('UPLOAD_ORIGIN_MISMATCH');await body(response,signal,64*1024);},options.signal);known.uploaded=true;
  // The staged upload might have taken time. Recheck the live sentinel directly
  // before the single create, rather than relying on the earlier timestamp.
  identity(await graphql('preflight',{},options));
  const created=await graphql('create',{source:resourceUrl,name},options),c=created.themeCreate;
  if(!c||!Array.isArray(c.userErrors)||c.userErrors.length||!/^gid:\/\/shopify\/OnlineStoreTheme\/[1-9][0-9]{0,24}$/.test(c.theme?.id)||c.theme.id===gid('OnlineStoreTheme',LIVE)||c.theme.name!==name||c.theme.role!=='UNPUBLISHED'||typeof c.theme.processing!=='boolean'||c.theme.processingFailed!==false)fail('CREATE_OUTCOME_UNCONFIRMED');
  if(options.themeProgress)await options.themeProgress.recordCreated({themeId:c.theme.id.split('/').at(-1),responseSha256:hash(c)});
  known.remoteId=c.theme.id;
  return {outcome:'draft_theme_create_response_received'};
 }
 async function readback(input,options={}){
  const r=structuredClone(input);validate(r,{attempt:true,read:true});const known=await knownTheme(r,options),base={kind:'molyvi_basic_installation_readback',readRequestId:r.readRequestId,shopId:SHOPIFY_BASIC_THEME_SHOP_ID,targetStore:SHOPIFY_BASIC_THEME_STORE,key:'theme',attemptId:r.attemptId,payloadHash:step.payloadHash,correlation:{intentHash:pinned.intentHash,attemptId:r.attemptId,payloadHash:step.payloadHash},observedAt:new Date().toISOString()};
  if(!known?.remoteId||!known.uploaded)return {...base,outcome:'unknown'};
  const originals=await source();let ready=false;
  if(options.themeProgress)await options.themeProgress.reserve('read_check');
  if(options.themeProgress){
   ready=themeState(await graphql('state',{id:known.remoteId},options),known.remoteId);
   if(!ready){const waiting=await options.themeProgress.scheduleCheck();return {...base,outcome:'pending',reason:'theme_processing',remoteId:known.remoteId.split('/').at(-1),nextCheckAt:waiting.nextEligibleAt,deadlineAt:waiting.deadlineAt,counters:structuredClone(waiting.counters),observedAt:new Date().toISOString()};}
  }else for(let n=0;n<8;n++){const d=await graphql('state',{id:known.remoteId},options);if(themeState(d,known.remoteId)){ready=true;break;}if(n<7)await guarded(signal=>abortable(new Promise(resolve=>setTimeout(resolve,500)),signal),options.signal);}
  if(!ready)fail('PROCESSING_PENDING_NO_RETRY');
  identity(await graphql('preflight',{},options));await remoteDependencies(r,options);
  const observedFiles=[],seen=new Set(),cursors=new Set();let after=null,total=0,storedTotal=0,done=false;
  for(let batch=0;batch<32;batch++){
   const data=await graphql('files',{id:known.remoteId,after},options);themeState(data,known.remoteId,{ready:true});const list=data.theme.files;
   if(!Array.isArray(list?.nodes)||list.nodes.length>50||typeof list.pageInfo?.hasNextPage!=='boolean'||!Array.isArray(list.userErrors)||list.userErrors.length)fail('FILES_READBACK_INVALID');
   for(const f of list.nodes){const expectedFile=originals.get(f.filename);if(!expectedFile||seen.has(f.filename)||seen.size>=MAX_FILES)fail('FILE_READBACK_MISMATCH');fileSize(f.size);seen.add(f.filename);let bytes;
    if(f.body?.__typename==='OnlineStoreThemeFileBodyText'&&typeof f.body.content==='string')bytes=Buffer.from(f.body.content,'utf8');
    else if(f.body?.__typename==='OnlineStoreThemeFileBodyBase64'&&typeof f.body.contentBase64==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.body.contentBase64))bytes=Buffer.from(f.body.contentBase64,'base64');
    else if(f.body?.__typename==='OnlineStoreThemeFileBodyUrl'){
     const url=safeUrl(f.body.url,'cdn');if(++externalCount>256)fail('ASSET_REQUEST_BUDGET_EXHAUSTED');if(options.themeProgress)await options.themeProgress.reserve('external_read');bytes=await guarded(async signal=>{const response=await abortable(uploadFetch(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal}),signal);if(response.url&&response.url!==url)fail('FILE_URL_ORIGIN_MISMATCH');return body(response,signal,MAX_FILE);},options.signal);
    }else fail('FILE_BODY_INVALID');
    const proof=verifyShopifyThemeProviderBody({filename:f.filename,bodyType:f.body.__typename,sourceBytes:expectedFile.bytes,rawBytes:bytes,providerSize:f.size,providerMd5:f.checksumMd5});
    if((total+=bytes.length)>MAX_TOTAL||(storedTotal+=proof.verifiedStoredBytes)>MAX_TOTAL)fail('FILE_READBACK_MISMATCH');
    observedFiles.push({...proof,bytes:bytes.length,sha256:proof.returnedBodySha256,computedMd5:proof.returnedBodyMd5,remoteChecksumMd5:f.checksumMd5});
   }
   if(!list.pageInfo.hasNextPage){done=true;break;}
   const cursor=list.pageInfo.endCursor;if(!list.nodes.length||typeof cursor!=='string'||!cursor||cursor.length>2048||cursors.has(cursor))fail('FILE_PAGINATION_INVALID');cursors.add(cursor);after=cursor;
  }
  if(!done||[...originals.keys()].some(file=>file!=='LICENSE.md'&&!seen.has(file)))fail('FILE_READBACK_INCOMPLETE');
  identity(await graphql('preflight',{},options));await remoteDependencies(r,options);
  const exactRawFiles=observedFiles.filter(f=>f.rawBodyEqualsSource).length,reviewedTransformedFiles=observedFiles.filter(f=>f.narrowProviderTransformationApplied).length,headerOnlyFiles=observedFiles.length-exactRawFiles-reviewedTransformedFiles;
  return {...base,outcome:'found',remoteId:known.remoteId.split('/').at(-1),observed:{zipSha256:pinned.themeZipSha256,status:'Draft',liveThemeIdUnchanged:LIVE},provenance:{kind:'staged_source_zip_then_definite_theme_id',sourceZipSha256:pinned.themeZipSha256,sourceZipBytes:zipBytes.length,sourceManifestHash:hash(manifest),remoteFiles:observedFiles.sort((a,b)=>a.file.localeCompare(b.file)),remoteBytes:total,verifiedStoredBytes:storedTotal,exactRawFiles,headerOnlyFiles,reviewedTransformedFiles,sourceOnlyFiles:seen.has('LICENSE.md')?[]:[{file:'LICENSE.md',sha256:originals.get('LICENSE.md').sha256,reason:'source_license_not_a_shopify_theme_directory'}],generalNormalizationAccepted:false,byteNormalizationAccepted:reviewedTransformedFiles>0,reviewedProviderTransformationApplied:reviewedTransformedFiles>0,sourceByteEqualityClaimedForAllFiles:reviewedTransformedFiles===0,rawByteEqualityClaimedForAllFiles:exactRawFiles===observedFiles.length,remoteZipEqualityClaimed:false,visualRuntimeVerified:false},observedAt:new Date().toISOString()};
 }
 return Object.freeze({supportedKinds:Object.freeze(['theme']),themeProcessing:'durable_v1',preflight,apply,readback});
}
