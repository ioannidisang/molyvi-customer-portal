import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {verifyBasicStorePackage} from './basic-store-package.mjs';

export const SHOPIFY_BASIC_PAGES_API_VERSION='2026-10';
export const SHOPIFY_BASIC_PAGES_STORE='molyvi-still-dev.myshopify.com';
export const SHOPIFY_BASIC_PAGES_SHOP_ID='108668748113';
export const SHOPIFY_BASIC_PAGES_SCOPES=Object.freeze(['write_online_store_pages','read_themes']);
const endpoint=`https://${SHOPIFY_BASIC_PAGES_STORE}/admin/api/${SHOPIFY_BASIC_PAGES_API_VERSION}/graphql.json`;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>sha(canonicalJson(value));
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isId=value=>typeof value==='string'&&/^[1-9][0-9]{0,24}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fail=code=>{throw new IntakeError(`SHOPIFY_BASIC_PAGES_${code}`,422);};
const gid=(kind,id)=>`gid://shopify/${kind}/${id}`;
const MAX_RESPONSE_BYTES=2*1024*1024,MAX_REQUEST_BYTES=1024*1024,TIMEOUT_MS=30000;

function abortable(promise,signal){
  if(signal.aborted)return Promise.reject(new IntakeError('SHOPIFY_BASIC_PAGES_REQUEST_ABORTED',422));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new IntakeError('SHOPIFY_BASIC_PAGES_REQUEST_ABORTED',422));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

// Kept as named, fixed operations: callers cannot supply arbitrary GraphQL.
export const SHOPIFY_BASIC_PAGES_OPERATIONS=Object.freeze({
  preflight:`query MolyviBasicPagesPreflight($query: String!) {
    shop { id myshopifyDomain currencyCode }
    currentAppInstallation { accessScopes { handle } }
    themes(first: 2, roles: [MAIN]) { nodes { id role } pageInfo { hasNextPage } }
    pages(first: 2, query: $query) { nodes { id handle } pageInfo { hasNextPage } }
  }`,
  create:`mutation MolyviBasicPageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) { page { id } userErrors { code field message } }
  }`,
  readback:`query MolyviBasicPageReadback($id: ID!) {
    shop { id myshopifyDomain currencyCode }
    currentAppInstallation { accessScopes { handle } }
    themes(first: 2, roles: [MAIN]) { nodes { id role } pageInfo { hasNextPage } }
    page(id: $id) { id title handle body isPublished }
  }`
});

async function responseJson(response,signal){
  if(!response||response.redirected===true||(response.url&&response.url!==endpoint))fail('REDIRECT_OR_WRONG_RESPONSE_ORIGIN');
  if(!Number.isInteger(response.status)||response.status<200||response.status>=300)fail('HTTP_FAILURE');
  if(response.headers?.get('x-shopify-api-version')!==SHOPIFY_BASIC_PAGES_API_VERSION)fail('API_VERSION_MISMATCH');
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??''))fail('NON_JSON_RESPONSE');
  const stated=response.headers?.get('content-length');
  if(stated!==null&&stated!==undefined&&(!/^\d+$/.test(stated)||Number(stated)>MAX_RESPONSE_BYTES))fail('RESPONSE_TOO_LARGE');
  if(!response.body?.getReader)fail('RESPONSE_BODY_REQUIRED');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){
      if(signal.aborted)fail('REQUEST_ABORTED');
      const {done,value}=await abortable(reader.read(),signal);if(done)break;
      if(!(value instanceof Uint8Array)||(size+=value.byteLength)>MAX_RESPONSE_BYTES)fail('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  }finally{try{void reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
  let decoded;try{decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_JSON_RESPONSE');}
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)||(decoded.errors!==undefined&&(!Array.isArray(decoded.errors)||decoded.errors.length)))fail('GRAPHQL_FAILURE');
  if(!decoded.data||typeof decoded.data!=='object'||Array.isArray(decoded.data))fail('GRAPHQL_DATA_REQUIRED');
  return decoded.data;
}

/**
 * Page-only transport for the separate, explicitly authorized development-store
 * installation connection. Network is OFF by default. Credentials are supplied
 * privately by the trusted local caller; no browser/session or environment reads.
 *
 * The runner owns durable one-attempt claims. This adapter retains a definite
 * create-response ID only in memory. A lost response or process restart cannot
 * be reconciled by guessing a handle: it remains unknown for investigation.
 * The create result is never evidence of persisted content; readback re-queries
 * the exact ID and hashes the returned HTML. No overwrite/delete/publish methods.
 */
