import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const originalRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url));
const sharpPath=process.env.MOLYVI_TEST_SHARP_MODULE;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
async function inventory(root){const files=[];async function visit(directory,prefix=''){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const name=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(directory,entry.name);if(entry.isDirectory())await visit(file,name);else files.push({name,sha256:sha(await fs.readFile(file))});}}await visit(root);return files.sort((a,b)=>a.name.localeCompare(b.name));}

// Real source/confirmation/composition/installer modules, isolated PRIVATE_ROOT,
// real PNG decoding, synthetic Shopify HTTP. No real credentials or services.
test('actual ten-product confirmation composes and installs once; expired terminal restart performs no work', {skip:!sharpPath?'Explicit local sharp module required':false,timeout:360000},async t=>{
  const scratchParent=path.join(originalRoot,'briefs'),root=await fs.mkdtemp(path.join(scratchParent,'_bpi-')),instances=[],priorFetch=globalThis.fetch;
  t.after(async()=>{for(const app of instances)await app.stop();globalThis.fetch=priorFetch;const actual=await fs.realpath(root);assert.equal(path.dirname(actual),await fs.realpath(scratchParent));assert(path.basename(actual).startsWith('_bpi-'));await fs.rm(actual,{recursive:true});});
  globalThis.fetch=async()=>{assert.fail('No real network call is permitted by this integration test');};
  for(const folder of ['molyvi-growth/lib','molyvi-growth/tests/helpers','molyvi-contract','forma-production-kit/theme'])await fs.cp(path.join(originalRoot,folder),path.join(root,folder),{recursive:true});
  await fs.mkdir(path.join(root,'forma-production-kit','scripts'),{recursive:true});
  await fs.copyFile(path.join(originalRoot,'forma-production-kit','scripts','apply-brief.mjs'),path.join(root,'forma-production-kit','scripts','apply-brief.mjs'));
  for(const file of ['package.json','upstream.json'])await fs.copyFile(path.join(originalRoot,'forma-production-kit',file),path.join(root,'forma-production-kit',file));
  // Use the same installed JSZip dependency, without modifying source copies or
  // installing anything. This CommonJS shim is only inside the disposable test.
  const dependency=path.join(root,'forma-production-kit','node_modules','jszip');await fs.mkdir(dependency,{recursive:true});await fs.writeFile(path.join(dependency,'package.json'),JSON.stringify({name:'jszip',main:'index.cjs'}));await fs.writeFile(path.join(dependency,'index.cjs'),`module.exports = require(${JSON.stringify(require.resolve('jszip'))});\n`);
  const imported=relative=>import(pathToFileURL(path.join(root,relative)));
  const [{TaskStore},{canonicalJson},{createBasicAssemblyFixture},api,installerModule,{createShopifyImageDecoder},{createSyntheticBasicWorld},{createSyntheticThemeWorld}]=await Promise.all([
    imported('molyvi-growth/lib/task-store.mjs'),imported('molyvi-growth/lib/intake-store.mjs'),imported('molyvi-growth/tests/helpers/basic-assembly-fixture.mjs'),imported('molyvi-growth/lib/hosted-basic-pipeline.mjs'),imported('molyvi-growth/lib/hosted-basic-prepared-installer.mjs'),imported('molyvi-growth/lib/shopify-image-decoder.mjs'),imported('molyvi-growth/tests/helpers/shopify-basic-composed-world.mjs'),imported('molyvi-growth/tests/helpers/shopify-basic-theme-world.mjs')]);
  const hash=value=>sha(canonicalJson(value)),sharp=createRequire(import.meta.url)(sharpPath),bytes=await sharp({create:{width:48,height:32,channels:3,background:'#663399'}}).png().toBuffer(),image=()=>({bytes,name:'synthetic.png',mime:'image/png'});
  const fixture=createBasicAssemblyFixture({productCount:10,sizeProductCount:2,sourceImage:image,generatedImage:image}),storage=path.join(root,'briefs','molyvi-hosted-staging'),store=await new TaskStore(path.join(storage,'workspaces')).ready();
  await store.create(fixture.record);const projectDirectory=await store.directory(fixture.record.id),sourceBefore=await fs.readFile(path.join(projectDirectory,'workspace.json'));
  for(const [items,prefix]of [[fixture.options.sourceAssets,'photo'],[fixture.options.assets,'generated']])for(const item of items)await fs.writeFile(path.join(projectDirectory,`${prefix}-${item.asset.id}.bin`),item.bytes,{flag:'wx'});
  let now=Date.parse('2026-10-19T16:00:00.000Z');const wallStart=Date.now(),clock=()=>now+(Date.now()-wallStart);let leased=false,leases=0,releases=0,tokenReads=0,preflights=0,world;
  const body={schemaVersion:1,kind:'molyvi_basic_pipeline_permit',serviceId:'srv-db7othjrjlhs73cg7lf0',targetStore:'molyvi-still-dev.myshopify.com',projectId:fixture.record.id,ownerId:fixture.record.ownerId,sourceHash:hash(fixture.record),jobId:crypto.randomUUID(),authorizationSha256:'a'.repeat(64),operatorId:'molyvi-full-basic-test-20261019',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+4*60*60*1000).toISOString(),credentialReference:{runId:crypto.randomUUID(),packageSha256:'b'.repeat(64),receiverSha256:'c'.repeat(64)},publicationAuthorized:false,newChargesAuthorized:false},permit={...body,permitHash:hash(body)};
  await fs.mkdir(path.dirname(api.HOSTED_BASIC_PIPELINE_FILE),{recursive:true});await fs.writeFile(api.HOSTED_BASIC_PIPELINE_FILE,JSON.stringify(permit));
  const dependencies={
    readToken:async()=>{assert(leased);tokenReads++;return {accessToken:'shpat_SYNTHETIC_ONLY_NOT_AN_ACTUAL_CREDENTIAL',expiresAt:new Date(now+5*60*60*1000).toISOString()};},
    preflight:async()=>{assert(leased);preflights++;return {evidence:{synthetic:true},preflightEvidence:{operatorId:permit.operatorId,observedAt:new Date(now).toISOString(),evidenceSha256:'d'.repeat(64),scopeConfirmed:true}};},
    loadInstaller:async options=>{
      if(!world){const raw=JSON.parse(await fs.readFile(path.join(path.dirname(options.configFile),'bundle.json')));world=await createSyntheticThemeWorld({baseWorld:createSyntheticBasicWorld({sharp}),theme:{manifest:raw.theme.manifest,zipBytes:Buffer.from(raw.theme.zipBytes,'base64')}});}
      const diagnose=(name,fn)=>async(...args)=>{try{return await fn(...args);}catch(error){t.diagnostic(JSON.stringify({syntheticTransport:name,error:error?.message,code:error?.code,stack:error?.stack?.split('\n').slice(0,4)}));throw error;}};
      return installerModule.loadHostedPreparedBasicInstaller({...options,fetchImpl:diagnose('graphql',world.fetch),uploadFetch:diagnose('upload',world.uploadFetch),decodeImage:createShopifyImageDecoder({sharp})});
    }
  };
  const config={permit,store,storage,clock,acquireLease:async()=>{assert.equal(leased,false);leased=true;leases++;return ()=>{assert(leased);leased=false;releases++;};},dependencies};
  const app=await api.createHostedBasicPipeline(config);instances.push(app);app.start();await app.drain();assert.equal(app.publicStatus({projectId:fixture.record.id,ownerId:fixture.record.ownerId}).stage,'waiting_confirmation');assert.equal(leases,0);assert.equal(preflights,0);
  const session={projectId:fixture.record.id,ownerId:fixture.record.ownerId},requested=await app.service.request(session,{expectedSourceHash:permit.sourceHash,acknowledged:true});app.signal();
  const deadline=Date.now()+300000;while(!['completed','stopped_for_review'].includes(app.status().worker.lifecycle)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  if(!['completed','stopped_for_review'].includes(app.status().worker.lifecycle))t.diagnostic(JSON.stringify({deadlineStatus:app.status()}));
  if(app.status().code){const unsafe=[];async function scan(directory){for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name),s=await fs.lstat(file);if(s.isDirectory())await scan(file);else if(s.nlink!==1||s.isSymbolicLink())unsafe.push({file:path.relative(root,file),nlink:s.nlink,bytes:s.size});}}await scan(storage);t.diagnostic(JSON.stringify({syntheticFixtureFilesystem:unsafe.slice(0,20),violations:unsafe.length}));}
  assert.equal(app.status().code,null,JSON.stringify(app.status()));assert.equal(app.publicStatus(session).stage,'installed_draft');assert.equal(leased,false);assert.equal(leases,1);assert.equal(releases,1);assert.equal(tokenReads,1);assert.equal(preflights,1);
  assert.equal(app.status().installer.phase,'verified');assert.deepEqual(app.publicStatus(session).counts,{total:59,succeeded:59});
  assert.equal(world.products.length,10);assert.equal(world.pages.length,7);assert(world.products.every(p=>p.status==='DRAFT'&&p.resourcePublicationsCount.count===0));assert(world.pages.every(p=>p.isPublished===false));assert.equal(world.installedTheme.role,'UNPUBLISHED');assert.equal(world.themeWrites.filter(name=>name==='MolyviBasicThemeCreate').length,1);
  const request=JSON.parse(await fs.readFile(path.join(storage,'controlled-operations','basic-preparation',session.projectId,requested.request.requestId,'request.json'))),bundle=JSON.parse(await fs.readFile(path.join(storage,'controlled-operations','basic-pipeline','bundle.json')));
  assert.equal(bundle.confirmation.requestHash,request.recordHash);assert.equal(bundle.confirmation.sourceHash,permit.sourceHash);assert.equal(bundle.plan.source.recordHash,permit.sourceHash);assert.equal(bundle.confirmation.planHash,bundle.plan.planHash);assert.equal(bundle.confirmation.themeZipSha256,sha(Buffer.from(bundle.theme.zipBytes,'base64')));
  assert.deepEqual((await fs.readdir(path.join(storage,'controlled-operations','basic-composition',`${session.projectId}-${request.requestId}`,'theme'))).sort(),['MOLYVI_Basic_Draft.zip','manifest.json']);
  assert.deepEqual(await fs.readFile(path.join(projectDirectory,'workspace.json')),sourceBefore);await app.stop();const before=await inventory(storage),counts={mutations:world.mutationNames.length,theme:world.themeWrites.length,tokenReads,preflights,leases,releases};now+=8*60*60*1000;
  const restarted=await api.createHostedBasicPipeline(config);instances.push(restarted);restarted.start();await restarted.drain();assert.equal(restarted.publicStatus(session).stage,'installed_draft');assert.equal(restarted.status().worker.enabled,false);await restarted.stop();
  assert.deepEqual(await inventory(storage),before);assert.deepEqual({mutations:world.mutationNames.length,theme:world.themeWrites.length,tokenReads,preflights,leases,releases},counts);
  if(process.env.MOLYVI_PIPELINE_TEST_REPORT){const pins=[];for(const file of ['molyvi-growth/lib/basic-preparation-capacity.mjs','molyvi-growth/lib/basic-preparation.mjs','molyvi-growth/lib/basic-preparation-worker.mjs','molyvi-growth/lib/hosted-basic-pipeline.mjs','molyvi-growth/lib/hosted-basic-prepared-installer.mjs','molyvi-growth/tests/hosted-basic-pipeline-integration.test.mjs'])pins.push({file,sha256:sha(await fs.readFile(path.join(originalRoot,file)))});await fs.writeFile(process.env.MOLYVI_PIPELINE_TEST_REPORT,JSON.stringify({status:'PASS',scope:'LOCAL_SYNTHETIC_FULL_CONFIRMATION_COMPOSITION_INSTALLATION',externalServiceCalls:0,realShopifyWrites:0,confirmedSourceHash:permit.sourceHash,requestHash:request.recordHash,planHash:bundle.plan.planHash,counts:app.publicStatus(session).counts,counters:app.status().installer.counters,products:world.products.length,variants:world.products.reduce((n,p)=>n+p.variants.nodes.length,0),photos:world.files.size,pages:world.pages.length,themeCreations:world.themeWrites.filter(name=>name==='MolyviBasicThemeCreate').length,leaseAcquisitions:leases,leaseReleases:releases,tokenReads,syntheticPreflights:preflights,unchangedWorkspace:true,restartAfterExpiry:{unchangedInventory:true,noAdditionalCalls:true},sourcePins:pins},null,2)+'\n',{flag:'wx'});}
});
