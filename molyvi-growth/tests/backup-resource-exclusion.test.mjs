import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
import {createWorkspaceApp} from '../paid-workspace-server.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<400;n++){if(fn())return;await delay(5);}throw Error('TEST_WAIT_TIMEOUT');}
async function fixture(t,{worker,receiver,holdStartup}={}){
  const storage=path.join(PRIVATE_ROOT,'_backup-resources-'+crypto.randomUUID());
  const app=await createHostedCustomerServer({storage,publicOrigin:'https://app.molyvi.com',basicInstaller:worker});
  let server=app.server;
  if(receiver)server=await createWorkspaceApp({storage:app.workspaces.storage,customerAccess:{accounts:app.accounts,workspaces:app.workspaces},hostedTestPayments:{receive:receiver},deployment:{publicOrigin:'https://app.molyvi.com'}});
  if(holdStartup)server.photoReviewQueue.start=()=>holdStartup.promise;
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{holdStartup?.resolve();if(server!==app.server){await server.drainWorkers();if(server.listening)await new Promise(r=>server.close(r));}await app.stop();const real=await fs.realpath(storage);assert.equal(path.dirname(real),await fs.realpath(PRIVATE_ROOT));assert(path.basename(real).startsWith('_backup-resources-'));await fs.rm(real,{recursive:true});});
  const request=(route,{method='GET',body,host='app.molyvi.com'}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:host,...(body?{'Content-Type':'application/json'}:{})}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,retry:res.headers['retry-after']}));});
    req.on('error',reject);req.end(body);
  });
  return {app,server,request};
}
test('whole phase is health-only, nested snapshot works, outside calls cannot enter',async t=>{
  const f=await fixture(t),entered=deferred(),held=deferred();
  const p=f.app.withBackupResources(async()=>{
    assert.equal((await f.request('/healthz')).status,200);
    assert.equal((await f.request('/healthz',{method:'HEAD'})).status,200);
    assert.equal((await f.request('/healthz',{host:'foreign.invalid'})).status,403);
    for(const route of ['/customer/','/api/customer/me','/api/workspace','/customer-files/test/image.png'])assert.equal((await f.request(route)).status,503);
    assert.equal((await f.request('/api/customer/request-code',{method:'POST',body:'{invalid'})).status,503);
    await f.app.quietSnapshot(async()=>{assert.equal(f.server.resourceStatus().backupPaused,true);assert.equal((await f.request('/healthz')).status,200);});
    assert.equal(f.server.resourceStatus().backupPaused,false);assert.equal(f.server.resourceStatus().heavyPaused,true);
    entered.resolve();await held.promise;
  });
  await entered.promise;assert.throws(()=>f.app.withBackupResources(()=>{}),/BUSY/);
  await assert.rejects(f.app.quietSnapshot(()=>{}),/BUSY/);held.resolve();await p;
  assert.equal(f.app.resourceStatus().phase,'idle');assert.equal(f.server.resourceStatus().heavyPaused,false);assert.equal((await f.request('/customer/')).status,200);
});
test('active initial installer is allowed to complete without destructive pause',async t=>{
  let lifecycle='idle',inFlight=true,paused=0,resumed=0;const held=deferred();
  const worker={start(){lifecycle='running';},pause(){assert.equal(inFlight,false);paused++;lifecycle='paused';},resume(){resumed++;lifecycle='running';},async drain(){assert.equal(inFlight,false);},async stop(){await held.promise;lifecycle='stopped';},status:()=>({lifecycle,inFlight})};
  const f=await fixture(t,{worker});let entered=false;const p=f.app.withBackupResources(()=>{entered=true;});
  await delay(30);assert.equal(entered,false);assert.equal(paused,0);inFlight=false;held.resolve();await p;
  assert.equal(paused,1);assert.equal(resumed,1);
});
test('pre-paused installer is not resumed; shutdown during lease never restarts workers',async t=>{
  let lifecycle='idle',resumed=0;const worker={start(){lifecycle='running';},pause(){lifecycle='paused';},resume(){resumed++;lifecycle='running';},async drain(){},async stop(){lifecycle='stopped';},status:()=>({lifecycle,inFlight:false})};
  const f=await fixture(t,{worker});worker.pause();await f.app.withBackupResources(()=>{});assert.equal(resumed,0);assert.equal(lifecycle,'paused');
  worker.resume();const entered=deferred(),held=deferred();const p=f.app.withBackupResources(async()=>{entered.resolve();await held.promise;});await entered.promise;
  const before=resumed;let stopped=false;const s=f.app.stop().then(()=>stopped=true);await delay(20);assert.equal(stopped,false);
  held.resolve();await Promise.all([p,s]);assert.equal(resumed,before);assert.equal(lifecycle,'stopped');
});
test('queue startup is drained before heavy phase and health does not starve it',async t=>{
  const startup=deferred(),f=await fixture(t,{holdStartup:startup});let entered=false;
  const p=f.app.withBackupResources(()=>{entered=true;});
  for(let n=0;n<12;n++)assert.equal((await f.request('/healthz')).status,200);
  assert.equal(entered,false);assert.equal(f.server.resourceStatus().activeHandlers,0);startup.resolve();await p;assert(entered);
});
test('aborted response does not release a still-running handler from drain',async t=>{
  const entered=deferred(),held=deferred(),f=await fixture(t,{receiver:async()=>{entered.resolve();await held.promise;return {received:true};}});
  const req=http.request({host:'127.0.0.1',port:f.server.address().port,path:'/webhooks/shopify/orders-paid',method:'POST',headers:{Host:'app.molyvi.com','Content-Type':'application/json'}});
  req.on('error',()=>{});req.end('{}');await entered.promise;req.destroy();await delay(15);
  const lease=f.server.pauseHeavyResources();let drained=false;const p=lease.drain().then(()=>drained=true);
  await delay(20);assert.equal(drained,false);assert.equal(f.server.resourceStatus().activeHandlers,1);
  held.resolve();await p;assert.equal(f.server.resourceStatus().activeHandlers,0);lease.resume();
});
test('gallery waiting for a request slot is rejected before auth/body work after gate closes',async t=>{
  const held=deferred();let entered=0,authenticated=0;
  const f=await fixture(t,{receiver:async()=>{entered++;await held.promise;return {received:true};}});
  const original=f.app.accounts.authenticate.bind(f.app.accounts);f.app.accounts.authenticate=(...args)=>{authenticated++;return original(...args);};
  const occupied=Array.from({length:8},()=>f.request('/webhooks/shopify/orders-paid',{method:'POST',body:'{}'}));await until(()=>entered===8);
  const waiting=f.request('/customer-files/example/image.png');await until(()=>f.server.resourceStatus().activeHandlers===9);
  const lease=f.server.pauseHeavyResources(),drain=lease.drain();held.resolve();await Promise.all(occupied);
  assert.equal((await waiting).status,503);await drain;assert.equal(authenticated,0);lease.resume();
});
test('failed lifecycle resume keeps health-only admission closed',async t=>{
  let lifecycle='idle';const worker={start(){lifecycle='running';},pause(){lifecycle='paused';},resume(){throw Error('synthetic resume failure');},async drain(){},async stop(){lifecycle='stopped';},status:()=>({lifecycle,inFlight:false})};
  const f=await fixture(t,{worker});await assert.rejects(f.app.withBackupResources(()=>{}),/synthetic resume failure/);
  assert.equal(f.app.resourceStatus().phase,'blocked');assert.equal(f.server.resourceStatus().heavyPaused,true);
  assert.equal((await f.request('/healthz')).status,200);assert.equal((await f.request('/customer/')).status,503);
});
test('actual waiting pipeline remains paused under backup, including a pending timer and signal',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'molyvi-backup-pipeline-')),source=path.dirname(PRIVATE_ROOT),growth=path.join(temp,'molyvi-growth');
  let app;
  t.after(async()=>{await app?.stop();const actual=await fs.realpath(temp);assert.equal(path.dirname(actual),await fs.realpath(os.tmpdir()));assert(path.basename(actual).startsWith('molyvi-backup-pipeline-'));await fs.rm(actual,{recursive:true});});
  await fs.mkdir(growth);await fs.cp(path.join(source,'molyvi-growth','lib'),path.join(growth,'lib'),{recursive:true});
  await fs.cp(path.join(source,'molyvi-growth','operations'),path.join(growth,'operations'),{recursive:true});
  await fs.cp(path.join(source,'molyvi-contract'),path.join(temp,'molyvi-contract'),{recursive:true});
  for(const name of ['hosted-customer-server.mjs','paid-workspace-server.mjs'])await fs.copyFile(path.join(source,'molyvi-growth',name),path.join(growth,name));
  await fs.mkdir(path.join(growth,'public','workspace'),{recursive:true});
  const load=name=>import(pathToFileURL(path.join(growth,name)));
  const [{TaskStore},{createWorkspace},{createPaidOrder},{canonicalJson},{HOSTED_BASIC_PIPELINE_FILE},{createHostedCustomerServer:create}]=await Promise.all([
    load('lib/task-store.mjs'),load('lib/task-workspace.mjs'),load('lib/service-offer.mjs'),load('lib/intake-store.mjs'),load('lib/hosted-basic-pipeline.mjs'),load('hosted-customer-server.mjs')]);
  const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  const storage=path.join(temp,'briefs','molyvi-hosted-staging'),store=await new TaskStore(path.join(storage,'workspaces')).ready();
  const record=createWorkspace({ownerId:crypto.randomUUID(),order:createPaidOrder({id:'SYNTHETIC-BACKUP-PIPELINE'})});await store.create(record);
  const now=Date.now(),body={schemaVersion:1,kind:'molyvi_basic_pipeline_permit',serviceId:'srv-db7othjrjlhs73cg7lf0',targetStore:'molyvi-still-dev.myshopify.com',
    projectId:record.id,ownerId:record.ownerId,sourceHash:hash(record),jobId:crypto.randomUUID(),authorizationSha256:'a'.repeat(64),operatorId:'molyvi-full-basic-test-20261019',
    createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+4*60*60*1000).toISOString(),credentialReference:{runId:crypto.randomUUID(),packageSha256:'b'.repeat(64),receiverSha256:'c'.repeat(64)},publicationAuthorized:false,newChargesAuthorized:false};
  const permit={...body,permitHash:hash(body)};await fs.mkdir(path.dirname(HOSTED_BASIC_PIPELINE_FILE),{recursive:true});await fs.writeFile(HOSTED_BASIC_PIPELINE_FILE,JSON.stringify(permit),{flag:'wx'});
  app=await create({storage,publicOrigin:'https://app.molyvi.com',basicPipelinePermit:permit});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  await app.basicPipeline.drain();assert.equal(app.basicPipeline.status().worker.lifecycle,'waiting');
  await app.withBackupResources(async()=>{
    assert.equal(app.basicPipeline.status().worker.paused,true);app.basicPipeline.signal();
    await delay(5100);assert.equal(app.basicPipeline.status().worker.lifecycle,'paused');assert.equal(app.basicPipeline.status().code,null);
  });
  assert.equal(app.basicPipeline.status().worker.lifecycle,'waiting');assert.equal(app.basicPipeline.status().worker.paused,false);
  app.basicPipeline.pause();await app.withBackupResources(()=>{});assert.equal(app.basicPipeline.status().worker.paused,true);
});
