import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {canonicalJson} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {createShopifyBasicThemeTransport,SHOPIFY_BASIC_THEME_OPERATIONS as T,SHOPIFY_BASIC_THEME_SCOPES} from '../lib/shopify-basic-theme.mjs';
import {createSyntheticThemeWorld} from './helpers/shopify-basic-theme-world.mjs';

const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonicalJson(v)),gid=(kind,v)=>`gid://shopify/${kind}/${v}`,conn=nodes=>({nodes,pageInfo:{hasNextPage:false}});
const store='molyvi-still-dev.myshopify.com',shop='108668748113',live='207379235153',location='125398417745',token='SYNTHETIC_THEME_TOKEN_123456789';
const reject=(promise,code)=>assert.rejects(promise,{code:`SHOPIFY_BASIC_THEME_${code}`});
let prepared,theme,binding,step,dependencies;

test.before(async()=>{
 const fixture=createBasicAssemblyFixture({productCount:1}),assembly=createBasicAssemblyBinding(fixture.record,fixture.options);prepared=prepareBasicStorePackage(fixture.record,{...fixture.options,binding:assembly});const plan=prepared.plan;
 const license=await fs.readFile(new URL('../../forma-production-kit/theme/LICENSE.md',import.meta.url)),hero=prepared.uploads.find(u=>u.fileName===plan.products[0].photos[0].fileName);
 const files=new Map([['LICENSE.md',license],['layout/theme.liquid',Buffer.from('{{ content_for_header }}{{ content_for_layout }}')],['snippets/molyvi-basic-navigation.liquid',Buffer.from(`{{ routes.collections_url }}/${plan.namespace}\n`+plan.pages.map(p=>`/pages/${p.handle}`).join('\n'))],['templates/index.json',Buffer.from(JSON.stringify({sections:{featured_collection:{settings:{collection:plan.namespace}},forma_hero:{settings:{link:`shopify://collections/${plan.namespace}`}}}}))],['assets/molyvi-basic-hero.png',hero.bytes]]);
 const zip=new JSZip();for(const [file,bytes]of files)zip.file(file,bytes,{createFolders:false});const zipBytes=await zip.generateAsync({type:'nodebuffer'});
 const manifest={schemaVersion:1,kind:'molyvi_basic_theme_package',planHash:plan.planHash,projectId:plan.projectId,targetStore:store,status:'UNPUBLISHED_NOT_APPLIED',applicationAuthorized:false,publicationAuthorized:false,zip:{bytes:zipBytes.length,sha256:sha(zipBytes)},files:[...files].map(([file,bytes])=>({file,bytes:bytes.length,sha256:sha(bytes)})),upstream:{licenseSha256:sha(license)},resources:{counts:plan.counts,collectionHandle:plan.namespace,pages:plan.pages.map(({documentId,handle})=>({documentId,handle}))},hero:{file:'assets/molyvi-basic-hero.png',sourceFile:hero.fileName,sha256:sha(hero.bytes)}};
 theme={manifest,zipBytes};binding={intentHash:'1'.repeat(64),targetStore:store,projectId:plan.projectId,ownerHash:plan.binding.ownerHash,planHash:plan.planHash,themeZipSha256:sha(zipBytes),packageBytesHash:hash({plan,uploads:prepared.uploads.map(u=>({fileName:u.fileName,sha256:sha(u.bytes),bytes:u.bytes.length}))})};
 dependencies={};const add=(key,expected,observed,remoteId)=>dependencies[key]={remoteId,payloadHash:hash(expected),observed};let remote=100;
 for(const p of plan.products){
  const parent=`catalog:${p.productId}`,expected={handle:p.handle,title:p.title,descriptionHtmlSha256:sha(p.descriptionHtml),vendor:p.vendor,productType:p.type,optionNames:p.optionNames,status:'DRAFT',channels:[],currency:'EUR',inventoryLocationId:location,variants:p.variants.map(v=>({localId:v.id,sku:v.sku,optionValues:v.optionValues,priceMinor:v.priceMinor,stock:v.stock,weightGrams:v.weightGrams,visualUnitId:v.visualUnitId,imagePosition:v.imagePosition,trackInventory:true,continueSellingWhenOutOfStock:false}))};
  add(parent,expected,{...expected,variants:expected.variants.map(v=>({...v,remoteId:String(++remote)}))},String(++remote));
  for(const photo of p.photos){const e={parentKey:parent,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt};add(`media:${p.productId}:${photo.position}`,e,{parentRemoteId:dependencies[parent].remoteId,position:photo.position,sourceSha256:photo.sha256,alt:photo.alt,loaded:true},String(++remote));}
  const e={parentKey:parent,associations:p.variants.map(v=>({localId:v.id,mediaKey:`media:${p.productId}:${v.imagePosition}`}))};add(`variant_media:${p.productId}`,e,{parentRemoteId:dependencies[parent].remoteId,associations:e.associations.map(a=>({variantRemoteId:dependencies[parent].observed.variants.find(v=>v.localId===a.localId).remoteId,mediaRemoteId:dependencies[a.mediaKey].remoteId}))},dependencies[parent].remoteId);
 }
 const c={title:plan.branding.brandName,handle:plan.namespace,productKeys:plan.products.map(p=>`catalog:${p.productId}`),channels:[]};add('collection',c,{title:c.title,handle:c.handle,productRemoteIds:c.productKeys.map(k=>dependencies[k].remoteId),channels:[]},String(++remote));
 for(const p of plan.pages){const e={title:p.title,handle:p.handle,bodySha256:p.bodySha256,visibility:'Hidden'};add(`page:${p.documentId}`,e,e,String(++remote));}
 const expected={zipSha256:binding.themeZipSha256,status:'Draft'};step={key:'theme',kind:'theme',action:'create',expected,payloadHash:hash(expected),dependsOn:Object.keys(dependencies)};
});
function request(extra={}){return {binding:structuredClone(binding),trustedShop:{shopId:shop,targetStore:store},step:structuredClone(step),dependencies:structuredClone(dependencies),attemptId:crypto.randomUUID(),...extra};}
function syntheticBase(){
 const plan=prepared.plan,w={shop:{id:gid('Shop',shop),myshopifyDomain:store,currencyCode:'EUR'},app:{id:gid('AppInstallation','1195450433873'),app:{id:gid('App','436878311425')},accessScopes:SHOPIFY_BASIC_THEME_SCOPES.map(handle=>({handle}))},themes:conn([{id:gid('OnlineStoreTheme',live),role:'MAIN'}]),location:{id:gid('Location',location),isActive:true,fulfillsOnlineOrders:true}};
 w.products=plan.products.map(p=>{const d=dependencies[`catalog:${p.productId}`];return {id:gid('Product',d.remoteId),handle:p.handle,title:p.title,descriptionHtml:p.descriptionHtml,vendor:p.vendor,productType:p.type,options:p.optionNames.map(name=>({name})),status:'DRAFT',resourcePublicationsCount:{count:0,precision:'EXACT'},variants:conn(d.observed.variants.map(v=>({id:gid('ProductVariant',v.remoteId),sku:v.sku??'',price:(v.priceMinor/100).toFixed(2),inventoryPolicy:'DENY',selectedOptions:p.optionNames.map((name,i)=>({name,value:v.optionValues[i]})),inventoryItem:{id:gid('InventoryItem',v.remoteId),sku:v.sku??'',tracked:true,requiresShipping:true,measurement:{weight:v.weightGrams===null?null:{unit:'GRAMS',value:v.weightGrams}},inventoryLevels:conn([{location:{id:gid('Location',location)},quantities:[{name:'available',quantity:v.stock}]}])},media:conn([{id:gid('MediaImage',dependencies[`media:${p.productId}:${v.imagePosition}`].remoteId)}])}))),media:conn(p.photos.map(photo=>({id:gid('MediaImage',dependencies[`media:${p.productId}:${photo.position}`].remoteId),alt:photo.alt,mediaContentType:'IMAGE',status:'READY'})))};});
 w.pages=plan.pages.map(p=>({id:gid('Page',dependencies[`page:${p.documentId}`].remoteId),title:p.title,handle:p.handle,body:p.bodyHtml,isPublished:false}));w.collections=[{id:gid('Collection',dependencies.collection.remoteId),title:plan.branding.brandName,handle:plan.namespace,resourcePublicationsCount:{count:0,precision:'EXACT'},products:conn(w.products.map(p=>({id:p.id})))}];
 w.identity=()=>({shop:w.shop,currentAppInstallation:w.app,themes:w.themes,location:w.location});w.fetch=async()=>{throw Error('No other API authorized');};w.uploadFetch=async()=>{throw Error('No other external fetch authorized');};return w;
}
const world=()=>createSyntheticThemeWorld({baseWorld:syntheticBase(),theme});
const transport=(w,options={})=>createShopifyBasicThemeTransport({prepared,theme,binding,liveThemeId:live,accessToken:token,fetchImpl:w.fetch,uploadFetch:w.uploadFetch,networkEnabled:true,...options});
const readReq=r=>({...r,readRequestId:crypto.randomUUID(),mode:'after_apply'});
async function created(){const w=await world(),adapter=transport(w),r=request();await adapter.preflight(r);await adapter.apply(r);return {w,adapter,r};}

