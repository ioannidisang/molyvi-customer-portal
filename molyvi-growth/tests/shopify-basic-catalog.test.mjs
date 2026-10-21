import test from 'node:test';
import {createSyntheticCatalogWorld as mockWorld,syntheticShopifyResponse as response} from './helpers/shopify-basic-catalog-world.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {canonicalJson} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {createShopifyBasicCatalogTransport,SHOPIFY_BASIC_CATALOG_OPERATIONS as operations,SHOPIFY_BASIC_CATALOG_SCOPES as scopes} from '../lib/shopify-basic-catalog.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>sha(canonicalJson(value));
const token='shpat_SYNTHETIC_LOCAL_ONLY_CATALOG_123456';
const targetStore='molyvi-still-dev.myshopify.com',shopId='108668748113',appId='436878311425',installationId='1195450433873',liveThemeId='207379235153',inventoryLocationId='125398417745';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
const connection=nodes=>({nodes,pageInfo:{hasNextPage:false}});
const reject=(promise,code)=>assert.rejects(promise,{code:`SHOPIFY_BASIC_CATALOG_${code}`});

function fixture(settings={}){
  const source=createBasicAssemblyFixture({productCount:1,withColorUnits:true,sizeProductCount:1,priceMinor:({variantIndex})=>[0,6090,6190][variantIndex],stock:({variantIndex})=>[1000,1,0][variantIndex],weightGrams:({variantIndex})=>[0,201,null][variantIndex],...settings});
  const prepared=prepareBasicStorePackage(source.record,{...source.options,binding:createBasicAssemblyBinding(source.record,source.options)}),plan=prepared.plan;
  const uploads=prepared.uploads.map(item=>({fileName:item.fileName,sha256:sha(item.bytes),bytes:item.bytes.length}));
  const binding={intentHash:'1'.repeat(64),targetStore,projectId:plan.projectId,ownerHash:plan.binding.ownerHash,planHash:plan.planHash,themeZipSha256:'2'.repeat(64),packageBytesHash:hash({plan,uploads})};
  const product=plan.products[0];
  const expected={handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.type,optionNames:product.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId,variants:product.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};
  const step={key:`catalog:${product.productId}`,kind:'catalog',action:'create',expected,payloadHash:hash(expected),dependsOn:[]};
  return {prepared,binding,product,step};
}
let f;test.before(()=>{f=fixture();});
function request(extra={},fixture=f){return {binding:structuredClone(fixture.binding),trustedShop:{shopId,targetStore},step:structuredClone(fixture.step),dependencies:{},attemptId:crypto.randomUUID(),...extra};}
const readReq=req=>({...req,readRequestId:crypto.randomUUID(),mode:'after_apply'});
function transport(world,options={},fixture=f){return createShopifyBasicCatalogTransport({prepared:fixture.prepared,binding:fixture.binding,liveThemeId,inventoryLocationId,accessToken:token,fetchImpl:world.fetch,networkEnabled:true,...options});}
async function created(world=mockWorld(),fixture=f){const adapter=transport(world,{},fixture),req=request({},fixture);await adapter.preflight(req);await adapter.apply(req);return {world,adapter,req};}

test('network defaults OFF and the transport has no credential/session reads or arbitrary mutation surface',async()=>{
  const world=mockWorld(),adapter=createShopifyBasicCatalogTransport({prepared:f.prepared,binding:f.binding,liveThemeId,inventoryLocationId,accessToken:token,fetchImpl:world.fetch});
  await reject(adapter.preflight(request()),'NETWORK_DISABLED');assert.equal(world.calls.length,0);
  assert.deepEqual(Object.keys(adapter).sort(),['apply','preflight','readback','supportedKinds']);assert(!JSON.stringify(adapter).includes(token));
  assert.throws(()=>transport(world,{accessToken:undefined}),{code:'SHOPIFY_BASIC_CATALOG_CREDENTIAL_REQUIRED'});
});

