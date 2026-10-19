import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {TaskStore} from '../lib/task-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicPreparationService,BASIC_PREPARATION_LIMITS,BASIC_PREPARATION_TARGET} from '../lib/basic-preparation.mjs';
import {inspectHostedBasicCompositionCapacity,estimateHostedBasicCompositionOutput,HOSTED_BASIC_COMPOSITION_LIMITS} from '../lib/basic-preparation-capacity.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';

const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=()=>crypto.randomUUID();
async function snapshot(root) {
  const result=[];
  async function walk(directory,prefix='') {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const name=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(file,name);else result.push({file:name,sha256:sha(await fs.readFile(file))});
    }
  }
  await walk(root);return result.sort((a,b)=>a.file.localeCompare(b.file));
}
async function fixture(t,{buildEnabled=false,productCount=1,sizeProductCount=0,hostedCompact=false,generatedImage}={}) {
  const root=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_basic-preparation-test-'));
  t.after(async()=>{const actual=await fs.realpath(root);assert.equal(path.dirname(actual),await fs.realpath(PRIVATE_ROOT));assert(path.basename(actual).startsWith('_basic-preparation-test-'));await fs.rm(actual,{recursive:true});});
  const f=createBasicAssemblyFixture({productCount,sizeProductCount,generatedImage}),store=await new TaskStore(path.join(root,'workspaces')).ready();
  await store.create(f.record);const projectDirectory=await store.directory(f.record.id);
  for(const [items,prefix] of [[f.options.sourceAssets,'photo'],[f.options.assets,'generated']])for(const item of items)await fs.writeFile(path.join(projectDirectory,`${prefix}-${item.asset.id}.bin`),item.bytes,{flag:'wx'});
  const session={projectId:f.record.id,ownerId:f.record.ownerId},storage=hostedCompact?path.join(root,'controlled-operations','basic-preparation'):path.join(root,'metadata'),buildRoot=hostedCompact?path.join(root,'controlled-operations','basic-composition'):path.join(root,'builds');
  const config={store,storage,targetStore:BASIC_PREPARATION_TARGET,...(buildEnabled?{buildEnabled,buildRoot,hostedCompact}:{})};
  const service=await createBasicPreparationService(config);
  return {...f,root,store,session,storage,buildRoot,config,service,sourceHash:hash(f.record)};
}
const request=(f,sourceHash=f.sourceHash)=>f.service.request(f.session,{expectedSourceHash:sourceHash,acknowledged:true});

test('startup and status are read-only; readiness and receipts expose no owner or private paths',async t=>{
  const f=await fixture(t),before=await snapshot(f.root);
  assert.equal(await fs.stat(f.storage).then(()=>true,()=>false),false);
  const status=await f.service.status(f.session);
  assert.equal(status.readiness.ready,true);assert.equal(status.sourceHash,f.sourceHash);assert.equal(status.projectId,f.record.id);assert.equal(status.request,null);
  assert.equal(status.installationEnabled,false);assert.equal(status.published,false);assert.deepEqual(await snapshot(f.root),before);
  assert(!JSON.stringify(status).includes(f.record.ownerId));assert(!JSON.stringify(status).includes(f.root));
});

test('owner-scoped immutable requests survive restart and concurrent duplicates create only one receipt',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(await f.store.directory(f.record.id),'workspace.json'));
  const [a,b]=await Promise.all([request(f),request(f)]);
  assert.equal(a.request.requestId,b.request.requestId);assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);assert.equal(a.request.state,'requested');
  const restarted=await createBasicPreparationService(f.config),c=await restarted.request(f.session,{expectedSourceHash:f.sourceHash,acknowledged:true});
  assert.equal(c.duplicate,true);assert.equal(c.request.requestId,a.request.requestId);
  const directory=path.join(f.storage,f.record.id,a.request.requestId);assert.deepEqual(await fs.readdir(directory),['request.json']);
  assert.deepEqual(await fs.readFile(path.join(await f.store.directory(f.record.id),'workspace.json')),before);
  assert(!JSON.stringify(c).includes(f.record.ownerId));assert(!JSON.stringify(c).includes(f.storage));
});

