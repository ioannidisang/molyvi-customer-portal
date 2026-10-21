import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {canonicalJson} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {createShopifyBasicPagesTransport,SHOPIFY_BASIC_PAGES_OPERATIONS,SHOPIFY_BASIC_PAGES_STORE,SHOPIFY_BASIC_PAGES_SHOP_ID,SHOPIFY_BASIC_PAGES_API_VERSION} from '../lib/shopify-basic-pages.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>sha(canonicalJson(value));
const token='shpat_SYNTHETIC_TEST_ONLY_123456789';
const shopId=SHOPIFY_BASIC_PAGES_SHOP_ID,targetStore=SHOPIFY_BASIC_PAGES_STORE,liveThemeId='207379235153';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
const reject=(promise,code)=>assert.rejects(promise,{code:`SHOPIFY_BASIC_PAGES_${code}`});
let prepared,binding,step,page;
test.before(()=>{
  const fixture=createBasicAssemblyFixture({productCount:1}),assemblyBinding=createBasicAssemblyBinding(fixture.record,fixture.options);
  prepared=prepareBasicStorePackage(fixture.record,{...fixture.options,binding:assemblyBinding});
  const plan=prepared.plan,uploads=prepared.uploads.map(item=>({fileName:item.fileName,sha256:sha(item.bytes),bytes:item.bytes.length}));
  binding={intentHash:'1'.repeat(64),targetStore,projectId:plan.projectId,ownerHash:plan.binding.ownerHash,planHash:plan.planHash,themeZipSha256:'2'.repeat(64),packageBytesHash:hash({plan,uploads})};
  page=plan.pages[0];const expected={title:page.title,handle:page.handle,bodySha256:page.bodySha256,visibility:'Hidden'};
  step={key:`page:${page.documentId}`,kind:'page',action:'create',expected,payloadHash:hash(expected),dependsOn:[]};
});
function request(extra={}){return {binding:structuredClone(binding),trustedShop:{shopId,targetStore},step:structuredClone(step),dependencies:{},attemptId:crypto.randomUUID(),...extra};}
function response(data,options={}){return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json','x-shopify-api-version':SHOPIFY_BASIC_PAGES_API_VERSION},...options});}
function mockWorld(overrides={}){
  const world={calls:[],pages:[],mutations:0,shop:{id:gid('Shop',shopId),myshopifyDomain:targetStore,currencyCode:'EUR'},scopes:[{handle:'write_online_store_pages'},{handle:'read_themes'}],themes:{nodes:[{id:gid('OnlineStoreTheme',liveThemeId),role:'MAIN'}],pageInfo:{hasNextPage:false}},...overrides};
  const identity=()=>({shop:world.shop,currentAppInstallation:{accessScopes:world.scopes},themes:world.themes});
  world.fetch=async(url,options)=>{
    const payload=JSON.parse(options.body);world.calls.push({url,options,payload});
    if(world.handler)return world.handler(payload,options,identity);
    if(payload.query===SHOPIFY_BASIC_PAGES_OPERATIONS.preflight)return response({...identity(),pages:{nodes:world.pages.map(({id,handle})=>({id,handle})),pageInfo:{hasNextPage:false}}});
    if(payload.query===SHOPIFY_BASIC_PAGES_OPERATIONS.create){
      world.mutations++;const id=gid('Page',String(100+world.mutations));world.pages.push({id,...payload.variables.page});
      return response({pageCreate:{page:{id},userErrors:[]}});
    }
    if(payload.query===SHOPIFY_BASIC_PAGES_OPERATIONS.readback)return response({...identity(),page:world.pages.find(p=>p.id===payload.variables.id)??null});
    throw Error('Unexpected operation');
  };
  return world;
}
function transport(world,options={}){return createShopifyBasicPagesTransport({prepared,binding,liveThemeId,accessToken:token,fetchImpl:world.fetch,networkEnabled:true,...options});}
async function created(world=mockWorld()){
  const adapter=transport(world),req=request();await adapter.preflight(req);await adapter.apply(req);return {world,adapter,req};
}
const readReq=req=>({...req,readRequestId:crypto.randomUUID(),mode:'after_apply'});

test('network is disabled by default and no token, Shopify session or environment is read implicitly',async()=>{
  const world=mockWorld(),adapter=createShopifyBasicPagesTransport({prepared,binding,liveThemeId,accessToken:token,fetchImpl:world.fetch});
  await reject(adapter.preflight(request()),'NETWORK_DISABLED');assert.equal(world.calls.length,0);
  assert.deepEqual(Object.keys(adapter).sort(),['apply','preflight','readback','supportedKinds']);assert(!JSON.stringify(adapter).includes(token));
  assert.throws(()=>createShopifyBasicPagesTransport({prepared,binding,liveThemeId,fetchImpl:world.fetch}),{code:'SHOPIFY_BASIC_PAGES_CREDENTIAL_REQUIRED'});
});

test('preflight verifies exact shop, EUR, page-write grant and unchanged published theme without creating content',async()=>{
  const world=mockWorld(),adapter=transport(world),req=request({attemptId:null}),result=await adapter.preflight(req);
  assert.deepEqual({...result,observedAt:undefined},{shopId,targetStore,currency:'EUR',authorizedKinds:['page'],observedAt:undefined});
  assert.equal(world.calls.length,1);assert.equal(world.mutations,0);
  assert.equal(world.calls[0].payload.variables.query,`handle:${page.handle}`);
});

test('page creation sends explicit hidden flag and records only independently fetched matching persisted content',async()=>{
  const {world,adapter,req}=await created();
  const create=world.calls.find(c=>c.payload.query===SHOPIFY_BASIC_PAGES_OPERATIONS.create);
  assert.deepEqual(create.payload.variables,{page:{title:page.title,handle:page.handle,body:page.bodyHtml,isPublished:false}});
  await adapter.preflight(req);
  const query=readReq(req),result=await adapter.readback(query);
  assert.equal(world.mutations,1);assert.equal(world.calls.length,4);
  assert.equal(result.outcome,'found');assert.equal(result.remoteId,'101');assert.deepEqual(result.observed,step.expected);
  assert.equal(result.readRequestId,query.readRequestId);assert.deepEqual(result.correlation,{intentHash:binding.intentHash,attemptId:req.attemptId,payloadHash:step.payloadHash});
  for(const call of world.calls){
    assert.equal(call.url,`https://${targetStore}/admin/api/2026-10/graphql.json`);assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.equal(call.options.cache,'no-store');
    assert.equal(call.options.headers['X-Shopify-Access-Token'],token);assert(!JSON.stringify(call.payload).includes(token));
  }
});

test('wrong store, shop, currency, scope and published-theme sentinel fail before any mutation',async()=>{
  for(const change of [
    {shop:{id:gid('Shop','9'),myshopifyDomain:targetStore,currencyCode:'EUR'}},
    {shop:{id:gid('Shop',shopId),myshopifyDomain:'other.myshopify.com',currencyCode:'EUR'}},
    {shop:{id:gid('Shop',shopId),myshopifyDomain:targetStore,currencyCode:'USD'}}
  ]){const world=mockWorld(change);await reject(transport(world).preflight(request()),'REMOTE_SHOP_MISMATCH');assert.equal(world.mutations,0);}
  for(const scopes of [[{handle:'read_orders'}],[{handle:'read_online_store_pages'},{handle:'read_themes'}],[{handle:'write_online_store_pages'}]]){
    const world=mockWorld({scopes});await reject(transport(world).preflight(request()),'REQUIRED_SCOPES_MISSING');assert.equal(world.mutations,0);
  }
  for(const themes of [{nodes:[],pageInfo:{hasNextPage:false}},{nodes:[{id:gid('OnlineStoreTheme','8'),role:'MAIN'}],pageInfo:{hasNextPage:false}},{nodes:[{id:gid('OnlineStoreTheme',liveThemeId),role:'UNPUBLISHED'}],pageInfo:{hasNextPage:false}},{nodes:[{id:gid('OnlineStoreTheme',liveThemeId),role:'MAIN'}],pageInfo:{hasNextPage:true}}]){
    const world=mockWorld({themes});await reject(transport(world).preflight(request()),'LIVE_THEME_CHANGED');assert.equal(world.mutations,0);
  }
});

test('existing handles cannot be adopted, replaced or retried',async()=>{
  const world=mockWorld({pages:[{id:gid('Page','99'),handle:page.handle}]});
  await reject(transport(world).preflight(request()),'HANDLE_ALREADY_EXISTS');assert.equal(world.mutations,0);
  const duplicate=mockWorld({pages:[{id:gid('Page','99'),handle:page.handle},{id:gid('Page','98'),handle:page.handle}]});
  await reject(transport(duplicate).preflight(request()),'HANDLE_LOOKUP_AMBIGUOUS');
});

test('unsupported steps and changed payload, package and owner binding fail before fetch',async()=>{
  const world=mockWorld(),adapter=transport(world);
  await reject(adapter.preflight(request({step:{...step,kind:'catalog'}})),'UNSUPPORTED_STEP');
  for(const changed of [{...step,expected:{...step.expected,title:'wrong'}},{...step,payloadHash:'f'.repeat(64)},{...step,action:'update'},{...step,dependsOn:['theme']}])await reject(adapter.preflight(request({step:changed})),'PAGE_STEP_MISMATCH');
  for(const changed of [{...binding,ownerHash:'f'.repeat(64)},{...binding,targetStore:'other.myshopify.com'},{...binding,intentHash:'f'.repeat(64)}])await reject(adapter.preflight(request({binding:changed})),'REQUEST_BINDING_MISMATCH');
  await reject(adapter.preflight(request({trustedShop:{shopId:'9',targetStore}})),'REQUEST_BINDING_MISMATCH');
  assert.equal(world.calls.length,0);
  assert.throws(()=>transport(world,{binding:{...binding,packageBytesHash:'f'.repeat(64)}}),{code:'SHOPIFY_BASIC_PAGES_BINDING_MISMATCH'});
  const wrong={plan:structuredClone(prepared.plan),uploads:prepared.uploads};wrong.plan.pages[0].bodyHtml+='changed';
  assert.throws(()=>transport(world,{prepared:wrong}));assert.equal(world.calls.length,0);
});

test('a post-claim preflight is required; same or invented replacement attempt cannot repeat creation',async()=>{
  const world=mockWorld(),adapter=transport(world),req=request();
  await reject(adapter.apply(req),'FRESH_PREFLIGHT_REQUIRED');
  await adapter.preflight({...req,attemptId:null});await reject(adapter.apply(req),'FRESH_PREFLIGHT_REQUIRED');
  await adapter.preflight(req);await adapter.apply(req);await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');
  await reject(adapter.apply({...req,attemptId:crypto.randomUUID()}),'ATTEMPT_ALREADY_SENT');assert.equal(world.mutations,1);
});

test('a failed refreshed preflight invalidates the earlier successful check',async()=>{
  const world=mockWorld(),adapter=transport(world),req=request();await adapter.preflight(req);
  world.scopes=[{handle:'read_orders'}];await reject(adapter.preflight(req),'REQUIRED_SCOPES_MISSING');
  await reject(adapter.apply(req),'FRESH_PREFLIGHT_REQUIRED');assert.equal(world.mutations,0);
});

test('lost mutation response is unknown, never adopted from search and never retried',async()=>{
  const world=mockWorld(),normal=world.fetch;let failCreate=true;
  world.fetch=async(url,options)=>{const result=await normal(url,options);if(failCreate&&JSON.parse(options.body).query===SHOPIFY_BASIC_PAGES_OPERATIONS.create)throw Error(`simulated timeout ${token}`);return result;};
  const adapter=transport(world),req=request();await adapter.preflight(req);await reject(adapter.apply(req),'REQUEST_FAILED');
  const before=world.calls.length,result=await adapter.readback(readReq(req));assert.equal(result.outcome,'unknown');assert.equal(world.calls.length,before);
  failCreate=false;await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');await reject(adapter.preflight(req),'HANDLE_ALREADY_EXISTS');assert.equal(world.mutations,1);
});

test('process restart loses create correlation and cannot auto-adopt an existing exact page',async()=>{
  const {world,req}=await created(),restarted=transport(world),before=world.calls.length;
  const result=await restarted.readback({...readReq(req),mode:'reconcile'});assert.equal(result.outcome,'unknown');assert.equal(world.calls.length,before);
  await reject(restarted.preflight(req),'HANDLE_ALREADY_EXISTS');assert.equal(world.mutations,1);
});

test('readback detects changed HTML, title, handle, visibility and remote ID rather than copying expectations',async()=>{
  for(const changed of [{body:page.bodyHtml+'\n'},{title:'different'},{handle:page.handle+'-changed'},{isPublished:true}]){
    const {world,adapter,req}=await created();Object.assign(world.pages[0],changed);await reject(adapter.readback(readReq(req)),'READBACK_MISMATCH');assert.equal(world.mutations,1);
  }
  const {world,adapter,req}=await created();world.handler=(_payload,_options,identity)=>response({...identity(),page:{...world.pages[0],id:gid('Page','999')}});
  await reject(adapter.readback(readReq(req)),'READBACK_INVALID');
});

test('readback checks remote shop and active theme again; missing persisted page is unknown',async()=>{
  let run=await created();run.world.shop.myshopifyDomain='other.myshopify.com';await reject(run.adapter.readback(readReq(run.req)),'REMOTE_SHOP_MISMATCH');
  run=await created();run.world.themes.nodes[0].id=gid('OnlineStoreTheme','9');await reject(run.adapter.readback(readReq(run.req)),'LIVE_THEME_CHANGED');
  run=await created();run.world.pages=[];assert.equal((await run.adapter.readback(readReq(run.req))).outcome,'unknown');assert.equal(run.world.mutations,1);
});

test('provider userErrors and GraphQL errors are sanitized and never turn into successful receipts',async()=>{
  for(const mode of ['userErrors','graphqlErrors','empty']){
    const world=mockWorld(),normal=world.fetch;
    world.fetch=async(url,options)=>{
      if(JSON.parse(options.body).query!==SHOPIFY_BASIC_PAGES_OPERATIONS.create)return normal(url,options);
      world.mutations++;
      if(mode==='graphqlErrors')return new Response(JSON.stringify({errors:[{message:token}]}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
      if(mode==='empty')return response({pageCreate:{page:null,userErrors:[]}});
      return response({pageCreate:{page:{id:gid('Page','101')},userErrors:[{message:token,code:'FAIL',field:['body']}]}});
    };
    const adapter=transport(world),req=request();await adapter.preflight(req);
    await assert.rejects(adapter.apply(req),error=>{assert(!String(error).includes(token));return error.code===`SHOPIFY_BASIC_PAGES_${mode==='graphqlErrors'?'GRAPHQL_FAILURE':'CREATE_OUTCOME_UNCONFIRMED'}`;});
    assert.equal((await adapter.readback(readReq(req))).outcome,'unknown');await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');assert.equal(world.mutations,1);
  }
});

test('API fallback, redirects, HTTP and non-JSON responses fail closed without a second request',async()=>{
  const cases=[
    [()=>response({}, {headers:{'content-type':'application/json','x-shopify-api-version':'2026-07'}}),'API_VERSION_MISMATCH'],
    [()=>response({}, {status:429}),'HTTP_FAILURE'],
    [()=>new Response('no',{headers:{'content-type':'text/html','x-shopify-api-version':'2026-10'}}),'NON_JSON_RESPONSE'],
    [()=>{const r=response({});Object.defineProperty(r,'redirected',{value:true});return r;},'REDIRECT_OR_WRONG_RESPONSE_ORIGIN'],
    [()=>{const r=response({});Object.defineProperty(r,'url',{value:'https://other.example/'});return r;},'REDIRECT_OR_WRONG_RESPONSE_ORIGIN']
  ];
  for(const [make,code]of cases){let calls=0;const world=mockWorld({handler:()=>{calls++;return make();}});await reject(transport(world).preflight(request()),code);assert.equal(calls,1);}
});

test('both advertised and streamed response byte limits reject oversized data',async()=>{
  let world=mockWorld({handler:()=>response({}, {headers:{'content-type':'application/json','x-shopify-api-version':'2026-10','content-length':'3000000'}})});
  await reject(transport(world).preflight(request()),'RESPONSE_TOO_LARGE');
  world=mockWorld({handler:()=>new Response(' '.repeat(2*1024*1024+1),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}})});
  await reject(transport(world).preflight(request()),'RESPONSE_TOO_LARGE');
});

test('caller abort bounds a noncooperative fetch and leaves no automatic retry',async()=>{
  let calls=0;const world=mockWorld({handler:()=>{calls++;return new Promise(()=>{});}}),adapter=transport(world),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20);
  try{await reject(adapter.preflight(request(),{signal:controller.signal}),'REQUEST_ABORTED');}finally{clearTimeout(timer);}
  assert.equal(calls,1);
});

test('request and prepared inputs are snapshotted; mutation of caller objects cannot switch the operation',async()=>{
  const world=mockWorld(),normal=world.fetch;let release;
  world.fetch=async(url,options)=>{await new Promise(resolve=>{release=resolve;});return normal(url,options);};
  const adapter=transport(world),req=request(),original=structuredClone(req),pending=adapter.preflight(req);
  req.attemptId=crypto.randomUUID();req.step.expected.title='caller mutation';release();await pending;
  world.fetch=normal;
  // The factory captured the function, so release its second call explicitly.
  const apply=adapter.apply(original);await new Promise(resolve=>setImmediate(resolve));release();await apply;
  assert.equal(world.pages[0].title,page.title);assert.equal(world.mutations,1);
});