test('one synchronous new DRAFT product with complete variants, exact decimal prices, stock and optional weights',async()=>{
  const {world,adapter,req}=await created();const create=world.calls.find(c=>c.payload.query===operations.create),input=create.payload.variables.input;
  assert.deepEqual(Object.keys(create.payload.variables),['input']);assert.match(create.payload.query,/synchronous: true/);assert(!/identifier/.test(create.payload.query));
  assert.equal(input.status,'DRAFT');assert(!Object.hasOwn(input,'id'));assert.equal(input.variants.length,6);
  for(const [index,v]of input.variants.entries()){
    assert(!Object.hasOwn(v,'id'));assert.equal(v.price,['0.00','60.90','61.90'][index%3]);assert.equal(v.inventoryPolicy,'DENY');assert.equal(v.inventoryItem.tracked,true);assert.equal(v.inventoryItem.requiresShipping,true);
    assert.deepEqual(v.inventoryQuantities,[{locationId:gid('Location',inventoryLocationId),name:'available',quantity:[1000,1,0][index%3]}]);
    assert.equal(Object.hasOwn(v.inventoryItem,'measurement'),index%3!==2);
  }
  // Shopify can return variants in another order; IDs must map by exact SKU and option tuple.
  world.products[0].variants.nodes.reverse();world.products[0].options.reverse();
  for(const variant of world.products[0].variants.nodes)variant.selectedOptions.reverse();
  await adapter.preflight(req);const result=await adapter.readback(readReq(req));
  assert.equal(world.calls.at(-1).payload.variables.variantLimit,6);
  assert.equal(result.outcome,'found');assert.equal(result.remoteId,'101');assert.equal(world.mutations,1);
  assert.deepEqual({...result.observed,variants:result.observed.variants.map(({remoteId,...v})=>v)},f.step.expected);
  assert.deepEqual(result.observed.variants.map(v=>v.remoteId),['200','201','202','203','204','205']);
  for(const call of world.calls){assert.equal(call.url,`https://${targetStore}/admin/api/2026-10/graphql.json`);assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert(!JSON.stringify(call.payload).includes(token));}
});

test('simple single-variant Title product and exact large cents also work without array-based correlation',async()=>{
  const simple=fixture({withColorUnits:false,sizeProductCount:0,priceMinor:99999999999,stock:2147483647,weightGrams:2147483647}),{world,adapter,req}=await created(mockWorld(),simple);
  const result=await adapter.readback(readReq(req));assert.equal(result.observed.variants[0].priceMinor,99999999999);assert.equal(result.observed.variants[0].stock,2147483647);assert.equal(world.products[0].variants.nodes[0].price,'999999999.99');
});

test('wrong shop, app, installation, EUR, location or live theme fails before mutation',async()=>{
  const changes=[
    [w=>w.shop.id=gid('Shop','9'),'REMOTE_SHOP_MISMATCH'],[w=>w.shop.myshopifyDomain='other.myshopify.com','REMOTE_SHOP_MISMATCH'],[w=>w.shop.currencyCode='USD','REMOTE_SHOP_MISMATCH'],
    [w=>w.app.id=gid('AppInstallation','9'),'REMOTE_APP_MISMATCH'],[w=>w.app.app.id=gid('App','9'),'REMOTE_APP_MISMATCH'],
    [w=>w.location.id=gid('Location','9'),'INVENTORY_LOCATION_MISMATCH'],[w=>w.location.isActive=false,'INVENTORY_LOCATION_MISMATCH'],[w=>w.location.fulfillsOnlineOrders=false,'INVENTORY_LOCATION_MISMATCH'],
    [w=>w.themes.nodes[0].id=gid('OnlineStoreTheme','9'),'LIVE_THEME_CHANGED'],[w=>w.themes.pageInfo.hasNextPage=true,'LIVE_THEME_CHANGED']
  ];
  for(const [change,code]of changes){const world=mockWorld();change(world);await reject(transport(world).preflight(request()),code);assert.equal(world.mutations,0);}
  for(const scope of scopes){const world=mockWorld();world.app.accessScopes=world.app.accessScopes.filter(s=>s.handle!==scope);await reject(transport(world).preflight(request()),'REQUIRED_SCOPES_MISSING');assert.equal(world.mutations,0);}
});

