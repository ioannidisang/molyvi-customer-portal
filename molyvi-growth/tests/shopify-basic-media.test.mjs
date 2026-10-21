import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {canonicalJson} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {createShopifyBasicMediaTransport,SHOPIFY_BASIC_MEDIA_OPERATIONS as OPS,SHOPIFY_BASIC_MEDIA_SCOPES as SCOPES} from '../lib/shopify-basic-media.mjs';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonicalJson(v)),gid=(kind,id)=>`gid://shopify/${kind}/${id}`;
const token='shpat_SYNTHETIC_ONLY_0123456789',targetStore='molyvi-still-dev.myshopify.com',shopId='108668748113',liveThemeId='207379235153';
const reject=(promise,code)=>assert.rejects(promise,{code:`SHOPIFY_BASIC_MEDIA_${code}`});
let prepared,binding,product,parent;
test.before(()=>{
 const f=createBasicAssemblyFixture({productCount:1,sizeProductCount:1});prepared=prepareBasicStorePackage(f.record,{...f.options,binding:createBasicAssemblyBinding(f.record,f.options)});
 const plan=prepared.plan,uploads=prepared.uploads.map(u=>({fileName:u.fileName,sha256:sha(u.bytes),bytes:u.bytes.length}));
 binding={intentHash:'1'.repeat(64),targetStore,projectId:plan.projectId,ownerHash:plan.binding.ownerHash,planHash:plan.planHash,themeZipSha256:'2'.repeat(64),packageBytesHash:hash({plan,uploads})};product=plan.products[0];
 const expected={handle:product.handle,title:product.title,descriptionHtmlSha256:sha(product.descriptionHtml),vendor:product.vendor,productType:product.type,optionNames:product.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId:'125398417745',variants:product.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};
 parent={remoteId:'100',payloadHash:hash(expected),observed:{...expected,variants:expected.variants.map((v,i)=>({...v,remoteId:String(200+i)}))},evidence:{synthetic:true}};
});
function request(position=1,extra={}){
 const p=product.photos[position-1],expected={parentKey:`catalog:${product.productId}`,position:p.position,sourceSha256:p.sha256,alt:p.alt},step={key:`media:${product.productId}:${position}`,kind:'media',action:'create',expected,payloadHash:hash(expected),dependsOn:[expected.parentKey]};
 return {binding:structuredClone(binding),trustedShop:{shopId,targetStore},step,dependencies:{[expected.parentKey]:structuredClone(parent)},attemptId:crypto.randomUUID(),...extra};
}
const response=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
function world(options={}){
 const w={calls:[],http:[],files:new Map(),uploads:[],decoded:0,scopes:SCOPES,appId:'436878311425',installationId:'1195450433873',stageHost:'shopify-staged-uploads.storage.googleapis.com',...options};
 w.product={id:gid('Product','100'),handle:product.handle,title:product.title,descriptionHtml:product.descriptionHtml,vendor:product.vendor,productType:product.type,status:'DRAFT',options:product.optionNames.map(name=>({name})),resourcePublicationsCount:{count:0,precision:'EXACT'},variants:{nodes:product.variants.map((v,i)=>({id:gid('ProductVariant',String(200+i)),sku:v.sku??'',price:(v.priceMinor/100).toFixed(2),selectedOptions:product.optionNames.map((name,j)=>({name,value:v.optionValues[j]}))})),pageInfo:{hasNextPage:false}},media:{nodes:[],pageInfo:{hasNextPage:false}}};
 const identity=()=>({shop:{id:gid('Shop',w.wrongShop?'999':shopId),myshopifyDomain:targetStore,currencyCode:'EUR'},currentAppInstallation:{id:gid('AppInstallation',w.installationId),app:{id:gid('App',w.appId)},accessScopes:w.scopes.map(handle=>({handle}))},themes:{nodes:[{id:gid('OnlineStoreTheme',liveThemeId),role:'MAIN'}],pageInfo:{hasNextPage:false}}});
 w.fetch=async(url,opts)=>{
  const {query,variables:v}=JSON.parse(opts.body);w.calls.push({url,opts,query,variables:v});if(w.onCall)await w.onCall(query,v);
  if(query===OPS.preflight||query===OPS.readback)return response({...identity(),product:w.product});
  if(query===OPS.stage){const f=v.input[0];return response({stagedUploadsCreate:{userErrors:[],stagedTargets:[{url:`https://${w.stageHost}/`,resourceUrl:`https://${w.stageHost}/tmp/${f.filename}`,parameters:w.parameters??[{name:'key',value:`tmp/${f.filename}`},{name:'Content-Type',value:f.mimeType},{name:'policy',value:'SYNTHETIC'}]}]}});}
  if(query===OPS.create){if(w.failCreate)throw Error(`secret ${token}`);const file={id:gid('MediaImage',String(500+w.files.size)),alt:v.files[0].alt,mediaContentType:'IMAGE',status:'READY',fileStatus:w.pending?'PROCESSING':'READY',image:{url:`https://cdn.shopify.com/s/files/1/1086/6874/8113/files/${v.files[0].filename}`,width:1,height:1}};w.files.set(file.id,file);return response({fileCreate:{files:[{id:file.id}],userErrors:[]}});}
  if(query===OPS.processing)return response({...identity(),node:w.files.get(v.id)});
  if(query===OPS.attach){const file=w.files.get(v.files[0].id);w.product.media.nodes.push(file);if(w.failAttach)throw Error(`secret ${token}`);return response({fileUpdate:{files:[{id:file.id}],userErrors:[]}});}
  throw Error('UNEXPECTED_OPERATION');
 };
 w.uploadFetch=async(url,opts)=>{
  w.http.push({url,opts});if(opts.method==='POST'){const bytes=Buffer.from(await opts.body.get('file').arrayBuffer());w.uploads.push(bytes);if(w.failUpload)throw Error(token);return new Response('',{status:201});}
  return new Response(w.cdnBytes??prepared.uploads.find(u=>u.fileName===product.photos[0].fileName).bytes,{headers:{'content-type':w.cdnMime??'image/png'}});
 };
 // Trusted decoder seam is deliberately mocked here; independent integration uses real sharp.
 w.decodeImage=async(bytes,config)=>{w.decoded++;w.decoderInput={bytes,config};return {decoded:!w.invalidDecoded,mime:config.mime,width:w.decodedWidth??1,height:1};};
 return w;
}
const adapter=(w,extra={})=>createShopifyBasicMediaTransport({prepared,binding,liveThemeId,accessToken:token,fetchImpl:w.fetch,uploadFetch:w.uploadFetch,decodeImage:w.decodeImage,networkEnabled:true,...extra});
const readReq=r=>({...r,readRequestId:crypto.randomUUID(),mode:'after_apply'});
async function create(w=world()){const a=adapter(w),r=request();await a.preflight(r);await a.apply(r);return {w,a,r};}