test('default network-off, bounded exact app/store and read-only interface',async()=>{
 const w=await world(),adapter=transport(w,{networkEnabled:false});await reject(adapter.preflight(request()),'NETWORK_DISABLED');assert.equal(w.themeCalls.length,0);assert.deepEqual(Object.keys(adapter).sort(),['apply','preflight','readback','supportedKinds','themeProcessing']);
 assert.throws(()=>transport(w,{accessToken:'bad\nsecret'}),{code:'SHOPIFY_BASIC_THEME_CREDENTIAL_REQUIRED'});assert.throws(()=>transport(w,{liveThemeId:'9'}),{code:'SHOPIFY_BASIC_THEME_BINDING_MISMATCH'});
});
test('one ZIP stage/upload and one explicit UNPUBLISHED create; fresh paginated full-file readback keeps source license distinct',async()=>{
 const {w,adapter,r}=await created();w.themeControl.pageSize=2;await adapter.preflight(r);const result=await adapter.readback(readReq(r));
 assert.equal(result.outcome,'found');assert.equal(result.remoteId,'99001');assert.deepEqual(result.observed,{zipSha256:binding.themeZipSha256,status:'Draft',liveThemeIdUnchanged:live});assert.deepEqual(w.themeWrites,['MolyviBasicThemeStage','MolyviBasicThemeCreate']);assert.equal(w.themeExternal.length,1);assert.deepEqual(w.uploadedThemeZip,theme.zipBytes);
 assert.equal(result.provenance.remoteFiles.length,4);assert.equal(result.provenance.sourceOnlyFiles[0].file,'LICENSE.md');assert.equal(result.provenance.remoteZipEqualityClaimed,false);assert.equal(result.provenance.visualRuntimeVerified,false);assert.equal(result.provenance.byteNormalizationAccepted,false);
 assert(T.create.includes('role:UNPUBLISHED'));assert.equal(w.installedTheme.role,'UNPUBLISHED');assert.equal(w.installedTheme.name.length,49);assert.equal(w.themes.nodes[0].id,gid('OnlineStoreTheme',live));
 for(const c of w.themeCalls){assert.equal(c.options.redirect,'error');assert.equal(c.options.credentials,'omit');assert.equal(c.options.headers['X-Shopify-Access-Token'],token);assert(!JSON.stringify(c.variables).includes(token));}assert(!JSON.stringify(result).includes('?v='));
});
test('returned license is byte-verified; null checksum and text body use full content SHA, decimal string size accepted',async()=>{
 const {w,adapter,r}=await created();w.themeControl.omitLicense=false;w.themeControl.transformFiles=files=>files.map(f=>f.filename==='layout/theme.liquid'?{...f,checksumMd5:null,body:{__typename:'OnlineStoreThemeFileBodyText',content:Buffer.from(f.body.contentBase64,'base64').toString('utf8')}}:f);
 const result=await adapter.readback(readReq(r));assert.equal(result.provenance.remoteFiles.length,5);assert.deepEqual(result.provenance.sourceOnlyFiles,[]);assert.equal(result.provenance.remoteFiles.find(f=>f.file==='layout/theme.liquid').remoteChecksumMd5,null);
});
test('wrong store, app, missing scope and MAIN drift reject before staging',async()=>{
 for(const mutate of [w=>w.shop.myshopifyDomain='other.myshopify.com',w=>w.app.app.id=gid('App','8'),w=>w.app.accessScopes=w.app.accessScopes.filter(s=>s.handle!=='write_themes'),w=>w.themes.nodes[0].id=gid('OnlineStoreTheme','9')]){const w=await world();mutate(w);await assert.rejects(transport(w).preflight(request()));assert.equal(w.themeWrites.length,0);}
});
test('dependencies are exact and remote hidden pages, stock, variants, media and collection membership must still match',async()=>{
 const w=await world(),adapter=transport(w),r=request();delete r.dependencies['page:faq'];await reject(adapter.preflight(r),'DEPENDENCIES_REQUIRED');assert.equal(w.themeCalls.length,0);
 for(const mutate of [w=>w.pages[0].isPublished=true,w=>w.pages[0].body+=' changed',w=>w.products[0].variants.nodes[0].inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity++,w=>w.products[0].variants.nodes[0].inventoryPolicy='CONTINUE',w=>w.products[0].media.nodes.pop(),w=>w.collections[0].products.nodes=[],w=>w.collections[0].resourcePublicationsCount.count=1]){const w=await world();mutate(w);await assert.rejects(transport(w).preflight(request()));assert.equal(w.themeWrites.length,0);}
});
test('source manifest tampering and crossed resource namespace stop before any API request',async()=>{
 const w=await world(),bad=structuredClone(theme);bad.zipBytes=Buffer.from(theme.zipBytes);bad.manifest.files[1].sha256='f'.repeat(64);await reject(transport(w,{theme:bad}).preflight(request()),'ZIP_INVALID');assert.equal(w.themeCalls.length,0);
 const crossed=structuredClone(theme);crossed.zipBytes=Buffer.from(theme.zipBytes);crossed.manifest.resources.collectionHandle='some-other-store';assert.throws(()=>transport(w,{theme:crossed}),{code:'SHOPIFY_BASIC_THEME_THEME_RESOURCES_MISMATCH'});
});
test('no apply before exact fresh preflight, and a failed refresh invalidates prior preflight',async()=>{
 const w=await world(),adapter=transport(w),r=request();await reject(adapter.apply(r),'FRESH_PREFLIGHT_REQUIRED');await adapter.preflight({...r,attemptId:null});await reject(adapter.apply(r),'FRESH_PREFLIGHT_REQUIRED');await adapter.preflight(r);w.pages[0].isPublished=true;await reject(adapter.preflight(r),'REMOTE_PAGE_MISMATCH');await reject(adapter.apply(r),'FRESH_PREFLIGHT_REQUIRED');assert.equal(w.themeWrites.length,0);
});
test('lost create outcome remains unknown and neither same nor substitute attempt can send another mutation',async()=>{
 const w=await world();w.themeControl.loseCreateResponse=true;const adapter=transport(w),r=request();await adapter.preflight(r);await reject(adapter.apply(r),'REQUEST_FAILED');assert(w.installedTheme);const count=w.themeCalls.length;assert.equal((await adapter.readback(readReq(r))).outcome,'unknown');assert.equal(w.themeCalls.length,count);await reject(adapter.apply(r),'ATTEMPT_ALREADY_SENT');await reject(adapter.apply({...r,attemptId:crypto.randomUUID()}),'ATTEMPT_ALREADY_SENT');assert.equal(w.themeWrites.length,2);
 const restarted=transport(w);assert.equal((await restarted.readback({...readReq(r),mode:'reconcile'})).outcome,'unknown');
});
test('unsafe staging URL, upload timeout and MAIN drift during upload never send themeCreate',async()=>{
 for(const mode of ['url','upload','main']){const w=await world();if(mode==='url')w.themeControl.stageUrl='https://evil.example/';if(mode==='upload')w.themeControl.loseUploadResponse=true;if(mode==='main')w.themeControl.beforeResponse=(name,v,w)=>{if(name==='MolyviBasicThemePreflight'&&w.uploadedThemeZip)w.themes.nodes[0].id=gid('OnlineStoreTheme','7');};const adapter=transport(w),r=request();await adapter.preflight(r);await assert.rejects(adapter.apply(r));assert(!w.themeWrites.includes('MolyviBasicThemeCreate'));await reject(adapter.apply(r),'ATTEMPT_ALREADY_SENT');}
});
test('missing, extra, duplicate, changed or normalized remote bytes are never counted as success',async()=>{
 const changes=[files=>files.slice(1),files=>[...files,{...files[0],filename:'assets/unexpected.js'}],files=>[...files,files[0]],files=>files.map((f,i)=>i?f:{...f,body:{__typename:'OnlineStoreThemeFileBodyText',content:'normalized'}}),files=>files.map((f,i)=>i?f:{...f,size:'999999999999999999999'})];
 for(const change of changes){const {w,adapter,r}=await created();w.themeControl.transformFiles=change;await assert.rejects(adapter.readback(readReq(r)));assert.equal(w.themeWrites.length,2);}
});
test('file errors, wrong final role, failed processing and untrusted body URL fail closed',async()=>{
 for(const change of [w=>w.themeControl.fileErrors=[{code:'FILE_NOT_FOUND',filename:'layout/theme.liquid'}],w=>w.installedTheme.role='MAIN',w=>w.installedTheme.processingFailed=true,w=>{w.themeControl.urlBody=true;w.themeControl.fileUrl='https://evil.example/file';}]){const {w,adapter,r}=await created();change(w);await assert.rejects(adapter.readback(readReq(r)));assert.equal(w.themeWrites.length,2);}
});
test('bounded CDN body fetch verifies actual bytes and never carries an access token',async()=>{
 const {w,adapter,r}=await created();w.themeControl.urlBody=true;const result=await adapter.readback(readReq(r));assert.equal(result.outcome,'found');assert.equal(w.themeExternal.length,2);assert.equal(w.themeExternal[1].headers,undefined);assert(!JSON.stringify(result).includes('cdn.shopify.com'));
});
test('catalog drift while reading theme files is caught by final independent dependency read',async()=>{
 const {w,adapter,r}=await created();w.themeControl.beforeResponse=(name,v,w)=>{if(name==='MolyviBasicThemeFiles')w.products[0].variants.nodes[0].price='999.00';};await reject(adapter.readback(readReq(r)),'REMOTE_VARIANT_MISMATCH');assert.equal(w.themeWrites.length,2);
});
test('processing polls are bounded to eight reads and never retry creation',async()=>{
 const {w,adapter,r}=await created();w.themeControl.processingReads=99;await reject(adapter.readback(readReq(r)),'PROCESSING_PENDING_NO_RETRY');assert.equal(w.themeCalls.filter(c=>c.query===T.state).length,8);assert.equal(w.themeCalls.filter(c=>c.query===T.files).length,0);await reject(adapter.apply(r),'ATTEMPT_ALREADY_SENT');assert.equal(w.themeWrites.length,2);
});
test('aborted requests and provider exception contents are reduced to stable error codes',async()=>{
 const w=await world(),controller=new AbortController();controller.abort();const adapter=transport(w);await reject(adapter.preflight(request(),{signal:controller.signal}),'REQUEST_ABORTED');assert.equal(w.themeWrites.length,0);
 const broken=transport(w,{fetchImpl:async()=>{throw Error(`Authorization ${token}`);}});try{await broken.preflight(request());assert.fail('Expected rejection');}catch(error){assert.equal(error.code,'SHOPIFY_BASIC_THEME_REQUEST_FAILED');assert(!String(error).includes(token));assert.equal(error.cause,undefined);}
});
