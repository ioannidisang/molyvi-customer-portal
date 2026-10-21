import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {createBasicInstallationSource} from './basic-installation-source.mjs';

export const SHOPIFY_BASIC_MEDIA_API_VERSION='2026-10';
export const SHOPIFY_BASIC_MEDIA_STORE='molyvi-still-dev.myshopify.com';
export const SHOPIFY_BASIC_MEDIA_SHOP_ID='108668748113';
export const SHOPIFY_BASIC_MEDIA_APP_ID='436878311425';
export const SHOPIFY_BASIC_MEDIA_INSTALLATION_ID='1195450433873';
export const SHOPIFY_BASIC_MEDIA_INVENTORY_LOCATION_ID='125398417745';
export const SHOPIFY_BASIC_MEDIA_SCOPES=Object.freeze(['write_files','write_products','read_themes','read_publications']);
const ENDPOINT=`https://${SHOPIFY_BASIC_MEDIA_STORE}/admin/api/${SHOPIFY_BASIC_MEDIA_API_VERSION}/graphql.json`;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonicalJson(v));
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b),id=v=>typeof v==='string'&&/^[1-9][0-9]{0,24}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v),isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const gid=(kind,value)=>`gid://shopify/${kind}/${value}`,fail=code=>{throw new IntakeError(`SHOPIFY_BASIC_MEDIA_${code}`,422);};
const priceMinor=value=>{if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))return null;const [whole,decimal='']=value.split('.'),minor=BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0'));return minor<=BigInt(Number.MAX_SAFE_INTEGER)?Number(minor):null;};
const MAX_BYTES=16*1024*1024,TIMEOUT_MS=30_000;
const IDENTITY=`shop { id myshopifyDomain currencyCode }
 currentAppInstallation { id app { id } accessScopes { handle } }
 themes(first:2, roles:[MAIN]) { nodes { id role } pageInfo { hasNextPage } }`;
const PRODUCT=`id handle title descriptionHtml vendor productType status options { name }
 resourcePublicationsCount(onlyPublished:false) { count precision }
 variants(first:100) { nodes { id sku price selectedOptions { name value } } pageInfo { hasNextPage } }
 media(first:31) { nodes { id alt mediaContentType status ... on MediaImage { fileStatus image { url width height } } } pageInfo { hasNextPage } }`;