export function createShopifyBasicPagesTransport({prepared,binding,liveThemeId,accessToken,fetchImpl=globalThis.fetch,networkEnabled=false}={}){
  verifyBasicStorePackage(prepared);
  const plan=structuredClone(prepared.plan);
  const uploads=prepared.uploads.map(item=>({fileName:item.fileName,sha256:sha(item.bytes),bytes:item.bytes.length}));
  const pinned=structuredClone(binding);
  if(!pinned||!equal(Object.keys(pinned).sort(),['intentHash','targetStore','projectId','ownerHash','planHash','themeZipSha256','packageBytesHash'].sort())
    ||!isHash(pinned.intentHash)||!isHash(pinned.themeZipSha256)||pinned.targetStore!==SHOPIFY_BASIC_PAGES_STORE
    ||plan.targetStore!==pinned.targetStore||plan.projectId!==pinned.projectId||plan.binding.ownerHash!==pinned.ownerHash
    ||plan.planHash!==pinned.planHash||pinned.packageBytesHash!==hash({plan,uploads})||!isId(liveThemeId))fail('BINDING_MISMATCH');
  if(typeof fetchImpl!=='function'||typeof networkEnabled!=='boolean')fail('TRANSPORT_CONFIGURATION_INVALID');
  // Do not trim credentials or accept controls: a bad value must never reach a header.
  if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>2048||!(/^[\x21-\x7e]+$/).test(accessToken))fail('CREDENTIAL_REQUIRED');
  const steps=new Map(plan.pages.map(page=>{
    const expected={title:page.title,handle:page.handle,bodySha256:page.bodySha256,visibility:'Hidden'};
    if(!/^[a-z0-9][a-z0-9-]*$/.test(page.handle)||sha(page.bodyHtml)!==page.bodySha256)fail('PAGE_SOURCE_MISMATCH');
    return [`page:${page.documentId}`,{key:`page:${page.documentId}`,kind:'page',action:'create',expected,payloadHash:hash(expected),dependsOn:[],bodyHtml:page.bodyHtml}];
  }));
  const attempts=new Map(),preflights=new Map(),sentSteps=new Set();
  function validate(request,{attemptRequired=false,readback=false}={}){
    if(!request||!equal(request.binding,pinned)||!equal(request.trustedShop,{shopId:SHOPIFY_BASIC_PAGES_SHOP_ID,targetStore:SHOPIFY_BASIC_PAGES_STORE}))fail('REQUEST_BINDING_MISMATCH');
    const expected=steps.get(request.step?.key);if(!expected||request.step?.kind!=='page')fail('UNSUPPORTED_STEP');
    const {bodyHtml,...step}=expected;
    if(!equal(request.step,step))fail('PAGE_STEP_MISMATCH');
    if((attemptRequired&&!uuid(request.attemptId))||(request.attemptId!==undefined&&request.attemptId!==null&&!uuid(request.attemptId)))fail('ATTEMPT_REQUIRED');
    if(readback&&(!uuid(request.readRequestId)||!['after_apply','reconcile'].includes(request.mode)))fail('READBACK_REQUEST_INVALID');
    return expected;
  }
  async function graphql(operation,variables,{signal}={}){
    if(!networkEnabled)fail('NETWORK_DISABLED');
    if(signal?.aborted)fail('REQUEST_ABORTED');
    const own=AbortSignal.timeout(TIMEOUT_MS),combined=signal?AbortSignal.any([own,signal]):own;
    const body=JSON.stringify({query:SHOPIFY_BASIC_PAGES_OPERATIONS[operation],variables});
    if(Buffer.byteLength(body)>MAX_REQUEST_BYTES)fail('REQUEST_TOO_LARGE');
    try{
      const response=await abortable(fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-Shopify-Access-Token':accessToken},body,signal:combined,redirect:'error',credentials:'omit',cache:'no-store'}),combined);
      return await responseJson(response,combined);
    }catch(error){
      if(error instanceof IntakeError&&error.code?.startsWith('SHOPIFY_BASIC_PAGES_'))throw error;
      // Fetch/JSON/provider messages can contain tokens or submitted content.
      // Only stable, non-sensitive error codes leave the transport boundary.
      fail(combined.aborted?'REQUEST_ABORTED':'REQUEST_FAILED');
    }
  }
  function identity(data){
    if(data.shop?.id!==gid('Shop',SHOPIFY_BASIC_PAGES_SHOP_ID)||data.shop?.myshopifyDomain!==SHOPIFY_BASIC_PAGES_STORE||data.shop?.currencyCode!=='EUR')fail('REMOTE_SHOP_MISMATCH');
    const scopes=data.currentAppInstallation?.accessScopes;
    if(!Array.isArray(scopes)||scopes.some(s=>typeof s?.handle!=='string')||!SHOPIFY_BASIC_PAGES_SCOPES.every(scope=>scopes.some(s=>s.handle===scope)))fail('REQUIRED_SCOPES_MISSING');
    const themes=data.themes;
    if(!themes||themes.pageInfo?.hasNextPage!==false||!Array.isArray(themes.nodes)||themes.nodes.length!==1||themes.nodes[0]?.id!==gid('OnlineStoreTheme',liveThemeId)||themes.nodes[0]?.role!=='MAIN')fail('LIVE_THEME_CHANGED');
    return {shopId:SHOPIFY_BASIC_PAGES_SHOP_ID,targetStore:SHOPIFY_BASIC_PAGES_STORE,currency:'EUR'};
  }
  const attemptKey=request=>`${request.step.key}:${request.attemptId??'before-claim'}`;
  const snapshot=value=>{try{return structuredClone(value);}catch{fail('REQUEST_INVALID');}};
  async function preflight(request,options={}){
    request=snapshot(request);
    const step=validate(request);preflights.delete(attemptKey(request));
    const data=await graphql('preflight',{query:`handle:${step.expected.handle}`},options),remote=identity(data);
    const pages=data.pages;
    if(!pages||pages.pageInfo?.hasNextPage!==false||!Array.isArray(pages.nodes)||pages.nodes.length>1)fail('HANDLE_LOOKUP_AMBIGUOUS');
    if(pages.nodes.length){
      const known=attempts.get(attemptKey(request));
      if(!known?.remoteId||pages.nodes[0]?.id!==known.remoteId||pages.nodes[0]?.handle!==step.expected.handle)fail('HANDLE_ALREADY_EXISTS');
    }
    preflights.set(attemptKey(request),Date.now());
    return {...remote,authorizedKinds:['page'],observedAt:new Date().toISOString()};
  }
  async function apply(request,options={}){
    request=snapshot(request);
    const step=validate(request,{attemptRequired:true}),key=attemptKey(request);
    if(attempts.has(key)||sentSteps.has(step.key))fail('ATTEMPT_ALREADY_SENT');
    const checked=preflights.get(key);
    if(!checked||Date.now()-checked>TIMEOUT_MS)fail('FRESH_PREFLIGHT_REQUIRED');
    // Mark before the call, including failures and aborts. No repeat mutation.
    attempts.set(key,{status:'unknown',payloadHash:step.payloadHash});sentSteps.add(step.key);preflights.delete(key);
    const data=await graphql('create',{page:{title:step.expected.title,handle:step.expected.handle,body:step.bodyHtml,isPublished:false}},options);
    const result=data.pageCreate;
    if(!result||!Array.isArray(result.userErrors)||result.userErrors.length||typeof result.page?.id!=='string'||!/^gid:\/\/shopify\/Page\/[1-9][0-9]{0,24}$/.test(result.page.id))fail('CREATE_OUTCOME_UNCONFIRMED');
    attempts.set(key,{status:'definite_id',remoteId:result.page.id,payloadHash:step.payloadHash});
    return {outcome:'create_response_received'};
  }
  async function readback(request,options={}){
    request=snapshot(request);
    const step=validate(request,{attemptRequired:true,readback:true}),known=attempts.get(attemptKey(request));
    const base={kind:'molyvi_basic_installation_readback',readRequestId:request.readRequestId,shopId:SHOPIFY_BASIC_PAGES_SHOP_ID,targetStore:SHOPIFY_BASIC_PAGES_STORE,key:step.key,attemptId:request.attemptId,payloadHash:step.payloadHash,observedAt:new Date().toISOString(),correlation:{intentHash:pinned.intentHash,attemptId:request.attemptId,payloadHash:step.payloadHash}};
    if(!known?.remoteId)return {...base,outcome:'unknown'};
    const data=await graphql('readback',{id:known.remoteId},options);identity(data);
    const page=data.page;
    if(!page)return {...base,outcome:'unknown',observedAt:new Date().toISOString()};
    if(page.id!==known.remoteId||typeof page.title!=='string'||typeof page.handle!=='string'||typeof page.body!=='string'||typeof page.isPublished!=='boolean')fail('READBACK_INVALID');
    // This is derived only from a new query. Any HTML normalization, visibility
    // drift, or changed title/handle is an explicit mismatch, never an assumed PASS.
    const observed={title:page.title,handle:page.handle,bodySha256:sha(page.body),visibility:page.isPublished?'Visible':'Hidden'};
    if(!equal(observed,step.expected))fail('READBACK_MISMATCH');
    return {...base,outcome:'found',remoteId:known.remoteId.split('/').at(-1),observed,observedAt:new Date().toISOString()};
  }
  return Object.freeze({supportedKinds:Object.freeze(['page']),preflight,apply,readback});
}
