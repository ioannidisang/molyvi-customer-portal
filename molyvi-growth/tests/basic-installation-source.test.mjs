import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {TaskStore} from '../lib/task-store.mjs';
import {canonicalJson} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {prepareStoredBasicReferenceComposition} from '../lib/basic-reference-composition.mjs';
import {createBasicInstallationSource,isBasicInstallationSource,verifyBasicInstallationSource} from '../lib/basic-installation-source.mjs';
import {createShopifyImageDecoder} from '../lib/shopify-image-decoder.mjs';
import {createShopifyBasicMediaTransport,SHOPIFY_BASIC_MEDIA_OPERATIONS as OPS,SHOPIFY_BASIC_MEDIA_SCOPES as SCOPES} from '../lib/shopify-basic-media.mjs';

const sharp=createRequire(import.meta.url)('sharp'),decode=createShopifyImageDecoder({sharp});
const png=await sharp({create:{width:96,height:64,channels:3,background:'#a2b4c8'}}).png().toBuffer();
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),hash=value=>sha(canonicalJson(value));
const targetStore='molyvi-still-dev.myshopify.com',shopId='108668748113',liveThemeId='207379235153',token='shpat_SYNTHETIC_ONLY_0123456789';
const gid=(kind,id)=>`gid://shopify/${kind}/${id}`;
async function fixture(t,{logo=false,productCount=1,decodeImage=decode}={}){
  const tmp=await fs.realpath(os.tmpdir()),base=await fs.mkdtemp(path.join(tmp,'molyvi-install-source-'));
  t.after(async()=>{const actual=await fs.realpath(base);assert.equal(path.dirname(actual),tmp);assert.equal(path.basename(actual),path.basename(base));assert(path.basename(actual).startsWith('molyvi-install-source-'));await fs.rm(actual,{recursive:true});});
  const image=()=>({bytes:png,name:'photo.png',mime:'image/png'});
  const f=createBasicAssemblyFixture({productCount,sizeProductCount:1,sourceImage:image,generatedImage:image,...(logo?{logoImage:image}:{})});
  const storage=path.join(base,'storage');await fs.mkdir(storage);const store=new TaskStore(storage);await store.create(f.record);
  const directory=await store.directory(f.record.id);
  for(const [items,prefix]of [[f.options.sourceAssets,'photo'],[f.options.assets,'generated'],[f.options.logo?[f.options.logo]:[],'logo']])
    for(const {asset,bytes}of items)await fs.writeFile(path.join(directory,`${prefix}-${asset.id}.bin`),bytes,{flag:'wx'});
  const session={projectId:f.record.id,ownerId:f.record.ownerId},binding=createBasicAssemblyBinding(f.record,f.options);
  const reference=await prepareStoredBasicReferenceComposition(store,session,{targetStore,binding,decodeImage});
  const prepared=prepareBasicStorePackage(f.record,{...f.options,binding});
  return {...f,base,store,directory,session,reference,prepared};
}
async function changeRecord(f){
  const record=structuredClone(f.record);record.updatedAt='2099-01-01T00:00:00.000Z';
  await fs.writeFile(path.join(f.directory,'workspace.json'),JSON.stringify(record));
}
async function changeOriginal(f){
  const file=path.join(f.directory,`photo-${f.options.sourceAssets[0].asset.id}.bin`),bytes=await fs.readFile(file);bytes[bytes.length-1]^=255;await fs.writeFile(file,bytes);
}
function defer(){let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:(...args)=>resolve(...args)};}