test('package, owner, intent, expected payload and fixed development location are inseparable',async()=>{
  const world=mockWorld(),adapter=transport(world);
  for(const field of ['ownerHash','intentHash','planHash','packageBytesHash'])await reject(adapter.preflight(request({binding:{...f.binding,[field]:'f'.repeat(64)}})),'REQUEST_BINDING_MISMATCH');
  for(const step of [{...f.step,action:'update'},{...f.step,payloadHash:'f'.repeat(64)},{...f.step,expected:{...f.step.expected,status:'ACTIVE'}}])await reject(adapter.preflight(request({step})),'CATALOG_STEP_MISMATCH');
  await reject(adapter.preflight(request({dependencies:{other:{}}})),'CATALOG_STEP_MISMATCH');await reject(adapter.preflight(request({step:{...f.step,kind:'page'}})),'UNSUPPORTED_STEP');
  assert.throws(()=>transport(world,{inventoryLocationId:'9'}),{code:'SHOPIFY_BASIC_CATALOG_BINDING_MISMATCH'});assert.equal(world.calls.length,0);
});

test('existing handle is never updated/adopted and ambiguous search fails closed',async()=>{
  const world=mockWorld({products:[{id:gid('Product','9'),handle:f.product.handle}]});await reject(transport(world).preflight(request()),'HANDLE_ALREADY_EXISTS');assert.equal(world.mutations,0);
  world.products.push({id:gid('Product','8'),handle:f.product.handle});await reject(transport(world).preflight(request()),'HANDLE_LOOKUP_AMBIGUOUS');
});

test('fresh post-claim preflight required and a new attempt ID cannot repeat a sent product creation',async()=>{
  const world=mockWorld(),adapter=transport(world),req=request();await reject(adapter.apply(req),'FRESH_PREFLIGHT_REQUIRED');
  await adapter.preflight({...req,attemptId:null});await reject(adapter.apply(req),'FRESH_PREFLIGHT_REQUIRED');await adapter.preflight(req);await adapter.apply(req);
  await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');await reject(adapter.apply({...req,attemptId:crypto.randomUUID()}),'ATTEMPT_ALREADY_SENT');assert.equal(world.mutations,1);
});

test('failed refreshed preflight revokes previous check; caller mutation during a request is isolated',async()=>{
  const world=mockWorld(),adapter=transport(world),req=request();await adapter.preflight(req);world.location.isActive=false;await reject(adapter.preflight(req),'INVENTORY_LOCATION_MISMATCH');await reject(adapter.apply(req),'FRESH_PREFLIGHT_REQUIRED');assert.equal(world.mutations,0);
  world.location.isActive=true;const promise=adapter.preflight(req);req.step.expected.title='tamper';await promise;await reject(adapter.apply(req),'CATALOG_STEP_MISMATCH');
});

test('lost create response stays unknown with no mutation retry, no handle adoption or restart recovery',async()=>{
  const world=mockWorld(),normal=world.fetch;world.fetch=async(url,options)=>{const r=await normal(url,options);if(JSON.parse(options.body).query===operations.create)throw Error(token);return r;};
  const adapter=transport(world),req=request();await adapter.preflight(req);await reject(adapter.apply(req),'REQUEST_FAILED');const before=world.calls.length;
  assert.equal((await adapter.readback(readReq(req))).outcome,'unknown');assert.equal(world.calls.length,before);await reject(adapter.preflight(req),'HANDLE_ALREADY_EXISTS');await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');assert.equal(world.mutations,1);
  const restarted=transport(world);assert.equal((await restarted.readback({...readReq(req),mode:'reconcile'})).outcome,'unknown');await reject(restarted.preflight(req),'HANDLE_ALREADY_EXISTS');
});