test('wrong owners, stale source, incomplete inputs and client instruction injection are rejected without metadata',async t=>{
  const f=await fixture(t),before=await snapshot(f.root);
  await assert.rejects(f.service.status({...f.session,ownerId:uuid()}),{code:'NOT_OWNER'});
  await assert.rejects(f.service.request({...f.session,ownerId:uuid()},{expectedSourceHash:f.sourceHash,acknowledged:true}),{code:'NOT_OWNER'});
  await assert.rejects(request(f,'a'.repeat(64)),{code:'BASIC_PREPARATION_SOURCE_CHANGED'});
  for(const extra of [{targetStore:'other.myshopify.com'},{ownerId:uuid()},{outputDirectory:'elsewhere'},{authorization:true},{requestId:uuid()}])await assert.rejects(f.service.request(f.session,{expectedSourceHash:f.sourceHash,acknowledged:true,...extra}),{code:'BASIC_PREPARATION_INVALID_REQUEST'});
  await assert.rejects(f.service.request(f.session,{expectedSourceHash:f.sourceHash,acknowledged:false}),{code:'BASIC_PREPARATION_INVALID_REQUEST'});
  assert.deepEqual(await snapshot(f.root),before);
  await f.store.transact(f.record.id,f.record.ownerId,record=>{delete record.tasks.pages.submission;});
  const current=await f.store.read(f.record.id,f.record.ownerId);
  await assert.rejects(request(f,hash(current)),{code:'BASIC_PREPARATION_NOT_READY'});
  assert.equal(await fs.stat(f.storage).then(()=>true,()=>false),false);
});