export const SHOPIFY_BASIC_MEDIA_OPERATIONS=Object.freeze({
 preflight:`query MolyviBasicMediaPreflight($id:ID!) { ${IDENTITY} product(id:$id) { ${PRODUCT} } }`,
 stage:`mutation MolyviBasicMediaStage($input:[StagedUploadInput!]!) { stagedUploadsCreate(input:$input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
 create:`mutation MolyviBasicMediaCreate($files:[FileCreateInput!]!) { fileCreate(files:$files) { files { id } userErrors { field message code } } }`,
 processing:`query MolyviBasicMediaProcessing($id:ID!) { ${IDENTITY} node(id:$id) { ... on MediaImage { id fileStatus alt image { url width height } } } }`,
 attach:`mutation MolyviBasicMediaAttach($files:[FileUpdateInput!]!) { fileUpdate(files:$files) { files { id } userErrors { field message code } } }`,
 readback:`query MolyviBasicMediaReadback($id:ID!) { ${IDENTITY} product(id:$id) { ${PRODUCT} } }`
});

async function boundedBody(response,signal,limit){
 if(!response?.ok||response.redirected||response.status<200||response.status>=300)fail('HTTP_UNCONFIRMED');
 const size=response.headers?.get('content-length');if(size!==null&&size!==undefined&&(!/^\d+$/.test(size)||Number(size)>limit))fail('RESPONSE_TOO_LARGE');
 if(!response.body?.getReader){if(response.status===204||size==='0')return Buffer.alloc(0);fail('RESPONSE_INVALID');}
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{while(true){const item=await abortable(reader.read(),signal);if(item.done)break;length+=item.value.byteLength;if(length>limit)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(item.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 return Buffer.concat(chunks,length);
}
function abortable(promise,signal){
 if(signal.aborted)return Promise.reject(new IntakeError('SHOPIFY_BASIC_MEDIA_REQUEST_ABORTED',422));
 return new Promise((resolve,reject)=>{const abort=()=>reject(new IntakeError('SHOPIFY_BASIC_MEDIA_REQUEST_ABORTED',422));signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function safeUrl(value,type){
 let u;try{u=new URL(value);}catch{fail('UNSAFE_UPLOAD_TARGET');}
 if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||/[\x00-\x20\\]/.test(value))fail('UNSAFE_UPLOAD_TARGET');
 const upload=u.hostname==='shopify-staged-uploads.storage.googleapis.com'&&u.pathname.startsWith('/');
 const cdn=u.hostname==='cdn.shopify.com'&&u.pathname.startsWith('/s/files/');
 const resource=upload||(u.hostname===SHOPIFY_BASIC_MEDIA_STORE&&u.pathname.startsWith('/admin/tmp/files/'));
 if(type==='upload'?!upload:type==='cdn'?!cdn:!resource)fail('UNSAFE_UPLOAD_TARGET');
 return u.href;
}
function expectedCatalog(product,inventoryLocationId){return {handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.type,optionNames:product.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId,variants:product.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};}

/** LOCAL adapter, not a grant or unattended installer. The durable runner owns
 * claims. Each media attempt sends at most one staging mutation, one upload,
 * one fileCreate and one association update. Unknown outcomes never repeat.
 * Only exact IDs from this process's successful create responses are used.
 * Ordered gallery append requires preceding images completed in this process;
 * restart deliberately cannot adopt old files or infer IDs by filename.
 * sourceSha256 is the exact uploaded source, NOT a remote/CDN pixel hash.
 * loaded:true additionally requires bounded CDN retrieval and a caller-supplied
 * trusted full image decoder. No signature-only fallback or fidelity assertion.
 * Current allowlist intentionally supports Google's Shopify staged bucket only;
 * an unrecognized official storage host fails closed pending explicit review.
 */
export function createShopifyBasicMediaTransport({prepared,referenceComposition,binding,liveThemeId,accessToken,fetchImpl,uploadFetch,decodeImage,networkEnabled=false}={}){
 const source=createBasicInstallationSource({prepared,referenceComposition,retainLegacyBytes:true});
 const {plan,uploads}=source,pinned=structuredClone(binding),assets=new Map(uploads.map(asset=>[asset.fileName,asset]));
 if(!pinned||!equal(Object.keys(pinned).sort(),['intentHash','targetStore','projectId','ownerHash','planHash','themeZipSha256','packageBytesHash'].sort())||!isHash(pinned.intentHash)||!isHash(pinned.themeZipSha256)||pinned.targetStore!==SHOPIFY_BASIC_MEDIA_STORE||plan.targetStore!==pinned.targetStore||plan.projectId!==pinned.projectId||plan.binding.ownerHash!==pinned.ownerHash||plan.planHash!==pinned.planHash||pinned.packageBytesHash!==hash({plan,uploads})||liveThemeId!=='207379235153')fail('BINDING_MISMATCH');
 if(typeof networkEnabled!=='boolean'||typeof fetchImpl!=='function'||typeof uploadFetch!=='function'||typeof decodeImage!=='function')fail('TRANSPORT_CONFIGURATION_INVALID');
 if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>2048||!(/^[\x21-\x7e]+$/).test(accessToken))fail('CREDENTIAL_REQUIRED');
 const graphFetch=source.guardFetch(fetchImpl),cdnFetch=source.guardFetch(uploadFetch);
 const steps=new Map();
 for(const product of plan.products)for(const photo of product.photos){
  const expected={parentKey:`catalog:${product.productId}`,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt},asset=assets.get(photo.fileName);
  if(!asset||asset.bytes!==photo.bytes||asset.bytes>MAX_BYTES||asset.sha256!==photo.sha256||!['image/png','image/jpeg','image/webp'].includes(photo.mime))fail('SOURCE_INVALID');
  const step={key:`media:${product.productId}:${photo.position}`,kind:'media',action:'create',expected,payloadHash:hash(expected),dependsOn:[expected.parentKey]};
  steps.set(step.key,{step,product,photo});
 }
 const attempts=new Map(),sent=new Set(),preflights=new Map(),completed=new Map(),counts=new Map();
 const key=r=>`${r.step.key}:${r.attemptId??'before-claim'}`;
 function validate(r,{attempt=false,read=false}={}){
  if(!r||!equal(r.binding,pinned)||!equal(r.trustedShop,{shopId:SHOPIFY_BASIC_MEDIA_SHOP_ID,targetStore:SHOPIFY_BASIC_MEDIA_STORE}))fail('REQUEST_BINDING_MISMATCH');
  const item=steps.get(r.step?.key);if(!item||!equal(r.step,item.step))fail('STEP_MISMATCH');
  if(attempt&&!uuid(r.attemptId)||r.attemptId!=null&&!uuid(r.attemptId))fail('ATTEMPT_REQUIRED');
  if(read&&(!uuid(r.readRequestId)||!['after_apply','reconcile'].includes(r.mode)))fail('READBACK_REQUEST_INVALID');
  const parent=r.dependencies?.[item.step.expected.parentKey];
  if(!parent||!id(parent.remoteId)||!equal(Object.keys(r.dependencies),[item.step.expected.parentKey])||parent.observed?.inventoryLocationId!==SHOPIFY_BASIC_MEDIA_INVENTORY_LOCATION_ID)fail('PARENT_RECEIPT_REQUIRED');
  const expected=expectedCatalog(item.product,parent.observed.inventoryLocationId),variants=parent.observed.variants;
  if(parent.payloadHash!==hash(expected)||!Array.isArray(variants)||variants.length!==expected.variants.length||variants.some((v,i)=>!id(v.remoteId)||!equal(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='remoteId')),expected.variants[i]))||!equal({...parent.observed,variants:expected.variants},expected)||new Set(variants.map(v=>v.remoteId)).size!==variants.length)fail('PARENT_RECEIPT_MISMATCH');
  return {...item,parent};
 }
 function identity(data){
  if(data.shop?.id!==gid('Shop',SHOPIFY_BASIC_MEDIA_SHOP_ID)||data.shop.myshopifyDomain!==SHOPIFY_BASIC_MEDIA_STORE||data.shop.currencyCode!=='EUR'||data.currentAppInstallation?.app?.id!==gid('App',SHOPIFY_BASIC_MEDIA_APP_ID)||data.currentAppInstallation?.id!==gid('AppInstallation',SHOPIFY_BASIC_MEDIA_INSTALLATION_ID))fail('REMOTE_SHOP_OR_APP_MISMATCH');
  const scopes=data.currentAppInstallation.accessScopes;if(!Array.isArray(scopes)||!SHOPIFY_BASIC_MEDIA_SCOPES.every(s=>scopes.some(v=>v.handle===s)))fail('REQUIRED_SCOPES_MISSING');
  if(data.themes?.pageInfo?.hasNextPage!==false||!equal(data.themes.nodes,[{id:gid('OnlineStoreTheme',liveThemeId),role:'MAIN'}]))fail('LIVE_THEME_CHANGED');
 }
 function parentState(data,item){
  identity(data);const p=data.product,e=item.parent.observed;
  if(!p||p.id!==gid('Product',item.parent.remoteId)||p.status!=='DRAFT'||p.handle!==e.handle||p.title!==e.title||typeof p.descriptionHtml!=='string'||sha(p.descriptionHtml)!==e.descriptionHtmlSha256||p.vendor!==e.vendor||p.productType!==e.productType||!equal(p.options?.map(o=>o.name),e.optionNames))fail('PARENT_REMOTE_MISMATCH');
  if(!equal(p.resourcePublicationsCount,{count:0,precision:'EXACT'}))fail('PARENT_PUBLISHED_OR_SCHEDULED');
  if(p.variants?.pageInfo?.hasNextPage!==false||p.variants.nodes?.length!==e.variants.length)fail('PARENT_VARIANTS_MISMATCH');
  for(const v of e.variants){const actual=p.variants.nodes.find(a=>a.id===gid('ProductVariant',v.remoteId));if(!actual||actual.sku!==(v.sku??'')||priceMinor(actual.price)!==v.priceMinor||!equal(actual.selectedOptions,e.optionNames.map((name,i)=>({name,value:v.optionValues[i]}))))fail('PARENT_VARIANTS_MISMATCH');}
  if(p.media?.pageInfo?.hasNextPage!==false||!Array.isArray(p.media.nodes)||p.media.nodes.length>30)fail('MEDIA_LIST_INVALID');
  const prior=item.product.photos.filter(p=>p.position<item.photo.position).map(p=>completed.get(`media:${item.product.productId}:${p.position}`));
  if(prior.some(p=>!p)||p.media.nodes.slice(0,prior.length).some((m,i)=>m.id!==prior[i]?.remoteId))fail('PRIOR_MEDIA_NOT_VERIFIED');
  return p.media.nodes;
 }
 async function guarded(work,signal){
  if(!networkEnabled)fail('NETWORK_DISABLED');const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]):AbortSignal.timeout(TIMEOUT_MS);
  try{return await work(combined);}catch(error){if(error instanceof IntakeError&&error.code?.startsWith('SHOPIFY_BASIC_MEDIA_'))throw error;fail(combined.aborted?'REQUEST_ABORTED':'REQUEST_FAILED');}
 }
 async function graphql(operation,variables,r,options={}){return guarded(async signal=>{
  const count=(counts.get(r.step.key)??0)+1;if(count>20)fail('REQUEST_BUDGET_EXHAUSTED');counts.set(r.step.key,count);
  const response=await abortable(graphFetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-Shopify-Access-Token':accessToken},body:JSON.stringify({query:SHOPIFY_BASIC_MEDIA_OPERATIONS[operation],variables}),redirect:'error',credentials:'omit',cache:'no-store',signal}),signal);
  if(response.url&&response.url!==ENDPOINT)fail('RESPONSE_ORIGIN_MISMATCH');
  if(!/^application\/json(?:;|$)/i.test(response.headers?.get('content-type')??''))fail('RESPONSE_CONTENT_TYPE');
  if(response.headers?.get('x-shopify-api-version')!==SHOPIFY_BASIC_MEDIA_API_VERSION)fail('API_VERSION_MISMATCH');
  const raw=await boundedBody(response,signal,2*1024*1024);let json;try{json=JSON.parse(raw.toString('utf8'));}catch{fail('INVALID_JSON');}if(json.errors?.length||!json.data)fail('GRAPHQL_UNCONFIRMED');return json.data;
 },options.signal);}
 async function preflight(input,options={}){
  const r=structuredClone(input),item=validate(r),attempt=attempts.get(key(r));preflights.delete(key(r));
  const data=await graphql('preflight',{id:gid('Product',item.parent.remoteId)},r,options),media=parentState(data,item);
  const expectedCount=item.photo.position-1,ownId=attempt?.remoteId;
  if(media.length!==expectedCount&&!(ownId&&media.length===expectedCount+1&&media.at(-1)?.id===ownId))fail('UNEXPECTED_MEDIA');
  preflights.set(key(r),{at:Date.now(),parentRemoteId:item.parent.remoteId});
  return {shopId:SHOPIFY_BASIC_MEDIA_SHOP_ID,targetStore:SHOPIFY_BASIC_MEDIA_STORE,currency:'EUR',authorizedKinds:['media'],observedAt:new Date().toISOString()};
 }
 async function apply(input,options={}){
  const r=structuredClone(input),item=validate(r,{attempt:true}),k=key(r),checked=preflights.get(k);
  if(sent.has(item.step.key)||attempts.has(k))fail('ATTEMPT_ALREADY_SENT');if(!checked||Date.now()-checked.at>TIMEOUT_MS||checked.parentRemoteId!==item.parent.remoteId)fail('FRESH_PREFLIGHT_REQUIRED');
  const known={parentRemoteId:item.parent.remoteId,sourceSha256:item.photo.sha256,sourceBytes:item.photo.bytes,uploaded:false,remoteId:null,attachSent:false};attempts.set(k,known);sent.add(item.step.key);preflights.delete(k);
  const filename=item.photo.fileName.split('/').at(-1),stage=await graphql('stage',{input:[{filename,mimeType:item.photo.mime,httpMethod:'POST',resource:'FILE',fileSize:String(item.photo.bytes)}]},r,options);
  const s=stage.stagedUploadsCreate;if(!s||s.userErrors?.length||!Array.isArray(s.userErrors)||s.stagedTargets?.length!==1)fail('STAGING_UNCONFIRMED');
  const target=s.stagedTargets[0],uploadUrl=safeUrl(target.url,'upload'),resourceUrl=safeUrl(target.resourceUrl,'resource');
  if(!Array.isArray(target.parameters)||target.parameters.length<2||target.parameters.length>20||new Set(target.parameters.map(p=>p.name)).size!==target.parameters.length)fail('UNSAFE_UPLOAD_PARAMETERS');
  for(const p of target.parameters){if(typeof p.name!=='string'||!(/^(?:key|policy|acl|success_action_status|Content-Type|x-goog-[a-z0-9-]+|GoogleAccessId|signature)$/).test(p.name)||typeof p.value!=='string'||p.value.length>16_384||/[\x00-\x1f]/.test(p.value))fail('UNSAFE_UPLOAD_PARAMETERS');}
  const uploadKey=target.parameters.find(p=>p.name==='key')?.value;
  let resourcePath;try{resourcePath=decodeURIComponent(new URL(resourceUrl).pathname);}catch{fail('UNSAFE_UPLOAD_PARAMETERS');}
  if(target.parameters.find(p=>p.name==='Content-Type')?.value!==item.photo.mime||typeof uploadKey!=='string'||!uploadKey.endsWith(`/${filename}`)||uploadKey.startsWith('/')||uploadKey.includes('..')||new URL(resourceUrl).hostname!==new URL(uploadUrl).hostname||resourcePath!==`/${uploadKey}`)fail('UNSAFE_UPLOAD_PARAMETERS');
  // Stage outside the exclusive source lease. Keep only this selected file
  // through the actual POST, release it before fileCreate/processing/attach.
  await source.withAsset(item.photo.fileName,async({bytes})=>{
   const form=new FormData();for(const p of target.parameters)form.append(p.name,p.value);
   form.append('file',new Blob([bytes],{type:item.photo.mime}),filename);
   await guarded(async signal=>{
    if(signal.aborted)fail('REQUEST_ABORTED');
    // Abort is advisory. Do not race away from an outstanding upload: retain
    // the source lease until the actual request settles, even if a runner has
    // already timed out. Its sent attempt remains unknown and cannot replay.
    const upload=uploadFetch(uploadUrl,{method:'POST',body:form,redirect:'error',credentials:'omit',cache:'no-store',signal});
    const response=await (referenceComposition!==undefined?upload:abortable(upload,signal));
    if(signal.aborted)fail('REQUEST_ABORTED');
    if(response.url&&response.url!==uploadUrl)fail('UPLOAD_RESPONSE_ORIGIN_MISMATCH');await boundedBody(response,signal,64*1024);
   },options.signal);
  });known.uploaded=true;
  const created=await graphql('create',{files:[{alt:item.photo.alt,contentType:'IMAGE',filename,originalSource:resourceUrl,duplicateResolutionMode:'RAISE_ERROR'}]},r,options),c=created.fileCreate;
  if(!c||!Array.isArray(c.userErrors)||c.userErrors.length||c.files?.length!==1||!/^gid:\/\/shopify\/MediaImage\/[1-9][0-9]{0,24}$/.test(c.files[0]?.id))fail('CREATE_OUTCOME_UNCONFIRMED');known.remoteId=c.files[0].id;
  let ready=false;
  for(let n=0;n<8;n++){
   const d=await graphql('processing',{id:known.remoteId},r,options);identity(d);if(d.node?.id!==known.remoteId||d.node.alt!==item.photo.alt)fail('FILE_IDENTITY_MISMATCH');
   if(d.node.fileStatus==='READY'){ready=true;break;}if(!['UPLOADED','PROCESSING'].includes(d.node.fileStatus))fail('FILE_PROCESSING_FAILED');
   if(n<7)await guarded(signal=>abortable(new Promise(resolve=>setTimeout(resolve,500)),signal),options.signal);
  }
  if(!ready)fail('PROCESSING_PENDING_NO_RETRY');
  // Recheck the exact Draft parent immediately before the one association write.
  const d=await graphql('preflight',{id:gid('Product',item.parent.remoteId)},r,options),media=parentState(d,item);if(media.length!==item.photo.position-1)fail('UNEXPECTED_MEDIA');
  known.attachSent=true;const attached=await graphql('attach',{files:[{id:known.remoteId,referencesToAdd:[gid('Product',item.parent.remoteId)]}]},r,options),a=attached.fileUpdate;
  if(!a||!Array.isArray(a.userErrors)||a.userErrors.length||a.files?.length!==1||a.files[0]?.id!==known.remoteId)fail('ATTACH_OUTCOME_UNCONFIRMED');
  return {outcome:'media_create_and_attach_response_received'};
 }
 async function readback(input,options={}){
  const r=structuredClone(input),item=validate(r,{attempt:true,read:true}),known=attempts.get(key(r));
  const base={kind:'molyvi_basic_installation_readback',readRequestId:r.readRequestId,shopId:SHOPIFY_BASIC_MEDIA_SHOP_ID,targetStore:SHOPIFY_BASIC_MEDIA_STORE,key:item.step.key,attemptId:r.attemptId,payloadHash:item.step.payloadHash,observedAt:new Date().toISOString(),correlation:{intentHash:pinned.intentHash,attemptId:r.attemptId,payloadHash:item.step.payloadHash}};
  if(!known?.remoteId||!known.uploaded||!known.attachSent)return {...base,outcome:'unknown'};
  if(known.parentRemoteId!==item.parent.remoteId||known.sourceSha256!==item.photo.sha256)fail('ATTEMPT_BINDING_MISMATCH');
  const data=await graphql('readback',{id:gid('Product',item.parent.remoteId)},r,options),media=parentState(data,item),actualPosition=media.findIndex(m=>m.id===known.remoteId)+1,actual=media[actualPosition-1];
  if(media.length!==item.photo.position||actualPosition!==item.photo.position||actual?.id!==known.remoteId||actual.alt!==item.photo.alt||actual.mediaContentType!=='IMAGE')fail('READBACK_MISMATCH');
  if(actual.status!=='READY'||actual.fileStatus!=='READY')return {...base,outcome:'unknown'};
  const url=safeUrl(actual.image?.url,'cdn');if(!Number.isSafeInteger(actual.image.width)||actual.image.width<1||!Number.isSafeInteger(actual.image.height)||actual.image.height<1||actual.image.width*actual.image.height>40_000_000)fail('IMAGE_DIMENSIONS_INVALID');
  const retrieved=await guarded(async signal=>{
   const response=await abortable(cdnFetch(url,{method:'GET',headers:{Accept:'image/png,image/jpeg,image/webp'},redirect:'error',credentials:'omit',cache:'no-store',signal}),signal);
   if(response.url&&response.url!==url)fail('CDN_RESPONSE_ORIGIN_MISMATCH');
   const mime=response.headers?.get('content-type')?.split(';')[0];if(!['image/png','image/jpeg','image/webp'].includes(mime))fail('CDN_IMAGE_INVALID');
   const bytes=await boundedBody(response,signal,MAX_BYTES),decoded=await abortable(decodeImage(Buffer.from(bytes),{mime,maxPixels:40_000_000,signal}),signal);
   if(decoded?.decoded!==true||decoded.mime!==mime||decoded.width!==actual.image.width||decoded.height!==actual.image.height)fail('CDN_IMAGE_DECODE_FAILED');
   return {sha256:sha(bytes),bytes:bytes.length,width:decoded.width,height:decoded.height,mime};
  },options.signal);
  completed.set(item.step.key,{remoteId:known.remoteId});
  return {...base,outcome:'found',remoteId:known.remoteId.split('/').at(-1),observed:{parentRemoteId:data.product.id.split('/').at(-1),position:actualPosition,sourceSha256:known.sourceSha256,alt:actual.alt,loaded:true},provenance:{kind:'source_upload_then_definite_file_id',sourceSha256:known.sourceSha256,sourceBytes:known.sourceBytes,cdn:retrieved,cdnBytesEqualSource:retrieved.sha256===known.sourceSha256,visualFidelityCertified:false},observedAt:new Date().toISOString()};
 }
 return Object.freeze({supportedKinds:Object.freeze(['media']),preflight:source.guardMethod(preflight),apply:source.guardMethod(apply),readback:source.guardMethod(readback)});
}
