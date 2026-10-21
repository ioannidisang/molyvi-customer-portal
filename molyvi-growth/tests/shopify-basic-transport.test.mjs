import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {buildBasicThemePackage} from '../lib/basic-theme-package.mjs';
import {createBasicInstallation,readBasicInstallation} from '../lib/basic-installation.mjs';
import {createBasicInstallationRunner} from '../lib/basic-installation-runner.mjs';
import {createShopifyBasicTransport} from '../lib/shopify-basic-transport.mjs';
import {createShopifyImageDecoder} from '../lib/shopify-image-decoder.mjs';
import {createSyntheticBasicWorld} from './helpers/shopify-basic-composed-world.mjs';

const native=process.env.MOLYVI_TEST_SHARP_MODULE;
const opts={skip:!native?'Explicit local sharp module required for native composition test':false};
const shopId='108668748113',targetStore='molyvi-still-dev.myshopify.com',liveThemeId='207379235153',inventoryLocationId='125398417745';
let root,sharp;const reports=[];
test.before(async()=>{if(native){sharp=createRequire(import.meta.url)(native);root=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_basic-composed-tests-'));}});
test.after(async()=>{
  if(process.env.MOLYVI_CATALOG_TEST_REPORT&&reports.length)await fs.writeFile(process.env.MOLYVI_CATALOG_TEST_REPORT,JSON.stringify({mode:'LOCAL_SYNTHETIC_HTTP_WITH_REAL_IMAGE_DECODE',externalCalls:0,realShopifyWrites:0,newAiGenerations:0,reports},null,2)+'\n');
  if(root){const actual=await fs.realpath(root);assert.equal(path.dirname(actual),await fs.realpath(PRIVATE_ROOT));await fs.rm(actual,{recursive:true});}
});
async function setup(settings={},extra={}){
  const bytes=await sharp({create:{width:48,height:32,channels:3,background:'#336699'}}).png().toBuffer();
  const image=()=>({bytes,name:'synthetic-mechanics.png',mime:'image/png'}),fixture=createBasicAssemblyFixture({...settings,sourceImage:image,generatedImage:image});
  const assembly=createBasicAssemblyBinding(fixture.record,fixture.options),prepared=prepareBasicStorePackage(fixture.record,{...fixture.options,binding:assembly});
  const directory=path.join(root,crypto.randomUUID()),registryDirectory=path.join(root,crypto.randomUUID());await fs.mkdir(registryDirectory);
  const built=await buildBasicThemePackage(prepared,{outputDirectory:path.join(root,crypto.randomUUID())}),theme={manifest:built.manifest,zipBytes:await fs.readFile(built.zipPath)};
  const context={projectId:prepared.plan.projectId,ownerId:fixture.record.ownerId,targetStore,planHash:prepared.plan.planHash,themeZipSha256:built.zipSha256};
  const authorization={projectId:context.projectId,ownerHash:assembly.ownerHash,targetStore,planHash:context.planHash,createOnly:true,publicationAuthorized:false,newChargesAuthorized:false,referenceSha256:'a'.repeat(64)};
  const state=await createBasicInstallation({directory,registryDirectory,prepared,theme,context,authorization,preflightEvidence:{operatorId:'synthetic-local-only',observedAt:new Date().toISOString(),evidenceSha256:'b'.repeat(64),scopeConfirmed:true},liveThemeId,inventoryLocationId,currency:'EUR'});
  const i=state.intent,binding={intentHash:state.intentHash,targetStore,projectId:i.projectId,ownerHash:i.ownerHash,planHash:i.planHash,themeZipSha256:i.themeZipSha256,packageBytesHash:i.packageBytesHash};
  const world=createSyntheticBasicWorld({sharp}),evidence=[],evidenceDirectory=path.join(root,crypto.randomUUID());await fs.mkdir(evidenceDirectory);
  const transportOptions={prepared,binding,liveThemeId,inventoryLocationId,accessToken:'shpat_SYNTHETIC_COMPOSITION_ONLY_123456789',fetchImpl:world.fetch,uploadFetch:world.uploadFetch,decodeImage:createShopifyImageDecoder({sharp}),networkEnabled:true,recordReadbackEvidence:async value=>{await fs.writeFile(path.join(evidenceDirectory,`evidence-${value.readRequestId}.json`),JSON.stringify(value));evidence.push(value);},...extra};
  const transport=createShopifyBasicTransport(transportOptions),runner=await createBasicInstallationRunner({registryDirectory,trustedShop:{shopId,targetStore},transport,operatorId:'synthetic-local-only',timeoutMs:60000});
  return {prepared,state,directory,registryDirectory,context,world,evidence,transport,transportOptions,runner};
}
async function runAll(run){
  let state=run.state;
  for(const step of state.intent.steps){if(step.kind==='theme')continue;state=await run.runner.runStep({...run,key:step.key});}
  return state;
}
function verifyAndReport(run,state,label){
  const completed=Object.values(state.steps).filter(s=>s.status==='succeeded').length,media=run.evidence.filter(e=>e.provenance);
  assert.equal(completed,state.intent.steps.length-1);assert.equal(state.steps.theme.status,'pending');
  assert.equal(run.evidence.length,completed);assert.equal(media.length,run.prepared.plan.products.reduce((n,p)=>n+p.photos.length,0));
  for(const e of media){assert.equal(e.provenance.visualFidelityCertified,false);assert.equal(e.provenance.cdn.width,48);assert.equal(e.provenance.cdn.height,32);assert.equal(e.provenance.cdnBytesEqualSource,false);}
  assert(run.world.products.every(p=>p.status==='DRAFT'&&p.resourcePublicationsCount.count===0));assert(run.world.pages.every(p=>p.isPublished===false));assert(run.world.collections.every(p=>p.resourcePublicationsCount.count===0));
  for(const p of run.prepared.plan.products){
    const installed=run.world.products.find(v=>v.handle===p.handle);assert.equal(installed.media.nodes.length,p.photos.length);
    for(const v of p.variants){const actual=installed.variants.nodes.find(a=>a.sku===v.sku&&a.selectedOptions.every((o,i)=>o.value===v.optionValues[i]));assert.equal(actual.inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity,v.stock);assert.equal(actual.media.nodes[0].id,installed.media.nodes[v.imagePosition-1].id);}
  }
  reports.push({label,products:run.world.products.length,variants:run.world.products.reduce((n,p)=>n+p.variants.nodes.length,0),photos:media.length,hiddenPages:run.world.pages.length,unpublishedCollections:run.world.collections.length,verifiedSteps:completed,pendingThemeSteps:1,graphqlCalls:run.world.calls.length+run.world.otherCalls.length,uploads:run.world.http.filter(x=>x.method==='POST').length,cdnDecodes:media.length,allProductsDraft:true,allChannelsEmpty:true,sourceAndCdnHashesSeparated:true,visualFidelityCertified:false});
}
test('full local Basic: ten products, fourteen variants, thirty actual image decodes, links, collection and seven hidden pages through durable runner',opts,async()=>{
  const run=await setup({sizeProductCount:2,stock:({productIndex,variantIndex})=>(productIndex+variantIndex)%3===0?0:17,priceMinor:({productIndex,variantIndex})=>1900+productIndex*313+variantIndex*19});
  const done=await runAll(run);verifyAndReport(run,done,'10_products_14_variants_30_photos');
  const calls=run.world.calls.length+run.world.otherCalls.length;
  for(const step of done.intent.steps.filter(s=>s.kind!=='theme'))assert.equal((await run.runner.runStep({...run,key:step.key})).duplicate,true);
  assert.equal(run.world.calls.length+run.world.otherCalls.length,calls);
  assert.equal((await readBasicInstallation(run)).eventCount,done.eventCount);
});
test('two colors by three sizes select their own correct primary image, without counting each size as a new photo unit',opts,async()=>{
  const run=await setup({productCount:1,withColorUnits:true,sizeProductCount:1});const done=await runAll(run);verifyAndReport(run,done,'1_product_2_colors_3_sizes_6_photos');
  const p=run.world.products[0];assert.equal(p.variants.nodes.length,6);assert.equal(p.media.nodes.length,6);assert.equal(new Set(p.variants.nodes.map(v=>v.media.nodes[0].id)).size,2);
});
test('network defaults off and theme/publication are unsupported',opts,async()=>{
  const run=await setup({productCount:1},{networkEnabled:false});await assert.rejects(run.runner.runStep({...run,key:run.state.intent.steps[0].key}),{code:'BASIC_INSTALL_RUNNER_PREFLIGHT_FAILED'});
  assert.equal(run.world.calls.length+run.world.otherCalls.length,0);assert.equal((await readBasicInstallation(run)).eventCount,0);
  await assert.rejects(run.transport.preflight({step:{kind:'theme'}}),{code:'SHOPIFY_BASIC_TRANSPORT_UNSUPPORTED_STEP'});
  assert.throws(()=>createShopifyBasicTransport({...run.transportOptions,recordReadbackEvidence:undefined}),{code:'SHOPIFY_BASIC_TRANSPORT_EVIDENCE_SINK_REQUIRED'});
});
test('failed evidence persistence keeps a single unknown attempt; restarting does not create a duplicate product',opts,async()=>{
  const run=await setup({productCount:1},{recordReadbackEvidence:async()=>{throw Error('synthetic sink failure');}}),key=run.state.intent.steps[0].key;
  await assert.rejects(run.runner.runStep({...run,key}),{code:'BASIC_INSTALL_RUNNER_READBACK_FAILED'});assert.equal(run.world.products.length,1);
  const state=await readBasicInstallation(run);assert.equal(state.steps[key].status,'claimed_outcome_unknown');
  const reopened=await createBasicInstallationRunner({registryDirectory:run.registryDirectory,trustedShop:{shopId,targetStore},transport:createShopifyBasicTransport(run.transportOptions),operatorId:'synthetic-local-only'});
  await assert.rejects(reopened.runStep({...run,key}),{code:'BASIC_INSTALL_RUNNER_RECONCILIATION_REQUIRED'});assert.equal(run.world.products.length,1);
});
test('corrupt CDN bytes fail the real decoder and prevent next-photo execution without a second upload',opts,async()=>{
  const run=await setup({productCount:1}),catalog=run.state.intent.steps.find(s=>s.kind==='catalog'),media=run.state.intent.steps.filter(s=>s.kind==='media');
  await run.runner.runStep({...run,key:catalog.key});
  const oldFetch=run.transportOptions.uploadFetch;
  run.transportOptions.uploadFetch=async(url,options)=>options.method==='GET'?new Response(Buffer.from('not an image'),{headers:{'content-type':'image/png'}}):oldFetch(url,options);
  const runner=await createBasicInstallationRunner({registryDirectory:run.registryDirectory,trustedShop:{shopId,targetStore},transport:createShopifyBasicTransport(run.transportOptions),operatorId:'synthetic-local-only'});
  await assert.rejects(runner.runStep({...run,key:media[0].key}),{code:'BASIC_INSTALL_RUNNER_READBACK_FAILED'});
  await assert.rejects(runner.runStep({...run,key:media[1].key}),{code:'BASIC_INSTALL_RUNNER_RECONCILIATION_REQUIRED'});
  assert.equal(run.world.uploaded.size,1);assert.equal((await readBasicInstallation(run)).steps[media[0].key].status,'claimed_outcome_unknown');
});
