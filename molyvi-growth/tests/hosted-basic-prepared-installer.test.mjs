import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {PRIVATE_ROOT,canonicalJson} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {buildBasicThemePackage} from '../lib/basic-theme-package.mjs';
import {createShopifyImageDecoder} from '../lib/shopify-image-decoder.mjs';
import {createSyntheticBasicWorld} from './helpers/shopify-basic-composed-world.mjs';
import {createSyntheticThemeWorld} from './helpers/shopify-basic-theme-world.mjs';
import {prepareHostedPreparedBasicInstallation,loadHostedPreparedBasicInstaller,HOSTED_PREPARED_BASIC_INSTALLER_ROOT,HOSTED_PREPARED_BASIC_INSTALLER_JOBS_ROOT,HOSTED_PREPARED_BASIC_INSTALLER_LIMITS} from '../lib/hosted-basic-prepared-installer.mjs';
import {HOSTED_BASIC_INSTALLER_LIMITS} from '../lib/hosted-basic-installer.mjs';

const sharpPath=process.env.MOLYVI_TEST_SHARP_MODULE,options={skip:!sharpPath?'Explicit local sharp module required':false};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
let sharp,scratch;const owned=[],instances=[],reports=[];
test.before(async()=>{if(sharpPath){sharp=createRequire(import.meta.url)(sharpPath);scratch=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_hosted-prepared-tests-'));}});
async function removeOwned(directory,parent){const absolute=await fs.realpath(directory);assert.equal(path.dirname(absolute),await fs.realpath(parent));await fs.rm(absolute,{recursive:true});}
test.after(async()=>{
  for(const app of instances)await app.stop();
  for(const item of owned){
    const config=JSON.parse(await fs.readFile(item.configFile,'utf8'));assert.equal(config.projectId,item.projectId);assert.equal(config.jobId,item.jobId);
    const registry=path.join(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,'runtime','registry'),key=sha(JSON.stringify({projectId:item.projectId,targetStore:'molyvi-still-dev.myshopify.com'}));
    const file=path.join(registry,`${key}.json`),record=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(record.projectId,item.projectId);assert.equal(record.journalDirectory,item.journalDirectory);await fs.unlink(file);
    const progress=path.join(HOSTED_PREPARED_BASIC_INSTALLER_ROOT,'runtime','theme-progress',item.intentHash);
    try{const p=JSON.parse(await fs.readFile(path.join(progress,'record.json'),'utf8'));assert.equal(p.binding.projectId,item.projectId);await removeOwned(progress,path.dirname(progress));}catch(e){if(e.code!=='ENOENT')throw e;}
    await removeOwned(path.dirname(item.configFile),HOSTED_PREPARED_BASIC_INSTALLER_JOBS_ROOT);
  }
  if(scratch)await removeOwned(scratch,PRIVATE_ROOT);
  if(process.env.MOLYVI_PREPARED_INSTALL_TEST_REPORT)await fs.writeFile(process.env.MOLYVI_PREPARED_INSTALL_TEST_REPORT,JSON.stringify({mode:'LOCAL_SYNTHETIC_HTTP_WITH_REAL_IMAGE_DECODE',externalCalls:0,realShopifyWrites:0,newAiGenerations:0,reports},null,2)+'\n',{flag:'wx'});
});
function timerHarness(){let seq=0;const pending=new Map();return {timers:{setTimeout(fn){const id=++seq;pending.set(id,fn);return id;},clearTimeout(id){pending.delete(id);}},count:()=>pending.size,async tick(installer){const next=pending.entries().next().value;assert(next,'a bounded timer is scheduled');pending.delete(next[0]);next[1]();for(let n=0;n<12000&&installer.status().inFlight;n++)await new Promise(r=>setTimeout(r,10));assert.equal(installer.status().inFlight,false);}};}
async function setup(settings={}){
  const bytes=await sharp({create:{width:48,height:32,channels:3,background:'#663399'}}).png().toBuffer(),image=()=>({bytes,name:'synthetic.png',mime:'image/png'});
  const fixture=createBasicAssemblyFixture({productCount:1,sizeProductCount:1,...settings,...(settings.withLogo?{logoImage:image}:{}),sourceImage:image,generatedImage:image,priceMinor:({variantIndex})=>1990+variantIndex*100,stock:({variantIndex})=>[5,0,12][variantIndex],weightGrams:200});
  const prepared=prepareBasicStorePackage(fixture.record,{...fixture.options,binding:createBasicAssemblyBinding(fixture.record,fixture.options)}),built=await buildBasicThemePackage(prepared,{outputDirectory:path.join(scratch,crypto.randomUUID())}),theme={manifest:built.manifest,zipBytes:await fs.readFile(built.zipPath)};
  const confirmation={requestId:crypto.randomUUID(),sourceHash:sha(canonicalJson(fixture.record)),requestHash:'c'.repeat(64),projectId:fixture.record.id,ownerHash:prepared.plan.binding.ownerHash,planHash:prepared.plan.planHash,themeZipSha256:sha(theme.zipBytes)};
  const raw=Buffer.from(JSON.stringify({schemaVersion:1,kind:'molyvi_prepared_basic_bundle',confirmation,ownerId:fixture.record.ownerId,plan:prepared.plan,uploads:prepared.uploads.map(u=>({...u,bytes:u.bytes.toString('base64')})),theme:{manifest:theme.manifest,zipBytes:theme.zipBytes.toString('base64')}})+'\n'),bundleFile=path.join(scratch,`${crypto.randomUUID()}.json`);await fs.writeFile(bundleFile,raw);
  let now=Date.now();const clock=()=>now,jobId=crypto.randomUUID(),input={bundleFile,bundleSha256:sha(raw),jobId,authorizationSha256:'a'.repeat(64),operatorId:'synthetic-hosted-test',confirmation,preflightEvidence:{operatorId:'synthetic-hosted-test',observedAt:new Date(now).toISOString(),evidenceSha256:'b'.repeat(64),scopeConfirmed:true},clock};
  const activation=await prepareHostedPreparedBasicInstallation(input);owned.push(activation);
  const world=await createSyntheticThemeWorld({baseWorld:createSyntheticBasicWorld({sharp}),theme});let tokenReads=0;
  const base={configFile:activation.configFile,configSha256:activation.configSha256,networkEnabled:true,assertSourceCurrent:async value=>{assert.deepEqual(value,confirmation);return true;},getAccessToken:async()=>{tokenReads++;return 'shpat_SYNTHETIC_ONLY_NEVER_AN_ACTUAL_TOKEN';},fetchImpl:world.fetch,uploadFetch:world.uploadFetch,decodeImage:createShopifyImageDecoder({sharp}),clock};
  return {fixture,prepared,theme,world,input,activation,base,clock,advance:ms=>{now+=ms;},tokens:()=>tokenReads,load:async extra=>{const app=await loadHostedPreparedBasicInstaller({...base,...extra});instances.push(app);return app;}};
}

test('fresh preparation binds exactly the minimal package and cannot be repeated or loaded implicitly',options,async()=>{
  const r=await setup();assert.equal(r.world.products.length,0);await assert.rejects(prepareHostedPreparedBasicInstallation(r.input),{code:'HOSTED_PREPARED_BASIC_INSTALLER_ALREADY_PREPARED'});
  await assert.rejects(r.load({networkEnabled:false}),{code:'HOSTED_PREPARED_BASIC_INSTALLER_ACTIVATION_REQUIRED'});
  await assert.rejects(r.load({configSha256:'0'.repeat(64)}),{code:'HOSTED_PREPARED_BASIC_INSTALLER_CONFIG_SHA_MISMATCH'});
  const app=await r.load(),report=await app.inspect();assert.equal(report.phase,'prepared');assert.equal(report.counts.total,14);assert.equal(report.counters.graphQLRequests,0);assert.equal(r.tokens(),0);assert.equal(report.storage.insideExistingBackupSource,true);assert(report.storage.bytes<HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.ownedBytes);
});

test('trusted confirmation must match the exact immutable owner, source, request and package before reservation',options,async()=>{
  const r=await setup();
  for(const key of ['sourceHash','requestHash','ownerHash','planHash','themeZipSha256'])await assert.rejects(prepareHostedPreparedBasicInstallation({...r.input,confirmation:{...r.input.confirmation,[key]:'0'.repeat(64)}}),{code:'HOSTED_PREPARED_BASIC_INSTALLER_CONFIRMATION_BINDING'});
  await assert.rejects(prepareHostedPreparedBasicInstallation({...r.input,confirmation:{...r.input.confirmation,path:'/tmp/arbitrary'}}),{code:'HOSTED_PREPARED_BASIC_INSTALLER_CONFIRMATION_REQUIRED'});
  assert.equal(r.tokens(),0);assert.equal(r.world.products.length,0);
});

test('missing, false or failing live source confirmation stops before reading credentials or making provider calls',options,async()=>{
  for(const assertSourceCurrent of [undefined,async()=>false,async()=>{throw Error('PRIVATE_SOURCE_MUST_NOT_LEAK');}]){
    const r=await setup(),timer=timerHarness(),app=await r.load({timers:timer.timers,assertSourceCurrent});app.start();await timer.tick(app);const result=await app.inspect();
    assert.equal(result.phase,'stopped');assert.equal(result.counters.graphQLRequests,0);assert.equal(result.journalEventCount,0);assert.equal(r.tokens(),0);assert.equal(r.world.products.length,0);assert(!JSON.stringify(result).includes('PRIVATE_SOURCE'));
  }
});

test('a source change after one product preserves its receipt and prevents all later mutations',options,async()=>{
  const r=await setup(),timer=timerHarness();let current=true;
  const app=await r.load({timers:timer.timers,assertSourceCurrent:async()=>current,fetchImpl:async(url,init)=>{const value=await r.world.fetch(url,init);if(JSON.parse(init.body).query.startsWith('mutation MolyviBasicCatalogCreate'))current=false;return value;}});
  app.start();await timer.tick(app);const result=await app.inspect();assert.equal(result.phase,'stopped');assert.equal(result.counters.mutations,1);assert.equal(r.world.products.length,1);assert.equal(r.world.files.size,0);assert.equal(result.counts.succeeded,1);
});

test('8 MiB owned-storage ceiling is not expanded for the full Basic profile',options,async()=>{
  const r=await setup(),file=path.join(path.dirname(r.activation.configFile),'readbacks','synthetic-oversize.bin');
  const fd=await fs.open(file,'wx');try{await fd.truncate(HOSTED_PREPARED_BASIC_INSTALLER_LIMITS.ownedBytes);}finally{await fd.close();}
  await assert.rejects(r.load(),{code:'HOSTED_PREPARED_BASIC_INSTALLER_STORAGE_LIMIT'});assert.equal(r.tokens(),0);assert.equal(r.world.products.length,0);
});

test('full 10-product 14-variant 30-photo composition remains Draft and reopens without tokens, mutations or changed original limits',options,async()=>{
  assert.deepEqual(HOSTED_BASIC_INSTALLER_LIMITS,{graphQLRequests:250,mutations:24,stagedUploads:4,externalRequests:300,events:640,ownedBytes:8*1024*1024,elapsedMs:60*60*1000});
  const r=await setup({productCount:10,sizeProductCount:2,withLogo:true}),timer=timerHarness();let observedReservations=0;
  assert.equal(r.prepared.uploads.length,31);assert.equal(r.prepared.plan.branding.logoMode,'existing');assert.equal(r.prepared.plan.counts.photos,30);
  const checkedFetch=async(url,init)=>{const dir=path.join(path.dirname(r.activation.configFile),'operations'),names=(await fs.readdir(dir)).filter(n=>/^\d{6}\.json$/.test(n)).sort(),last=JSON.parse(await fs.readFile(path.join(dir,names.at(-1)),'utf8'));assert.equal(last.type,'reserve');assert(['graphql','mutation'].includes(last.kind));observedReservations++;return r.world.fetch(url,init);};
  const app=await r.load({timers:timer.timers,fetchImpl:checkedFetch});app.start();await timer.tick(app);const report=await app.inspect();
  assert.equal(report.phase,'verified');assert.equal(report.journalEventCount,118);assert.equal(report.counts.succeeded,59);assert.equal(report.counters.graphQLRequests,observedReservations);assert.equal(report.counters.mutations,120);assert.equal(report.counters.stagedUploads,31);assert(report.counters.externalRequests>=61);assert.equal(r.world.products.length,10);assert(r.world.products.every(p=>p.status==='DRAFT'&&p.resourcePublicationsCount.count===0));assert.equal(r.world.products.reduce((n,p)=>n+p.variants.nodes.length,0),14);assert.equal(r.world.products.reduce((n,p)=>n+p.media.nodes.length,0),30);assert.equal(r.world.pages.length,7);assert(r.world.pages.every(p=>p.isPublished===false));assert.equal(r.world.installedTheme.role,'UNPUBLISHED');assert.equal(r.tokens(),1);
  reports.push({label:'10_products_14_variants_30_photos',...report,confirmation:undefined});
  const before=report.eventCount;await app.stop();r.advance(2*60*60*1000);const noTokens=async()=>{throw Error('terminal must not read credentials');},secondTimer=timerHarness(),second=await r.load({timers:secondTimer.timers,getAccessToken:noTokens,decodeImage:undefined,assertSourceCurrent:undefined});second.start();await secondTimer.tick(second);assert.equal(second.status().lifecycle,'completed');assert.equal((await second.inspect()).eventCount,before);assert.equal(r.world.themeWrites.filter(n=>n==='MolyviBasicThemeCreate').length,1);await second.stop();
});

test('known theme waiting survives restart; the scheduler only reconciles and reserves cumulative requests',options,async()=>{
  const r=await setup();r.world.themeControl.processingReads=4;const firstTimer=timerHarness(),first=await r.load({timers:firstTimer.timers});first.start();await firstTimer.tick(first);
  const pending=await first.inspect();assert.equal(pending.phase,'waiting');assert.equal(pending.counts.succeeded,13);assert.equal(pending.journalEventCount,27);assert.equal(pending.waiting.themeId,'99001');await first.stop();
  const secondTimer=timerHarness(),second=await r.load({timers:secondTimer.timers});second.start();await secondTimer.tick(second);r.advance(1000);await secondTimer.tick(second);const again=await second.inspect();assert.equal(again.phase,'waiting');assert(again.counters.graphQLRequests>pending.counters.graphQLRequests);assert.equal(again.counters.mutations,pending.counters.mutations);r.advance(2000);await secondTimer.tick(second);
  const complete=await second.inspect();assert.equal(complete.phase,'verified');assert.equal(complete.journalEventCount,28);assert.equal(complete.counts.succeeded,14);assert.equal(complete.counters.mutations,21);assert.equal(complete.counters.stagedUploads,4);assert.equal(r.world.themeWrites.filter(n=>n==='MolyviBasicThemeCreate').length,1);assert.equal(r.world.products.length,1);r.advance(1000);await secondTimer.tick(second);assert.equal(second.status().lifecycle,'completed');await second.stop();
});

test('lost mutation response is stopped once, sanitized and never recreated after restart',options,async()=>{
  const r=await setup();r.world.themeControl.loseCreateResponse=true;const timer=timerHarness(),app=await r.load({timers:timer.timers});app.start();await timer.tick(app);const stopped=await app.inspect();assert.equal(stopped.phase,'stopped');assert.equal(stopped.counts.succeeded,13);assert.equal(stopped.journalEventCount,27);assert.equal(stopped.lastCode,'BASIC_INSTALL_RUNNER_APPLY_FAILED');assert(!JSON.stringify(stopped).includes('SECRET'));assert.equal(r.world.themeWrites.filter(n=>n==='MolyviBasicThemeCreate').length,1);await app.stop();
  const againTimer=timerHarness(),again=await r.load({timers:againTimer.timers,getAccessToken:async()=>{throw Error('must not ask');}});again.start();await againTimer.tick(again);assert.equal((await again.inspect()).counters.graphQLRequests,stopped.counters.graphQLRequests);assert.equal(r.world.themeWrites.filter(n=>n==='MolyviBasicThemeCreate').length,1);await again.stop();
});

test('pause drains the initial in-flight operation and prevents later creates or automatic pre-theme restart',options,async()=>{
  const r=await setup(),timer=timerHarness();let app,seen=0;
  const pausedFetch=async(url,init)=>{seen++;if(seen===1)app.pause();return r.world.fetch(url,init);};app=await r.load({timers:timer.timers,fetchImpl:pausedFetch});app.start();await timer.tick(app);await app.drain();const report=await app.inspect();assert.equal(report.phase,'stopped');assert.equal(report.lastCode,'INITIAL_INTERRUPTED');assert.equal(r.world.products.length,1);assert.equal(r.world.files.size,0);assert.equal(r.world.themeWrites.length,0);await app.stop();
  const secondTimer=timerHarness(),second=await r.load({timers:secondTimer.timers});second.start();await secondTimer.tick(second);assert.equal(r.world.products.length,1);assert.equal(r.world.files.size,0);await second.stop();
});

test('changed immutable bundle is rejected before activation, decoder or any provider call',options,async()=>{
  const r=await setup(),file=path.join(path.dirname(r.activation.configFile),'bundle.json');await fs.appendFile(file,' ');await assert.rejects(r.load(),{code:'HOSTED_PREPARED_BASIC_INSTALLER_PACKAGE_SHA_MISMATCH'});assert.equal(r.tokens(),0);assert.equal(r.world.products.length,0);
});

async function syntheticLedger(run,types){
  const config=JSON.parse(await fs.readFile(run.activation.configFile,'utf8')),directory=path.join(path.dirname(run.activation.configFile),'operations');let previous=sha(canonicalJson(config)),sequence=0;
  for(const [type,extra] of types){const body={sequence:++sequence,previousHash:previous,intentHash:run.activation.intentHash,type,observedAt:config.preparedAt,...extra},event={...body,eventHash:sha(canonicalJson(body))};await fs.writeFile(path.join(directory,`${String(sequence).padStart(6,'0')}.json`),JSON.stringify(event)+'\n');previous=event.eventHash;}
  await fs.writeFile(path.join(directory,'head.json'),JSON.stringify({intentHash:run.activation.intentHash,sequence,eventHash:previous})+'\n');return directory;
}
test('a crash during the initial session stops on restart instead of continuing even an otherwise empty journal',options,async()=>{
  const r=await setup();await syntheticLedger(r,[['install',{}]]);const timers=timerHarness(),app=await r.load({timers:timers.timers});app.start();await timers.tick(app);const report=await app.inspect();assert.equal(report.phase,'stopped');assert.equal(report.lastCode,'INTERRUPTED_INITIAL_OR_RECHECK');assert.equal(report.journalEventCount,0);assert.equal(report.counters.graphQLRequests,0);assert.equal(r.tokens(),0);assert.equal(r.world.products.length,0);await app.stop();
});

test('budget tail truncation and an interrupted checkpoint cannot reduce persisted counters',options,async()=>{
  const r=await setup(),directory=await syntheticLedger(r,[['install',{}],['reserve',{kind:'graphql',operationSha256:'c'.repeat(64)}]]);await fs.unlink(path.join(directory,'000002.json'));await assert.rejects(r.load(),{code:'HOSTED_PREPARED_BASIC_INSTALLER_LEDGER_HIGH_WATER_MISMATCH'});assert.equal(r.tokens(),0);
  const gap=await setup(),d=path.join(path.dirname(gap.activation.configFile),'operations');await fs.writeFile(path.join(d,'head.next.json'),'{}');await assert.rejects(gap.load(),{code:'HOSTED_PREPARED_BASIC_INSTALLER_LEDGER_CORRUPT'});assert.equal(gap.tokens(),0);
});

test('persisted request budgets are checked again on restart before any credential or outbound access',options,async()=>{
  const r=await setup();await syntheticLedger(r,[['install',{}],...Array.from({length:701},()=>['reserve',{kind:'graphql',operationSha256:'c'.repeat(64)}])]);await assert.rejects(r.load(),{code:'HOSTED_PREPARED_BASIC_INSTALLER_BUDGET_EXHAUSTED'});assert.equal(r.tokens(),0);assert.equal(r.world.products.length,0);
});
