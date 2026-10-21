import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
  const storage=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_preparation-lease-'));
  const app=await createHostedCustomerServer({storage,publicOrigin:'https://app.molyvi.com'});
  t.after(()=>app.stop());return app;
}
test('trusted preparation requires a listening app and callback, releases after failure',async t=>{
  const app=await fixture(t);
  await assert.rejects(app.withPreparationResources(()=>{}),/NOT_LISTENING/);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  await assert.rejects(app.withPreparationResources(null),/CALLBACK_REQUIRED/);
  const original=Error('synthetic preparation failure');
  await assert.rejects(app.withPreparationResources(()=>{assert(app.resourceStatus().productionActive);throw original;}),e=>e===original);
  assert.equal(app.resourceStatus().productionActive,false);assert.equal(app.server.resourceStatus().preparationPaused,false);
  assert.equal(await app.withPreparationResources(()=>42),42);
});
test('backup waits for the entire preparation callback and competing work stays closed',async t=>{
  const app=await fixture(t);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const entered=deferred(),held=deferred();let preparationDone=false,backupEntered=false;
  const p=app.withPreparationResources(async()=>{entered.resolve();await held.promise;preparationDone=true;});
  await entered.promise;await assert.rejects(app.withPreparationResources(()=>{}),/BUSY/);
  const b=app.withBackupResources(async()=>{backupEntered=true;assert(preparationDone);assert.equal(app.resourceStatus().productionActive,false);await assert.rejects(app.withPreparationResources(()=>{}),/BUSY/);});
  await delay(30);assert.equal(backupEntered,false);held.resolve();await Promise.all([p,b]);
  assert(backupEntered);assert.equal(app.resourceStatus().phase,'idle');
});
test('shutdown waits active preparation and never reopens admission',async t=>{
  const app=await fixture(t);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const entered=deferred(),held=deferred();let stopped=false;
  const p=app.withPreparationResources(async()=>{entered.resolve();await held.promise;});await entered.promise;
  const closing=app.stop().then(()=>stopped=true);await delay(30);assert.equal(stopped,false);
  held.resolve();await Promise.all([p,closing]);assert(stopped);
  await assert.rejects(app.withPreparationResources(()=>{}),/NOT_LISTENING/);
});
test('private operator cannot compete with a configured installer lifecycle',async t=>{
  const storage=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_preparation-lease-'));
  let lifecycle='idle',entered=false;
  const worker={start(){lifecycle='running';},pause(){lifecycle='paused';},resume(){lifecycle='running';},async drain(){},async stop(){lifecycle='stopped';},status:()=>({lifecycle,inFlight:false})};
  const app=await createHostedCustomerServer({storage,publicOrigin:'https://app.molyvi.com',basicInstaller:worker});t.after(()=>app.stop());
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  await assert.rejects(app.withPreparationResources(()=>{entered=true;}),/OPERATION_EXCLUSIVE/);
  assert.equal(entered,false);assert.equal(app.resourceStatus().productionActive,false);assert.equal(lifecycle,'running');
});