test('readback derives all remote fields and detects changed title, body, option, SKU, price, stock, tracking and weight',async()=>{
  const changes=[
    p=>p.title+='changed',p=>p.handle+='changed',p=>p.descriptionHtml+='changed',p=>p.vendor+='changed',p=>p.productType+='changed',p=>p.status='ACTIVE',p=>p.tags=[],
    p=>p.options[0].optionValues[0].name='wrong',p=>p.variants.nodes[0].sku='wrong',p=>p.variants.nodes[0].price='0.01',p=>p.variants.nodes[0].inventoryPolicy='CONTINUE',
    p=>p.variants.nodes[0].inventoryItem.tracked=false,p=>p.variants.nodes[0].inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity=999,p=>p.variants.nodes[0].inventoryItem.measurement.weight.value=1,
    p=>p.variants.nodes[2].inventoryItem.measurement.weight={unit:'GRAMS',value:1}
  ];
  for(const change of changes){const {world,adapter,req}=await created();change(world.products[0]);await assert.rejects(adapter.readback(readReq(req)));assert.equal(world.mutations,1);}
});

test('publication or scheduled publication, missing pages and extra inventory location cannot be certified',async()=>{
  for(const changed of [
    p=>p.resourcePublicationsCount.count=1,
    p=>p.resourcePublicationsCount.precision='AT_LEAST',p=>p.variants.pageInfo.hasNextPage=true,p=>p.variants.nodes.pop(),p=>p.variants.nodes.push(structuredClone(p.variants.nodes[0])),
    p=>p.variants.nodes[0].inventoryItem.inventoryLevels.nodes.push({location:{id:gid('Location','9')},quantities:[{name:'available',quantity:0}]}),
    p=>p.variants.nodes[0].inventoryItem.inventoryLevels.pageInfo.hasNextPage=true,p=>p.variants.nodes[0].inventoryItem.inventoryLevels.nodes[0].location.id=gid('Location','9'),
    p=>p.variants.nodes[0].inventoryItem.inventoryLevels.nodes[0].quantities=[]
  ]){const {world,adapter,req}=await created();changed(world.products[0]);await assert.rejects(adapter.readback(readReq(req)));}
});

test('duplicate/missing/reassigned variant identities and non-exact money or weight are rejected',async()=>{
  for(const change of [
    p=>p.variants.nodes[1].id=p.variants.nodes[0].id,p=>p.variants.nodes[1].inventoryItem.id=p.variants.nodes[0].inventoryItem.id,
    p=>p.variants.nodes[0].selectedOptions[0].value='wrong',p=>p.variants.nodes[0].selectedOptions.push(p.variants.nodes[0].selectedOptions[0]),
    p=>p.variants.nodes[0].price=0,p=>p.variants.nodes[0].price='0.001',p=>p.variants.nodes[0].price='1e3',p=>p.variants.nodes[0].price='900719925474099999',
    p=>p.variants.nodes[0].inventoryItem.measurement={},p=>p.variants.nodes[0].inventoryItem.measurement.weight={unit:'KILOGRAMS',value:0},
    p=>p.variants.nodes[0].inventoryItem.measurement.weight={unit:'GRAMS',value:0.1},p=>p.variants.nodes[0].inventoryItem.requiresShipping=false
  ]){const {world,adapter,req}=await created();change(world.products[0]);await assert.rejects(adapter.readback(readReq(req)));}
});