test('network off by default and explicit fetch/upload/decoder dependencies required',async()=>{
 const w=world();await reject(adapter(w,{networkEnabled:false}).preflight(request()),'NETWORK_DISABLED');assert.equal(w.calls.length,0);
 for(const name of ['fetchImpl','uploadFetch','decodeImage'])assert.throws(()=>adapter(w,{[name]:undefined}),{code:'SHOPIFY_BASIC_MEDIA_TRANSPORT_CONFIGURATION_INVALID'});
});
test('exact source multipart upload, create-only filename mode, exact parent association and independently decoded gallery readback',async()=>{
 const {w,a,r}=await create();await a.preflight(r);const result=await a.readback(readReq(r));
 assert.equal(result.outcome,'found');assert.equal(result.remoteId,'500');assert.deepEqual(result.observed,{parentRemoteId:'100',position:1,sourceSha256:product.photos[0].sha256,alt:product.photos[0].alt,loaded:true});
 assert.equal(w.decoded,1);assert.equal(sha(w.uploads[0]),product.photos[0].sha256);assert.equal(result.provenance.visualFidelityCertified,false);assert.equal(result.provenance.cdnBytesEqualSource,true);
 assert.equal(w.calls.filter(c=>c.query===OPS.stage).length,1);assert.equal(w.calls.filter(c=>c.query===OPS.create).length,1);assert.equal(w.calls.filter(c=>c.query===OPS.attach).length,1);
 assert.equal(w.calls.find(c=>c.query===OPS.create).variables.files[0].duplicateResolutionMode,'RAISE_ERROR');assert.deepEqual(w.calls.find(c=>c.query===OPS.attach).variables,{files:[{id:gid('MediaImage','500'),referencesToAdd:[gid('Product','100')]}]});
 for(const {url,opts} of w.calls){assert.equal(url,`https://${targetStore}/admin/api/2026-10/graphql.json`);assert.equal(opts.headers['X-Shopify-Access-Token'],token);assert.equal(opts.redirect,'error');}
 for(const {opts} of w.http){assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');assert(!JSON.stringify(opts.headers??{}).includes(token));}
 assert(!JSON.stringify(result).includes(token));
});
test('CDN reencoding is recorded separately and never replaces original source provenance',async()=>{
 const {w,a,r}=await create(world({cdnBytes:Buffer.from('SYNTHETIC_REENCODED_BYTES')}));const out=await a.readback(readReq(r));assert.equal(out.provenance.cdnBytesEqualSource,false);assert.equal(out.observed.sourceSha256,product.photos[0].sha256);assert.notEqual(out.provenance.cdn.sha256,out.observed.sourceSha256);assert.equal(w.decoded,1);
});
test('wrong shop/app, insufficient grant and changed parent data fail before staging',async()=>{
 for(const options of [{wrongShop:true},{appId:'999'},{installationId:'999'},{scopes:['read_themes']}]){const w=world(options);await assert.rejects(adapter(w).preflight(request()));assert.equal(w.uploads.length,0);assert.equal(w.calls.length,1);}
 for(const modify of [p=>p.status='ACTIVE',p=>p.handle='wrong',p=>p.title='wrong',p=>p.variants.nodes[0].price='0.01',p=>p.resourcePublicationsCount.count=1,p=>p.resourcePublicationsCount.precision='AT_LEAST']){const w=world();modify(w.product);await assert.rejects(adapter(w).preflight(request()));assert(!w.calls.some(c=>c.query===OPS.stage));}
});
test('tampered owner/plan/step/parent receipt blocked without network',async()=>{
 for(const mutate of [r=>r.binding.ownerHash='e'.repeat(64),r=>r.step.expected.alt='wrong',r=>r.dependencies[r.step.expected.parentKey].observed.variants[0].priceMinor++,r=>r.dependencies[r.step.expected.parentKey].payloadHash='e'.repeat(64),r=>r.dependencies[r.step.expected.parentKey].observed.inventoryLocationId='999']){const w=world(),r=request();mutate(r);await assert.rejects(adapter(w).preflight(r));assert.equal(w.calls.length,0);}
});
test('fresh matching preflight required and attempts cannot upload/create twice even using a new attempt ID',async()=>{
 const w=world(),a=adapter(w),r=request();await reject(a.apply(r),'FRESH_PREFLIGHT_REQUIRED');await a.preflight(r);await a.apply(r);await reject(a.apply(r),'ATTEMPT_ALREADY_SENT');await reject(a.apply({...r,attemptId:crypto.randomUUID()}),'ATTEMPT_ALREADY_SENT');assert.equal(w.uploads.length,1);
});
test('staged upload rejects nonallowlisted hosts and credentials are never forwarded there',async()=>{
 for(const stageHost of ['evil.test','127.0.0.1','shopify-staged-uploads.storage.googleapis.com.evil.test']){const w=world({stageHost}),a=adapter(w),r=request();await a.preflight(r);await reject(a.apply(r),'UNSAFE_UPLOAD_TARGET');assert.equal(w.http.length,0);await reject(a.apply(r),'ATTEMPT_ALREADY_SENT');}
});
test('unsafe staged parameters cannot set arbitrary multipart fields',async()=>{
 for(const parameters of [[{name:'Authorization',value:token},{name:'key',value:'x'}],[{name:'key',value:'wrong.png'},{name:'Content-Type',value:'image/png'}],[{name:'key',value:'one'},{name:'key',value:'two'}]]){const w=world({parameters}),a=adapter(w),r=request();await a.preflight(r);await reject(a.apply(r),'UNSAFE_UPLOAD_PARAMETERS');assert.equal(w.http.length,0);}
});
test('upload or create loss preserves unknown, cannot adopt by filename, redacts provider exceptions',async()=>{
 for(const options of [{failUpload:true},{failCreate:true}]){const w=world(options),a=adapter(w),r=request();await a.preflight(r);await reject(a.apply(r),'REQUEST_FAILED');assert.equal((await a.readback(readReq(r))).outcome,'unknown');await reject(a.apply(r),'ATTEMPT_ALREADY_SENT');assert.equal(w.uploads.length,1);}
});
test('lost association response can reconcile exact definite file ID using read-only calls',async()=>{
 const w=world({failAttach:true}),a=adapter(w),r=request();await a.preflight(r);await reject(a.apply(r),'REQUEST_FAILED');const before=w.calls.filter(c=>c.query===OPS.attach).length;await a.preflight({...r,stage:'reconcile'});assert.equal((await a.readback({...readReq(r),mode:'reconcile'})).outcome,'found');assert.equal(w.calls.filter(c=>c.query===OPS.attach).length,before);
});
test('processing has bounded reads then stops without association or repeating create',async()=>{
 const w=world({pending:true}),a=adapter(w),r=request();await a.preflight(r);await reject(a.apply(r),'PROCESSING_PENDING_NO_RETRY');assert.equal(w.calls.filter(c=>c.query===OPS.processing).length,8);assert.equal(w.calls.filter(c=>c.query===OPS.attach).length,0);assert.equal((await a.readback(readReq(r))).outcome,'unknown');await reject(a.apply(r),'ATTEMPT_ALREADY_SENT');
});
test('gallery order is derived from the remote list and completed prior IDs, not requested index',async()=>{
 const w=world(),a=adapter(w);for(let position=1;position<=3;position++){const r=request(position);await a.preflight(r);await a.apply(r);const out=await a.readback(readReq(r));assert.equal(out.observed.position,position);assert.equal(out.remoteId,String(499+position));}
 assert.equal(w.product.media.nodes.length,3);const fresh=adapter(w);await reject(fresh.preflight(request(2)),'PRIOR_MEDIA_NOT_VERIFIED');
});
test('out-of-order media cannot stage and preceding foreign IDs cannot be adopted',async()=>{
 const w=world();await reject(adapter(w).preflight(request(2)),'PRIOR_MEDIA_NOT_VERIFIED');assert(!w.calls.some(c=>c.query===OPS.stage));
 const v=world();v.product.media.nodes.push({id:gid('MediaImage','999')});await reject(adapter(v).preflight(request()),'UNEXPECTED_MEDIA');
});
test('wrong readback alt/order/status/parent/dimensions and broken bytes are never loaded',async()=>{
 for(const modify of [w=>w.product.media.nodes[0].alt='wrong',w=>w.product.media.nodes.unshift({id:gid('MediaImage','999')}),w=>w.product.status='ACTIVE',w=>w.decodedWidth=2,w=>w.invalidDecoded=true,w=>w.cdnMime='text/html',w=>w.product.media.nodes[0].image.url='https://evil.test/a.png']){const {w,a,r}=await create();modify(w);await assert.rejects(a.readback(readReq(r)));}
 const {w,a,r}=await create();w.product.media.nodes[0].status='PROCESSING';assert.equal((await a.readback(readReq(r))).outcome,'unknown');assert.equal(w.decoded,0);
});
test('restart has no retained definite ID and cannot reconcile or restart a sent attempt',async()=>{
 const {w,r}=await create();const a=adapter(w);assert.equal((await a.readback({...readReq(r),mode:'reconcile'})).outcome,'unknown');await reject(a.preflight(r),'UNEXPECTED_MEDIA');
});
test('caller mutation of source bytes after construction cannot change the bytes sent',async()=>{
 const f=createBasicAssemblyFixture({productCount:1}),p=prepareBasicStorePackage(f.record,{...f.options,binding:createBasicAssemblyBinding(f.record,f.options)});
 const w=world(),a=adapter(w);const original=prepared.uploads[0].bytes[0];prepared.uploads[0].bytes[0]^=255;
 try{const r=request();await a.preflight(r);await a.apply(r);assert.equal(sha(w.uploads[0]),product.photos[0].sha256);}finally{prepared.uploads[0].bytes[0]=original;}
 assert(p.plan.products.length===1);
});
test('API version, response MIME, redirects and response origin are checked before any write',async()=>{
 for(const make of [()=>new Response('{}',{headers:{'content-type':'text/html'}}),()=>new Response('{}',{headers:{'content-type':'application/json','x-shopify-api-version':'2025-10'}}),()=>{const r=response({});Object.defineProperty(r,'url',{value:'https://evil.test/graphql'});return r;},()=>{const r=response({});Object.defineProperty(r,'redirected',{value:true});return r;}]){const w=world(),a=adapter(w,{fetchImpl:async()=>make()});await assert.rejects(a.preflight(request()));assert.equal(w.uploads.length,0);}
});
test('oversized CDN responses and failed decoder leave loaded status unconfirmed',async()=>{
 for(const change of [async(url,opts)=>opts.method==='GET'?new Response('x',{headers:{'content-type':'image/png','content-length':String(17*1024*1024)}}):new Response('',{status:201}),null]){
  const w=world(),a=adapter(w,change?{uploadFetch:change}:{decodeImage:async()=>{throw Error(token);}}),r=request();await a.preflight(r);await a.apply(r);await assert.rejects(a.readback(readReq(r)),e=>!e.message.includes(token));
 }
});
test('source resource must match uploaded multipart key and normal 204 upload is accepted',async()=>{
 const w=world(),original=w.fetch;w.fetch=async(url,opts)=>{const r=await original(url,opts);if(JSON.parse(opts.body).query!==OPS.stage)return r;const body=await r.json();body.data.stagedUploadsCreate.stagedTargets[0].resourceUrl='https://shopify-staged-uploads.storage.googleapis.com/tmp/unrelated.png';return response(body.data);};
 const a=adapter(w),r=request();await a.preflight(r);await reject(a.apply(r),'UNSAFE_UPLOAD_PARAMETERS');assert.equal(w.http.length,0);
 const v=world(),fetch=v.uploadFetch,b=adapter(v,{uploadFetch:(url,opts)=>opts.method==='POST'?Promise.resolve(new Response(null,{status:204})):fetch(url,opts)}),q=request();await b.preflight(q);await b.apply(q);assert.equal((await b.readback(readReq(q))).outcome,'found');
});
test('decimal strings with one fractional digit are compared as integer cents',async()=>{
 const w=world();w.product.variants.nodes.forEach(v=>v.price=v.price.replace(/0$/,''));await adapter(w).preflight(request());assert.equal(w.calls.length,1);
});
test('in-flight caller request mutation cannot switch parent or source',async()=>{
 const w=world(),r=request();let release;const pending=new Promise(resolve=>{release=resolve;});const original=w.fetch;w.fetch=async(url,opts)=>{if(JSON.parse(opts.body).query===OPS.stage)await pending;return original(url,opts);};
 const a=adapter(w);await a.preflight(r);const work=a.apply(r);await new Promise(resolve=>setImmediate(resolve));r.dependencies[r.step.expected.parentKey].remoteId='999';r.step.expected.sourceSha256='e'.repeat(64);release();await work;assert.deepEqual(w.calls.find(c=>c.query===OPS.attach).variables.files[0].referencesToAdd,[gid('Product','100')]);
});