test('changed selected source invalidates a request; old expected hash never refreshes it',async t=>{
  const f=await fixture(t,{buildEnabled:true}),created=await request(f);
  await f.store.transact(f.record.id,f.record.ownerId,record=>{const gallery=Object.values(record.productGalleries)[0];gallery.order.reverse();gallery.revision++;});
  const status=await f.service.status(f.session);assert.equal(status.request.state,'source_changed');
  await assert.rejects(request(f),{code:'BASIC_PREPARATION_SOURCE_CHANGED'});
  await assert.rejects(f.service.prepare(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_SOURCE_CHANGED'});
  assert.deepEqual(await fs.readdir(path.join(f.storage,f.record.id,created.request.requestId)),['request.json']);
});

test('hosted metadata service cannot build or accept a changed target',async t=>{
  const f=await fixture(t),created=await request(f);
  await assert.rejects(f.service.prepare(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_LOCAL_BUILD_DISABLED'});
  await assert.rejects(createBasicPreparationService({...f.config,targetStore:'nutritiger.myshopify.com'}),{code:'BASIC_PREPARATION_CONFIG_INVALID'});
  await assert.rejects(createBasicPreparationService({...f.config,buildRoot:f.buildRoot}),{code:'BASIC_PREPARATION_BUILD_CONFIG_DISABLED'});
  await assert.rejects(createBasicPreparationService({...f.config,storage:path.join(f.store.storage,'unsafe')}),{code:'BASIC_PREPARATION_PRIVATE_STORAGE_REQUIRED'});
  assert.equal(await fs.stat(f.buildRoot).then(()=>true,()=>false),false);
});

test('one local real Basic composition preserves exact source and yields a private Draft package plus theme',async t=>{
  const f=await fixture(t,{buildEnabled:true,productCount:10,sizeProductCount:2}),sourceBefore=await fs.readFile(path.join(await f.store.directory(f.record.id),'workspace.json')),created=await request(f);
  const [built,repeated]=await Promise.all([f.service.prepare(f.session,{requestId:created.request.requestId}),f.service.prepare(f.session,{requestId:created.request.requestId})]);
  assert.equal(built.request.state,'prepared_for_installation_review');assert.equal(built.duplicate,false);assert.equal(repeated.duplicate,true);
  assert.equal(repeated.request.planHash,built.request.planHash);assert.deepEqual(built.request.counts,{products:10,visualUnits:10,photos:30,pages:7});
  const output=path.join(f.buildRoot,`${f.record.id}-${created.request.requestId}`),plan=JSON.parse(await fs.readFile(path.join(output,'package','package-plan.json'),'utf8')),manifest=JSON.parse(await fs.readFile(path.join(output,'theme','manifest.json'),'utf8'));
  assert.deepEqual(plan.counts,{products:10,variants:14,visualUnits:10,photos:30,pages:7});assert.equal(plan.source.recordHash,f.sourceHash);assert.equal(plan.planHash,built.request.planHash);
  assert.equal(plan.products[0].variants[0].price,'29.90');assert.equal(plan.products[0].variants[0].stock,12);assert.equal(plan.products[0].variants[1].stock,0);
  assert(plan.products.every(product=>product.status==='DRAFT'&&!product.publishedOnOnlineStore));assert(plan.pages.every(page=>page.isPublished===false));assert.equal(manifest.status,'UNPUBLISHED_NOT_APPLIED');
  assert.equal(sha(await fs.readFile(path.join(output,'theme','MOLYVI_Basic_Draft.zip'))),built.request.themeZipSha256);
  assert.deepEqual(await fs.readFile(path.join(await f.store.directory(f.record.id),'workspace.json')),sourceBefore);
  const restarted=await createBasicPreparationService(f.config),before=await snapshot(f.root);
  const again=await restarted.prepare(f.session,{requestId:created.request.requestId});assert.equal(again.duplicate,true);assert.equal(again.request.outputVerifiedNow,true);assert.deepEqual(await snapshot(f.root),before);
  assert.equal((await restarted.status(f.session)).request.outputVerifiedNow,false);
  await fs.appendFile(path.join(output,'theme','MOLYVI_Basic_Draft.zip'),'corrupted');
  await assert.rejects(restarted.prepare(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_OUTPUT_CHANGED'});
});

test('an interrupted reservation is visible as unknown after restart and can never auto-retry',async t=>{
  const f=await fixture(t,{buildEnabled:true}),created=await request(f),directory=path.join(f.storage,f.record.id,created.request.requestId),saved=JSON.parse(await fs.readFile(path.join(directory,'request.json'),'utf8'));
  const attempt={schemaVersion:1,kind:'molyvi_basic_preparation_attempt',projectId:f.record.id,ownerHash:hash(f.record.ownerId),requestId:saved.requestId,sourceHash:saved.sourceHash,requestHash:saved.recordHash,reservedAt:new Date().toISOString()};
  await fs.writeFile(path.join(directory,'attempt.json'),JSON.stringify({...attempt,recordHash:hash(attempt)}),{flag:'wx'});
  const restarted=await createBasicPreparationService(f.config),before=await snapshot(f.root);
  assert.equal((await restarted.status(f.session)).request.state,'preparation_unknown');
  await assert.rejects(restarted.prepare(f.session,{requestId:saved.requestId}),{code:'BASIC_PREPARATION_ATTEMPT_ALREADY_RESERVED'});
  assert.deepEqual(await snapshot(f.root),before);
});

test('source mutation during final local commit prevents prepared status and preserves partial artifacts privately',async t=>{
  const f=await fixture(t,{buildEnabled:true}),created=await request(f),output=path.join(f.buildRoot,`${f.record.id}-${created.request.requestId}`),originalLoad=f.store.load.bind(f.store);let changed=false;
  f.store.load=async (...args)=>{
    const loaded=await originalLoad(...args);
    if(!changed && await fs.stat(path.join(output,'theme','manifest.json')).then(()=>true,()=>false)) {
      changed=true;loaded.record.notesAfterSubmission='Synthetic concurrent source change';await f.store.write(loaded.directory,loaded.record);
    }
    return loaded;
  };
  await assert.rejects(f.service.prepare(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_SOURCE_CHANGED_DURING_BUILD'});
  assert.equal(changed,true);const status=await f.service.status(f.session);assert.equal(status.request.state,'source_changed');assert.equal(status.request.planHash,undefined);
  const result=JSON.parse(await fs.readFile(path.join(f.storage,f.record.id,created.request.requestId,'result.json'),'utf8'));assert.equal(result.state,'failed');assert.equal(result.artifacts,null);
  assert.equal(await fs.stat(path.join(output,'theme','MOLYVI_Basic_Draft.zip')).then(()=>true,()=>false),true);
});

test('finite per-project request allowance cannot be bypassed by valid source edits',async t=>{
  const f=await fixture(t);
  for(let i=0;i<BASIC_PREPARATION_LIMITS.requestsPerProject;i++) {
    await f.store.transact(f.record.id,f.record.ownerId,record=>{record.syntheticRevision=i;});
    const current=await f.store.read(f.record.id,f.record.ownerId);await request(f,hash(current));
  }
  await f.store.transact(f.record.id,f.record.ownerId,record=>{record.syntheticRevision=99;});
  await assert.rejects(request(f,hash(await f.store.read(f.record.id,f.record.ownerId))),{code:'BASIC_PREPARATION_PROJECT_REQUEST_LIMIT'});
  assert.equal((await fs.readdir(path.join(f.storage,f.record.id))).length,8);
});

test('unknown metadata files fail closed; no repair or deletion is attempted',async t=>{
  const f=await fixture(t),created=await request(f),directory=path.join(f.storage,f.record.id,created.request.requestId);
  await fs.writeFile(path.join(directory,'unexpected.json'),'{}',{flag:'wx'});const before=await snapshot(f.root);
  await assert.rejects(f.service.status(f.session),{code:'BASIC_PREPARATION_INCOMPLETE_RECORD'});assert.deepEqual(await snapshot(f.root),before);
});

test('hosted compact composition has exact two theme artifacts and trusted restart handoff verifies source and bytes',async t=>{
  const f=await fixture(t,{buildEnabled:true,hostedCompact:true}),created=await request(f),before=await fs.readFile(path.join(await f.store.directory(f.record.id),'workspace.json'));
  const admission=await inspectHostedBasicCompositionCapacity({store:f.store,session:f.session,record:f.record,buildRoot:f.buildRoot});
  const built=await f.service.prepare(f.session,{requestId:created.request.requestId}),directory=path.join(f.buildRoot,`${f.record.id}-${created.request.requestId}`,'theme');
  assert.equal(built.request.state,'prepared_for_installation_review');assert.deepEqual((await fs.readdir(directory)).sort(),['MOLYVI_Basic_Draft.zip','manifest.json']);
  const restarted=await createBasicPreparationService(f.config),snapshotBefore=await snapshot(f.root),bundle=await restarted.loadPrepared(f.session,{requestId:created.request.requestId});
  assert.deepEqual(await snapshot(f.root),snapshotBefore);assert.equal(bundle.prepared.plan.planHash,built.request.planHash);assert.equal(bundle.confirmation.sourceHash,f.sourceHash);assert.equal(bundle.confirmation.ownerHash,hash(f.session.ownerId));assert.equal(bundle.theme.manifest.zip.sha256,sha(bundle.theme.zipBytes));
  const saved=JSON.parse(await fs.readFile(path.join(f.storage,f.record.id,created.request.requestId,'request.json')));assert.equal(bundle.confirmation.requestHash,saved.recordHash);assert(bundle.prepared.uploads.every(item=>Buffer.isBuffer(item.bytes)));
  const packageManifestBytes=await fs.readFile(path.join(path.dirname(directory),'package','manifest.json')),packageManifest=JSON.parse(packageManifestBytes),actualOutputBytes=packageManifest.files.reduce((sum,item)=>sum+item.bytes,packageManifestBytes.length)+(await fs.stat(path.join(directory,'MOLYVI_Basic_Draft.zip'))).size+(await fs.stat(path.join(directory,'manifest.json'))).size;
  assert(packageManifest.files.reduce((sum,item)=>sum+item.bytes,packageManifestBytes.length)<admission.packageBoundBytes);assert(actualOutputBytes<admission.outputBoundBytes);assert.equal(admission.planBytes,Buffer.byteLength(JSON.stringify(bundle.prepared.plan,null,2)+'\n'));
  assert.deepEqual(await fs.readFile(path.join(await f.store.directory(f.record.id),'workspace.json')),before);
  await assert.rejects(restarted.loadPrepared({...f.session,ownerId:uuid()},{requestId:created.request.requestId}),{code:'NOT_OWNER'});
  const later=path.join(f.root,'controlled-operations','later-capacity.bin');await fs.writeFile(later,'');await fs.truncate(later,500000000);
  await assert.rejects(restarted.prepare(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_BACKUP_HEADROOM_REQUIRED'});
  await assert.rejects(restarted.loadPrepared(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_BACKUP_HEADROOM_REQUIRED'});
  assert.equal((await restarted.status(f.session)).request.state,'prepared_for_installation_review');await fs.truncate(later,0);
  await fs.appendFile(path.join(directory,'MOLYVI_Basic_Draft.zip'),'tampered');await assert.rejects(restarted.loadPrepared(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_OUTPUT_CHANGED'});
});

test('hosted stat-only capacity enforces input boundary and unchanged backup reserve before durable attempt',async t=>{
  const f=await fixture(t,{buildEnabled:true,hostedCompact:true}),capacity=()=>inspectHostedBasicCompositionCapacity({store:f.store,session:f.session,record:f.record,buildRoot:f.buildRoot}),initial=await capacity();
  assert.equal(initial.maximumInputBytes,8*1024*1024);assert.equal(initial.backupSourceLimit,512000000);assert.equal(initial.reservedInstallerBytes,8*1024*1024);assert.equal(initial.reservedPipelineBytes,3*1024*1024);assert.equal(initial.reservedMetadataBytes,1024*1024);
  const png=f.options.assets[0].bytes,padded=Buffer.alloc(HOSTED_BASIC_COMPOSITION_LIMITS.inputBytes-3*png.length);png.copy(padded);
  const boundary=await fixture(t,{buildEnabled:true,hostedCompact:true,generatedImage:({slotIndex})=>({bytes:slotIndex===0?padded:png,name:'synthetic.png',mime:'image/png'})}),boundaryCapacity=()=>inspectHostedBasicCompositionCapacity({store:boundary.store,session:boundary.session,record:boundary.record,buildRoot:boundary.buildRoot});
  assert.equal((await boundaryCapacity()).inputBytes,8*1024*1024);
  const asset=Object.values(boundary.record.generatedAssets)[0],file=path.join(await boundary.store.directory(boundary.record.id),`generated-${asset.id}.bin`);asset.bytes++;await fs.truncate(file,asset.bytes);await assert.rejects(boundaryCapacity(),{code:'BASIC_PREPARATION_HOSTED_INPUT_BYTES_LIMIT'});
  const created=await request(f);await fs.mkdir(path.join(f.root,'controlled-operations'),{recursive:true});const large=path.join(f.root,'controlled-operations','capacity-test.bin');await fs.writeFile(large,'');await fs.truncate(large,500000000);
  await assert.rejects(f.service.prepare(f.session,{requestId:created.request.requestId}),{code:'BASIC_PREPARATION_BACKUP_HEADROOM_REQUIRED'});
  assert.deepEqual(await fs.readdir(path.join(f.storage,f.record.id,created.request.requestId)),['request.json']);assert.equal(await fs.stat(f.buildRoot).then(()=>true,()=>false),false);
});

test('hosted capacity rejects unexpected service roots and mismatching asset stats before writing',async t=>{
  const f=await fixture(t,{buildEnabled:true,hostedCompact:true}),capacity=()=>inspectHostedBasicCompositionCapacity({store:f.store,session:f.session,record:f.record,buildRoot:f.buildRoot}),asset=Object.values(f.record.generatedAssets)[0];
  asset.bytes++;await assert.rejects(capacity(),{code:'BASIC_PREPARATION_CAPACITY_ASSET_CHANGED'});asset.bytes--;
  await fs.writeFile(path.join(f.root,'unexpected.json'),'{}');await assert.rejects(capacity(),{code:'BASIC_PREPARATION_UNEXPECTED_SERVICE_ROOT'});
  assert.equal(await fs.stat(f.storage).then(()=>true,()=>false),false);
  await assert.rejects(createBasicPreparationService({...f.config,buildRoot:path.join(f.root,'other-build')}),{code:'BASIC_PREPARATION_HOSTED_BUILD_SCOPE'});
});

test('capacity counts immutable output plan rather than workspace history that is never emitted',async t=>{
  const f=await fixture(t,{buildEnabled:true,hostedCompact:true}),capacity=()=>inspectHostedBasicCompositionCapacity({store:f.store,session:f.session,record:f.record,buildRoot:f.buildRoot}),before=await capacity();
  f.record.syntheticHistory='x'.repeat(500000);await f.store.write(await f.store.directory(f.record.id),f.record);const after=await capacity();
  assert.equal(after.planBytes,before.planBytes);assert.equal(after.outputBoundBytes,before.outputBoundBytes);assert(after.sourceBytes>before.sourceBytes+500000);assert.equal(after.backupSourceLimit,512000000);assert.equal(after.reservedInstallerBytes+after.reservedPipelineBytes+after.reservedMetadataBytes,12*1024*1024);
});

test('hosted pure output estimator counts every emitted asset and rejects invalid admission metadata',()=>{
  const f=createBasicAssemblyFixture({productCount:1}),prepared=prepareBasicStorePackage(f.record,{...f.options,binding:createBasicAssemblyBinding(f.record,{targetStore:f.options.targetStore})});
  const options={prepared,theme:{bytes:4544294,files:351},heroBytes:prepared.uploads[0].bytes.length},bound=estimateHostedBasicCompositionOutput(options);
  const repeated=estimateHostedBasicCompositionOutput({...options,prepared:{...prepared,uploads:[...prepared.uploads,prepared.uploads[0]]}});
  assert.equal(repeated.packageBoundBytes-bound.packageBoundBytes,prepared.uploads[0].bytes.length);assert.equal(repeated.outputBoundBytes-bound.outputBoundBytes,prepared.uploads[0].bytes.length);
  assert.equal(bound.planBytes,Buffer.byteLength(JSON.stringify(prepared.plan,null,2)+'\n'));
  for(const theme of [{bytes:-1,files:351},{bytes:0,files:0},{bytes:Infinity,files:351}])assert.throws(()=>estimateHostedBasicCompositionOutput({...options,theme}),{code:'BASIC_PREPARATION_CAPACITY_PLAN_METADATA'});
  assert.throws(()=>estimateHostedBasicCompositionOutput({...options,heroBytes:-1}),{code:'BASIC_PREPARATION_CAPACITY_PLAN_METADATA'});
});