test('readback rechecks exact app/store/location and never accepts mutation response as receipt',async()=>{
  const {world,adapter,req}=await created();world.location.id=gid('Location','9');await reject(adapter.readback(readReq(req)),'INVENTORY_LOCATION_MISMATCH');
  world.location.id=gid('Location',inventoryLocationId);world.products=[];assert.equal((await adapter.readback(readReq(req))).outcome,'unknown');
});

test('provider errors are sanitized, partial success remains unknown and cannot run again',async()=>{
  for(const mode of ['errors','partial','empty']){
    const world=mockWorld(),normal=world.fetch;world.fetch=async(url,options)=>{if(JSON.parse(options.body).query!==operations.create)return normal(url,options);world.mutations++;
      return mode==='errors'?new Response(JSON.stringify({errors:[{message:token}]}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}):response({productSet:{product:mode==='partial'?{id:gid('Product','101')}:null,userErrors:mode==='partial'?[{message:token}]:[]}});};
    const adapter=transport(world),req=request();await adapter.preflight(req);await assert.rejects(adapter.apply(req),error=>!String(error).includes(token));
    assert.equal((await adapter.readback(readReq(req))).outcome,'unknown');await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');assert.equal(world.mutations,1);
  }
});

test('HTTP failure, fallback API, redirects and streamed oversize never trigger request retry',async()=>{
  const cases=[
    [()=>response({}, {status:429}),'HTTP_FAILURE'],[()=>response({}, {headers:{'content-type':'application/json','x-shopify-api-version':'2026-07'}}),'API_VERSION_MISMATCH'],
    [()=>new Response('html',{headers:{'content-type':'text/html','x-shopify-api-version':'2026-10'}}),'NON_JSON_RESPONSE'],
    [()=>{const r=response({});Object.defineProperty(r,'redirected',{value:true});return r;},'REDIRECT_OR_WRONG_RESPONSE_ORIGIN'],
    [()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}}),'RESPONSE_TOO_LARGE']
  ];
  for(const [make,code]of cases){const world=mockWorld({handler:make});await reject(transport(world).preflight(request()),code);assert.equal(world.calls.length,1);}
});

test('abort marks an apply attempt as sent even when the injected transport ignores the signal',async()=>{
  const world=mockWorld(),normal=world.fetch;world.fetch=(url,options)=>JSON.parse(options.body).query===operations.create?new Promise(()=>{}):normal(url,options);
  const adapter=transport(world),req=request();await adapter.preflight(req);const controller=new AbortController(),pending=adapter.apply(req,{signal:controller.signal});controller.abort();await reject(pending,'REQUEST_ABORTED');await reject(adapter.apply(req),'ATTEMPT_ALREADY_SENT');
});

test('omitted weight accepts only the platform zero default and keeps unknown in the receipt',async()=>{const{world,adapter,req}=await created();world.products[0].variants.nodes[2].inventoryItem.measurement.weight={unit:'KILOGRAMS',value:0};const result=await adapter.readback(readReq(req));assert.equal(result.observed.variants[2].weightGrams,null);});
test('explicitly reviewed known catalog ID can reconcile without another create; altered scope is rejected',async()=>{const{world,req}=await created();const recovery={intentHash:f.binding.intentHash,key:req.step.key,attemptId:req.attemptId,remoteId:world.products[0].id.split('/').at(-1)};const restored=transport(world,{catalogRecovery:recovery});await restored.preflight({...req,mode:'reconcile'});assert.equal((await restored.readback({...readReq(req),mode:'reconcile'})).outcome,'found');await reject(restored.apply(req),'ATTEMPT_ALREADY_SENT');assert.equal(world.mutations,1);assert.throws(()=>transport(world,{catalogRecovery:{...recovery,intentHash:'e'.repeat(64)}}),{code:'SHOPIFY_BASIC_CATALOG_RECOVERY_BINDING'});const wrong=transport(world,{catalogRecovery:{...recovery,remoteId:'999'}});await reject(wrong.preflight(req),'HANDLE_ALREADY_EXISTS');});
