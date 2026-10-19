import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {canonicalJson} from '../lib/intake-store.mjs';
import {createBasicPreparationWorker} from '../lib/basic-preparation-worker.mjs';
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
function fixture(t,overrides={}){
  const session={projectId:crypto.randomUUID(),ownerId:crypto.randomUUID()},requestId=crypto.randomUUID(),sourceHash='a'.repeat(64),item={session,requestId,sourceHash};
  const calls=[];let leaseHeld=false;
  const receipt=state=>({projectId:session.projectId,sourceHash,readiness:{ready:true},request:{requestId,sourceHash,state,outputVerifiedNow:state==='prepared_for_installation_review'}});
  const config={enabled:true,permit:{projectId:session.projectId,ownerHash:hash(session.ownerId)},listPending:async()=>{calls.push('list');return [item];},acquireLease:async()=>{calls.push('lease');leaseHeld=true;return async()=>{calls.push('release');leaseHeld=false;};},preparationService:{status:async()=>{assert(leaseHeld);calls.push('status');return receipt('requested');},prepare:async()=>{assert(leaseHeld);calls.push('prepare');return receipt('prepared_for_installation_review');}},onPrepared:async value=>{assert(leaseHeld);assert.deepEqual(value.session,session);assert.equal(value.requestId,requestId);calls.push('handoff');return {status:'verified'};},...overrides};
  const worker=createBasicPreparationWorker(config);t.after(()=>worker.stop());return {worker,config,session,item,receipt,calls,isLeased:()=>leaseHeld};
}
test('serial one-job worker leases preparation through verified handoff and never replays completed job',async t=>{
  const f=fixture(t);await Promise.all([f.worker.runOnce(),f.worker.runOnce()]);
  assert.deepEqual(f.calls,['list','lease','status','prepare','handoff','release']);assert.equal(f.worker.status().lifecycle,'completed');assert.equal(f.isLeased(),false);
  await f.worker.runOnce();f.worker.start();f.worker.resume();assert.equal(f.calls.length,6);assert(!JSON.stringify(f.worker.status()).includes(f.session.ownerId));
});
test('pause/drain and stop wait through handoff before releasing lease',async t=>{
  const entered=deferred(),finish=deferred(),f=fixture(t,{onPrepared:async()=>{entered.resolve();await finish.promise;return {status:'verified'};}});
  const running=f.worker.runOnce();await entered.promise;f.worker.pause();let drained=false;const draining=f.worker.drain().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);assert.equal(f.isLeased(),true);assert.equal(f.worker.status().phase,'handoff');finish.resolve();await Promise.all([running,draining]);assert.equal(f.isLeased(),false);assert.equal(drained,true);
});
test('pause while acquiring lease prevents a new preparation and releases lease',async t=>{
  const entered=deferred(),resume=deferred();let released=0,prepared=0;
  const f=fixture(t,{acquireLease:async()=>{entered.resolve();await resume.promise;return ()=>{released++;};},preparationService:{status:()=>{prepared++;},prepare:()=>{prepared++;}}});
  const running=f.worker.runOnce();await entered.promise;f.worker.pause();resume.resolve();await running;assert.equal(prepared,0);assert.equal(released,1);assert.equal(f.worker.status().lifecycle,'paused');
});
test('partial, failed and source-changed attempts stop without preparing or handoff',async t=>{
  for(const state of ['preparation_unknown','preparation_failed','source_changed']){
    const f=fixture(t);f.config.preparationService.status=async()=>f.receipt(state);await f.worker.runOnce();assert.equal(f.worker.status().lifecycle,'stopped_for_review');assert(!f.calls.includes('prepare'));assert(!f.calls.includes('handoff'));assert.equal(f.isLeased(),false);
  }
});
test('restart with saved prepared receipt verifies output again before trusted idempotent handoff',async t=>{
  const f=fixture(t);f.config.preparationService.status=async()=>f.receipt('prepared_for_installation_review');f.config.onPrepared=async()=>({status:'already_verified'});
  // Factory captures callbacks; use a new worker as an actual restart does.
  const restarted=createBasicPreparationWorker(f.config);t.after(()=>restarted.stop());await restarted.runOnce();assert.equal(restarted.status().lifecycle,'completed');assert(f.calls.includes('prepare'));assert.equal(f.calls.filter(x=>x==='prepare').length,1);
});
test('unknown handoff failure is terminal, releases lease and never polls/retries',async t=>{
  let calls=0;const f=fixture(t,{onPrepared:async()=>{calls++;throw new Error('private token/URL must not escape');}});await f.worker.runOnce();await f.worker.runOnce();f.worker.start();f.worker.resume();
  assert.equal(calls,1);assert.equal(f.isLeased(),false);assert.equal(f.worker.status().lifecycle,'stopped_for_review');assert.equal(f.worker.status().lastCode,'BASIC_PREPARATION_WORKER_STOPPED');assert(!JSON.stringify(f.worker.status()).includes('private'));
});
test('unverified handoff and lease-release failure both stop instead of claiming complete',async t=>{
  const f=fixture(t,{onPrepared:async()=>({status:'pending'})});await f.worker.runOnce();assert.equal(f.worker.status().lastCode,'BASIC_PREPARATION_WORKER_HANDOFF_NOT_VERIFIED');
  const g=fixture(t,{acquireLease:async()=>async()=>{throw new Error('failed');},preparationService:{status:async()=>g.receipt('requested'),prepare:async()=>g.receipt('prepared_for_installation_review')},onPrepared:async()=>({status:'verified'})});await g.worker.runOnce();assert.equal(g.worker.status().lastCode,'BASIC_PREPARATION_WORKER_LEASE_RELEASE_FAILED');
});
test('wrong owner, arbitrary descriptor fields or multiple projects never acquire lease',async t=>{
  for(const transform of [item=>[{...item,session:{...item.session,ownerId:crypto.randomUUID()}}],item=>[{...item,session:{...item.session,projectId:crypto.randomUUID()}}],item=>[{...item,output:'/arbitrary'}],item=>[item,item]]){
    let item;const f=fixture(t,{listPending:async()=>transform(item)});item=f.item;await f.worker.runOnce();assert.equal(f.worker.status().lifecycle,'stopped_for_review');assert(!f.calls.includes('lease'));
  }
});
test('disabled worker does no work and enabled configuration requires a fixed permit and lease',async()=>{
  const worker=createBasicPreparationWorker();worker.start();await worker.runOnce();assert.equal(worker.status().lifecycle,'disabled');await worker.stop();
  assert.throws(()=>createBasicPreparationWorker({enabled:true}),{code:'BASIC_PREPARATION_WORKER_CONFIG_INVALID'});assert.throws(()=>createBasicPreparationWorker({pollMs:0}),{code:'BASIC_PREPARATION_WORKER_CONFIG_INVALID'});
});
