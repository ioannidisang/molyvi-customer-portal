import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {PRIVATE_ROOT,canonicalJson} from '../lib/intake-store.mjs';
import {TaskStore} from '../lib/task-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicPreparationService} from '../lib/basic-preparation.mjs';
import {createShopifyImageDecoder} from '../lib/shopify-image-decoder.mjs';
import {installPreparedBasicReference,BASIC_REFERENCE_INSTALL_LIMITS} from '../lib/basic-prepared-reference-installer.mjs';
const hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const sharp=createRequire(import.meta.url)('sharp');sharp.cache(false);sharp.concurrency(1);
const decodeImage=createShopifyImageDecoder({sharp});
const png=await sharp({create:{width:32,height:32,channels:3,background:'#abcdef'}}).png().toBuffer();
async function fixture(){
  const root=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_prepared-reference-'));
  const f=createBasicAssemblyFixture({productCount:1,sourceImage:()=>({bytes:png,name:'source.png',mime:'image/png'}),generatedImage:()=>({bytes:png,name:'selected.png',mime:'image/png'})});
  const store=await new TaskStore(path.join(root,'input')).ready();await store.create(f.record);const dir=await store.directory(f.record.id);
  for(const [items,prefix]of [[f.options.sourceAssets,'photo'],[f.options.assets,'generated']])for(const {asset,bytes}of items)await fs.writeFile(path.join(dir,`${prefix}-${asset.id}.bin`),bytes,{flag:'wx'});
  const session={projectId:f.record.id,ownerId:f.record.ownerId};
  const preparation=await createBasicPreparationService({store,storage:path.join(root,'receipts'),buildRoot:path.join(root,'build'),buildEnabled:true,referenceComposition:true,decodeImage});
  const request=await preparation.request(session,{expectedSourceHash:hash(f.record),acknowledged:true});await preparation.prepare(session,{requestId:request.request.requestId});
  const loaded=await preparation.loadPrepared(session,{requestId:request.request.requestId});const registryDirectory=path.join(root,'registry');await fs.mkdir(registryDirectory);
  let calls=0,leases=0,releases=0;
  const options={preparation,session,confirmation:loaded.confirmation,directory:path.join(root,'journal'),registryDirectory,authorizationSha256:'a'.repeat(64),operatorId:'test',preflightEvidence:{operatorId:'test',observedAt:new Date().toISOString(),evidenceSha256:'b'.repeat(64),scopeConfirmed:true},accessToken:'shpat_LOCAL_TEST_ONLY_NO_ACTUAL_CREDENTIAL',decodeImage,fetchImpl:async()=>{calls++;throw Error('synthetic offline failure');},uploadFetch:async()=>{calls++;throw Error('unexpected upload');},withResources:async fn=>{leases++;try{return await fn();}finally{releases++;}}};
  return {root,dir,options,counts:()=>({calls,leases,releases})};
}
test('changed customer confirmation stops before journal or network',async()=>{
  const f=await fixture();await assert.rejects(installPreparedBasicReference({...f.options,confirmation:{...f.options.confirmation,sourceHash:'c'.repeat(64)}}),{code:'BASIC_REFERENCE_INSTALL_CONFIRMATION_CHANGED'});
  assert.deepEqual(f.counts(),{calls:0,leases:1,releases:1});await assert.rejects(fs.stat(f.options.directory),{code:'ENOENT'});
});
test('foreign owner and fabricated source are rejected before dispatch',async()=>{
  const f=await fixture();await assert.rejects(installPreparedBasicReference({...f.options,session:{...f.options.session,ownerId:crypto.randomUUID()}}),{code:'BASIC_REFERENCE_INSTALL_CONFIRMATION_REQUIRED'});
  await assert.rejects(installPreparedBasicReference({...f.options,preparation:{loadPrepared:async()=>({confirmation:f.options.confirmation,referenceComposition:{plan:{}}})}}),{code:'BASIC_REFERENCE_INSTALL_CONFIRMATION_CHANGED'});assert.equal(f.counts().calls,0);
});
test('failure preserves one attempt, durable request debit and source hold; retry cannot dispatch',async()=>{
  const f=await fixture();await assert.rejects(installPreparedBasicReference(f.options),{code:'BASIC_INSTALL_RUNNER_PREFLIGHT_FAILED'});
  assert.deepEqual(f.counts(),{calls:1,leases:1,releases:1});
  const debit=JSON.parse(await fs.readFile(f.options.directory+'.bridge/000001.json'));assert.equal(debit.counters.graphQLRequests,1);assert.equal(debit.counters.mutations,0);
  assert(await fs.stat(path.join(f.dir,'.basic-source-retention/hold.json')));await assert.rejects(fs.stat(path.join(f.dir,'.basic-source-retention/release.json')),{code:'ENOENT'});
  await assert.rejects(installPreparedBasicReference(f.options));assert.equal(f.counts().calls,1);assert.equal(f.counts().leases,f.counts().releases);
});
test('existing resource ceilings remain exact',()=>{assert.deepEqual(BASIC_REFERENCE_INSTALL_LIMITS,{graphQLRequests:700,mutations:130,stagedUploads:31,externalRequests:800,ownedBytes:8388608,elapsedMs:3600000});});