function mediaWorld(f,{onGraph,onUpload,onCdn,legacy=false}={}){
  const source=createBasicInstallationSource({referenceComposition:f.reference}),plan=source.plan,product=plan.products[0];
  const binding={intentHash:'1'.repeat(64),targetStore,projectId:plan.projectId,ownerHash:plan.binding.ownerHash,planHash:plan.planHash,themeZipSha256:'2'.repeat(64),packageBytesHash:hash({plan,uploads:source.uploads})};
  const expected={handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.type,optionNames:product.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId:'125398417745',variants:product.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};
  const parent={remoteId:'100',payloadHash:hash(expected),observed:{...expected,variants:expected.variants.map((v,i)=>({...v,remoteId:String(200+i)}))}};
  const w={calls:[],uploads:[],files:new Map(),cdn:0,source,product};
  const remote={id:gid('Product','100'),handle:product.handle,title:product.title,descriptionHtml:product.descriptionHtml,vendor:product.vendor,productType:product.type,status:'DRAFT',options:product.optionNames.map(name=>({name})),resourcePublicationsCount:{count:0,precision:'EXACT'},variants:{nodes:product.variants.map((v,i)=>({id:gid('ProductVariant',String(200+i)),sku:v.sku??'',price:(v.priceMinor/100).toFixed(2),selectedOptions:product.optionNames.map((name,j)=>({name,value:v.optionValues[j]}))})),pageInfo:{hasNextPage:false}},media:{nodes:[],pageInfo:{hasNextPage:false}}};
  const identity=()=>({shop:{id:gid('Shop',shopId),myshopifyDomain:targetStore,currencyCode:'EUR'},currentAppInstallation:{id:gid('AppInstallation','1195450433873'),app:{id:gid('App','436878311425')},accessScopes:SCOPES.map(handle=>({handle}))},themes:{nodes:[{id:gid('OnlineStoreTheme',liveThemeId),role:'MAIN'}],pageInfo:{hasNextPage:false}}});
  const response=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
  w.fetch=async(url,options)=>{
    const {query,variables:v}=JSON.parse(options.body);w.calls.push(query);await onGraph?.(query,w);
    if(query===OPS.preflight||query===OPS.readback)return response({...identity(),product:remote});
    if(query===OPS.stage){const p=v.input[0];return response({stagedUploadsCreate:{userErrors:[],stagedTargets:[{url:'https://shopify-staged-uploads.storage.googleapis.com/',resourceUrl:`https://shopify-staged-uploads.storage.googleapis.com/tmp/${p.filename}`,parameters:[{name:'key',value:`tmp/${p.filename}`},{name:'Content-Type',value:p.mimeType}]}]}});}
    if(query===OPS.create){const file={id:gid('MediaImage',String(500+w.files.size)),alt:v.files[0].alt,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',image:{url:`https://cdn.shopify.com/s/files/1/1086/6874/8113/files/${v.files[0].filename}`,width:96,height:64}};w.files.set(file.id,file);return response({fileCreate:{files:[{id:file.id}],userErrors:[]}});}
    if(query===OPS.processing)return response({...identity(),node:w.files.get(v.id)});
    if(query===OPS.attach){const file=w.files.get(v.files[0].id);remote.media.nodes.push(file);return response({fileUpdate:{files:[{id:file.id}],userErrors:[]}});}
    assert.fail('unexpected operation');
  };
  w.uploadFetch=async(url,options)=>{
    if(options.method==='POST'){
      w.uploads.push({sha256:sha(Buffer.from(await options.body.get('file').arrayBuffer())),bytes:options.body.get('file').size});
      await onUpload?.(w,options);return new Response(null,{status:204});
    }
    w.cdn++;await onCdn?.(w);return new Response(png,{headers:{'content-type':'image/png'}});
  };
  w.adapter=createShopifyBasicMediaTransport({...(legacy?{prepared:f.prepared}:{referenceComposition:f.reference}),binding,liveThemeId,accessToken:token,fetchImpl:w.fetch,uploadFetch:w.uploadFetch,decodeImage:decode,networkEnabled:true});
  w.request=(position=1)=>{
    const p=product.photos[position-1],e={parentKey:`catalog:${product.productId}`,position:p.position,sourceSha256:p.sha256,alt:p.alt};
    const step={key:`media:${product.productId}:${position}`,kind:'media',action:'create',expected:e,payloadHash:hash(e),dependsOn:[e.parentKey]};
    return {binding:structuredClone(binding),trustedShop:{shopId,targetStore},step,dependencies:{[e.parentKey]:structuredClone(parent)},attemptId:crypto.randomUUID()};
  };
  w.readRequest=r=>({...r,readRequestId:crypto.randomUUID(),mode:'after_apply'});
  return w;
}

test('genuine reference source preserves exact legacy plan/hash including logo-first order',async t=>{
  const f=await fixture(t,{logo:true,productCount:2}),s=createBasicInstallationSource({referenceComposition:f.reference});
  const legacy=createBasicInstallationSource({prepared:f.prepared});
  assert.deepEqual(s.plan,legacy.plan);assert.deepEqual(s.uploads,legacy.uploads);
  assert.equal(s.uploads[0].fileName,'branding/logo.png');assert.equal(f.reference.assets.at(-1).fileName,'branding/logo.png');
  assert.equal(hash({plan:s.plan,uploads:s.uploads}),hash({plan:f.prepared.plan,uploads:legacy.uploads}));
  assert(Object.isFrozen(s.plan.products[0]));assert(Object.isFrozen(s.uploads[0]));
  assert(!JSON.stringify(s).includes('"type":"Buffer"'));assert(!JSON.stringify(s).includes(png.toString('base64')));
  assert(isBasicInstallationSource(s));assert.equal(verifyBasicInstallationSource(s),s.plan);
  for(const forged of [{...s},Object.create(s),{},null])assert.throws(()=>verifyBasicInstallationSource(forged),{code:'BASIC_INSTALLATION_SOURCE_CAPABILITY_REQUIRED'});
  for(const options of [{},{prepared:f.prepared,referenceComposition:f.reference},{referenceComposition:{...f.reference}}])assert.throws(()=>createBasicInstallationSource(options));
});

test('legacy metadata mode retains no bytes; media opt-in snapshots bytes and exact caller ordering',async t=>{
  const f=await fixture(t,{logo:true});f.prepared.uploads.reverse();
  const metadata=createBasicInstallationSource({prepared:f.prepared}),owned=createBasicInstallationSource({prepared:f.prepared,retainLegacyBytes:true});
  assert.deepEqual(owned.uploads.map(a=>a.fileName),f.prepared.uploads.map(a=>a.fileName));
  await assert.rejects(metadata.withAsset(metadata.uploads[0].fileName,()=>{}),{code:'BASIC_INSTALLATION_SOURCE_LEGACY_BYTES_NOT_RETAINED'});
  const expected=owned.uploads[0];f.prepared.uploads[0].bytes[0]^=255;
  assert.equal(await owned.withAsset(expected.fileName,({bytes})=>sha(bytes)),expected.sha256);
  await assert.rejects(owned.withAsset(expected.fileName,({bytes})=>{bytes[0]^=255;}),{code:'BASIC_INSTALLATION_SOURCE_CONSUMER_CHANGED_BYTES'});
  assert.equal(await owned.withAsset(expected.fileName,({bytes})=>sha(bytes)),expected.sha256);
  const fn=()=>{};assert.equal(owned.guardFetch(fn),fn);assert.equal(owned.guardMethod(fn),fn);
});

test('reference sources reject stale originals/records before guarded work and after an operation',async t=>{
  for(const change of [changeOriginal,changeRecord]){
    const f=await fixture(t),s=createBasicInstallationSource({referenceComposition:f.reference});await change(f);let calls=0;
    await assert.rejects(s.guardFetch(async()=>{calls++;})(targetStore,{}));assert.equal(calls,0);
  }
  const f=await fixture(t),s=createBasicInstallationSource({referenceComposition:f.reference});let called=0;
  await assert.rejects(s.guardFetch(async()=>{called++;await changeRecord(f);return 'not accepted';})(targetStore,{}));
  assert.equal(called,1);
});

test('guards stop an already aborted request and an abort while source validation is pending',async t=>{
  for(const method of ['guardFetch','guardMethod']){
    const f=await fixture(t),s=createBasicInstallationSource({referenceComposition:f.reference}),controller=new AbortController();let calls=0;
    const invoke=s[method](async()=>{calls++;});controller.abort();
    await assert.rejects(invoke({}, {signal:controller.signal}),{code:'BASIC_INSTALLATION_SOURCE_REQUEST_ABORTED'});assert.equal(calls,0);
    const hold=defer(),entered=defer(),serial=f.store.serial.bind(f.store);f.store.serial=async(...args)=>{entered.resolve();await hold.promise;return serial(...args);};
    const c=new AbortController(),pending=invoke({}, {signal:c.signal});await entered.promise;c.abort();hold.resolve();
    await assert.rejects(pending,{code:'BASIC_INSTALLATION_SOURCE_REQUEST_ABORTED'});assert.equal(calls,0);
  }
});

test('method request is snapshotted before source awaits without cloning the abort signal',async t=>{
  const f=await fixture(t),s=createBasicInstallationSource({referenceComposition:f.reference}),hold=defer(),entered=defer(),serial=f.store.serial.bind(f.store);
  let once=true;f.store.serial=async(...args)=>{if(once){once=false;entered.resolve();await hold.promise;}return serial(...args);};
  const input={parent:'original'},controller=new AbortController(),options={signal:controller.signal,mode:'original'};
  const work=s.guardMethod(async(request,current)=>{assert.equal(current.signal,controller.signal);assert.equal(current.mode,'original');return request.parent;})(input,options);
  await entered.promise;input.parent='changed';options.signal=new AbortController().signal;options.mode='changed';hold.resolve();assert.equal(await work,'original');
});

test('reference media uploads sequential exact bytes without nested source validation',async t=>{
  const f=await fixture(t,{logo:true}),w=mediaWorld(f);
  for(let i=1;i<=3;i++){const r=w.request(i);await w.adapter.preflight(r);await w.adapter.apply(r);const receipt=await w.adapter.readback(w.readRequest(r));assert.equal(receipt.outcome,'found');assert.equal(receipt.observed.position,i);assert.equal(receipt.provenance.cdnBytesEqualSource,true);}
  assert.equal(w.uploads.length,3);assert.equal(w.cdn,3);
  assert(w.uploads.every(u=>u.sha256===sha(png)&&u.bytes===png.length));
  assert.equal(w.calls.filter(c=>c===OPS.stage).length,3);assert.equal(w.calls.filter(c=>c===OPS.create).length,3);
});

test('source changes after staging or upload stop the attempt before fileCreate and cannot replay',async t=>{
  for(const when of ['stage','upload']){
    const f=await fixture(t),w=mediaWorld(f,when==='stage'?{onGraph:async query=>{if(query===OPS.stage)await changeRecord(f);}}:{onUpload:async()=>{await changeOriginal(f);}});
    const r=w.request();await w.adapter.preflight(r);await assert.rejects(w.adapter.apply(r));
    assert.equal(w.calls.filter(c=>c===OPS.stage).length,1);assert.equal(w.uploads.length,when==='upload'?1:0);assert.equal(w.files.size,0);
    const before=w.calls.length;await assert.rejects(w.adapter.apply(r));assert.equal(w.calls.length,before);
  }
});

test('source changes during CDN retrieval prevent accepting a loaded receipt',async t=>{
  const f=await fixture(t),w=mediaWorld(f,{onCdn:async()=>{await changeRecord(f);}}),r=w.request();
  await w.adapter.preflight(r);await w.adapter.apply(r);await assert.rejects(w.adapter.readback(w.readRequest(r)));
  assert.equal(w.cdn,1);assert.equal(w.files.size,1);
});

test('abort during selected image decode prevents upload after a successful staging request',async t=>{
  const controller=new AbortController();let cancelOnDecode=false;
  const f=await fixture(t,{decodeImage:async(...args)=>{const result=await decode(...args);if(cancelOnDecode)controller.abort();return result;}}),w=mediaWorld(f),r=w.request();
  await w.adapter.preflight(r);cancelOnDecode=true;await assert.rejects(w.adapter.apply(r,{signal:controller.signal}));
  assert.equal(w.calls.filter(c=>c===OPS.stage).length,1);assert.equal(w.uploads.length,0);assert.equal(w.files.size,0);
  await assert.rejects(w.adapter.apply(r),{code:'SHOPIFY_BASIC_MEDIA_ATTEMPT_ALREADY_SENT'});
});

test('advisory abort does not release the asset lease while actual upload remains unsettled',async t=>{
  const hold=defer(),entered=defer(),controller=new AbortController(),f=await fixture(t);
  const w=mediaWorld(f,{onUpload:async()=>{entered.resolve();await hold.promise;}}),r=w.request();
  await w.adapter.preflight(r);const applying=w.adapter.apply(r,{signal:controller.signal});
  let settled=false;const result=applying.then(()=>{settled=true;assert.fail('aborted upload accepted');},error=>{settled=true;return error;});
  await entered.promise;controller.abort();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);await assert.rejects(f.reference.revalidate(),{code:'BASIC_REFERENCE_COMPOSITION_CONCURRENT_READ'});
  hold.resolve();assert((await result).code.endsWith('REQUEST_ABORTED'));await f.reference.revalidate();
  assert.equal(w.uploads.length,1);assert.equal(w.files.size,0);await assert.rejects(w.adapter.apply(r),{code:'SHOPIFY_BASIC_MEDIA_ATTEMPT_ALREADY_SENT'});
  assert.equal((await w.adapter.readback(w.readRequest(r))).outcome,'unknown');
});

test('legacy upload keeps its previous prompt abort behavior for a non-cooperative client',async t=>{
  const hold=defer(),entered=defer(),controller=new AbortController(),f=await fixture(t);
  const w=mediaWorld(f,{legacy:true,onUpload:async()=>{entered.resolve();await hold.promise;}}),r=w.request();
  await w.adapter.preflight(r);const applying=w.adapter.apply(r,{signal:controller.signal});
  const rejected=assert.rejects(applying,{code:'SHOPIFY_BASIC_MEDIA_REQUEST_ABORTED'});
  await entered.promise;controller.abort();await rejected;assert.equal(w.files.size,0);
  hold.resolve();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(w.adapter.apply(r),{code:'SHOPIFY_BASIC_MEDIA_ATTEMPT_ALREADY_SENT'});
});
