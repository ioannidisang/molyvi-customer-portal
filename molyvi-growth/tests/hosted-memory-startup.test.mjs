import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createHostedCustomerServer,createHostedStartupLifecycle} from '../hosted-customer-server.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(options={}){
  const calls=[],errors=[];
  const app={startBackground(){calls.push('background');},stop(){calls.push('app-stop');return options.appStop?.();}};
  const backups={start(){calls.push('backups-start');},stop(){calls.push('backups-stop');return options.backupStop?.();}};
  const lifecycle=createHostedStartupLifecycle({app,backups,probeConfig:options.absent?null:Object.freeze({testOnly:true}),
    runProbe:options.runProbe??(()=>({status:'PASS',allowAutomaticStart:true})),onBlocked:code=>errors.push(code)});
  return {calls,errors,app,backups,lifecycle};
}

test('absent permit keeps legacy scheduler startup and never invokes the probe',async()=>{
  const f=fixture({absent:true,runProbe(){assert.fail('probe must not run');}});
  assert.equal((await f.lifecycle.start()).phase,'running');
  assert.deepEqual(f.calls,['backups-start']);
  await f.lifecycle.start();assert.deepEqual(f.calls,['backups-start']);
  await f.lifecycle.stop();
});
test('probe requests lease synchronously and defers background/scheduler until verified settlement',async()=>{
  const done=deferred();let entered=false;
  const f=fixture({runProbe(){entered=true;return done.promise;}});
  const result=f.lifecycle.start();assert.equal(entered,true);assert.deepEqual(f.calls,[]);
  done.resolve({status:'PASS',allowAutomaticStart:true});
  assert.equal((await result).phase,'running');assert.deepEqual(f.calls,['background','backups-start']);
  await f.lifecycle.start();assert.equal(f.calls.length,2);await f.lifecycle.stop();
});
test('verified consumed success may resume ordinary startup without a second attempt',async()=>{
  let calls=0;const f=fixture({runProbe(){calls++;return {status:'SKIP_VERIFIED_PASS',allowAutomaticStart:true};}});
  await f.lifecycle.start();await f.lifecycle.start();
  assert.equal(calls,1);assert.deepEqual(f.calls,['background','backups-start']);await f.lifecycle.stop();
});
for(const receipt of [
  {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:false},
  {status:'SKIP_CONSUMED_UNVERIFIED',allowAutomaticStart:true},
  {status:'PASS',allowAutomaticStart:false},
  {status:'PASS'},
  null
])test(`unverified or conflicting receipt stays blocked: ${JSON.stringify(receipt)}`,async()=>{
  const f=fixture({runProbe:()=>receipt});
  assert.equal((await f.lifecycle.start()).phase,'blocked');assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.errors,['HOSTED_MEMORY_PROBE_NOT_VERIFIED']);await f.lifecycle.stop();
});
test('synchronous probe validation failure is blocked, not treated as absent',async()=>{
  const f=fixture({runProbe(){throw Error('PROBE_PERMIT_INVALID');}});
  assert.equal((await f.lifecycle.start()).phase,'blocked');assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.errors,['PROBE_PERMIT_INVALID']);await f.lifecycle.stop();
});
test('rejected probe preserves diagnostic blocked status without schedule or background start',async()=>{
  const done=deferred();const f=fixture({runProbe:()=>done.promise});
  const started=f.lifecycle.start();done.reject(Error('PROBE_SOURCE_CHANGED'));
  assert.equal((await started).phase,'blocked');assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.errors,['PROBE_SOURCE_CHANGED']);await f.lifecycle.stop();
});
test('stop before listening prevents any probe or scheduler start',async()=>{
  let count=0;const f=fixture({runProbe(){count++;return {status:'PASS',allowAutomaticStart:true};}});
  await f.lifecycle.stop();await f.lifecycle.start();
  assert.equal(count,0);assert.deepEqual(f.calls,['app-stop','backups-stop']);
});
for(const stage of ['after-claim-before-body','during-body','during-finally'])test(`stop ${stage} closes admission synchronously and waits actual probe`,async()=>{
  const claimGate=deferred(),bodyGate=deferred(),finallyGate=deferred(),bodyEntered=deferred(),finallyEntered=deferred(),appDone=deferred();let settled=false;
  const f=fixture({async runProbe(){
    await claimGate.promise;bodyEntered.resolve();
    try{await bodyGate.promise;return {status:'PASS',allowAutomaticStart:true};}
    finally{finallyEntered.resolve();await finallyGate.promise;}
  },appStop:()=>appDone.promise});
  const started=f.lifecycle.start();
  if(stage!=='after-claim-before-body'){claimGate.resolve();await bodyEntered.promise;}
  if(stage==='during-finally'){bodyGate.resolve();await finallyEntered.promise;}
  const stopped=f.lifecycle.stop().then(()=>{settled=true;});
  assert.equal(f.lifecycle.status().stopping,true);
  assert.deepEqual(f.calls,['app-stop','backups-stop']);
  await Promise.resolve();assert.equal(settled,false);
  claimGate.resolve();bodyGate.resolve();finallyGate.resolve();await started;
  assert.deepEqual(f.calls,['app-stop','backups-stop']);assert.equal(settled,false);
  appDone.resolve();await stopped;assert.equal(f.lifecycle.status().phase,'stopped');
  await f.lifecycle.stop();assert.deepEqual(f.calls,['app-stop','backups-stop']);
});
test('background start failure never starts scheduled backup',async()=>{
  const f=fixture();f.app.startBackground=()=>{throw Error('BACKGROUND_START_FAILED');};
  assert.equal((await f.lifecycle.start()).phase,'blocked');
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.errors,['BACKGROUND_START_FAILED']);await f.lifecycle.stop();
});
test('shutdown still invokes both stop methods when one throws',async()=>{
  const f=fixture({appStop(){throw Error('STOP_FAILED');}});
  await assert.rejects(f.lifecycle.stop(),/STOP_FAILED/);
  assert.deepEqual(f.calls,['app-stop','backups-stop']);assert.equal(f.lifecycle.status().stopping,true);
});
for(const succeeds of [true,false])test(`actual hosted listening defers background through resident lease (${succeeds?'success':'failure'})`,{timeout:10000},async t=>{
  const storage=path.join(PRIVATE_ROOT,'_hosted-probe-startup-'+crypto.randomUUID());
  let workerStarts=0,backupStarts=0,workerLifecycle='idle',lifecycle,passed=false;
  const worker={start(){workerStarts++;workerLifecycle='running';},pause(){workerLifecycle='paused';},
    resume(){workerLifecycle='running';},async drain(){},async stop(){workerLifecycle='stopped';},
    status:()=>({lifecycle:workerLifecycle,inFlight:false,phase:'verified'})};
  const entered=deferred(),held=deferred();
  const app=await createHostedCustomerServer({storage,publicOrigin:'https://app.molyvi.com',basicInstaller:worker,deferBackgroundStart:true});
  t.after(async()=>{
    held.resolve();
    await (lifecycle?lifecycle.stop():app.stop());
    if(passed){const actual=await fs.realpath(storage);assert.equal(path.dirname(actual),await fs.realpath(PRIVATE_ROOT));assert(path.basename(actual).startsWith('_hosted-probe-startup-'));await fs.rm(actual,{recursive:true});}
  });
  lifecycle=createHostedStartupLifecycle({app,backups:{start(){backupStarts++;},async stop(){}},probeConfig:{testOnly:true},
    runProbe:({app:resident})=>resident.withBackupResources(async()=>{
      assert.equal(workerStarts,0);assert.equal(app.server.resourceStatus().startupSettled,true);
      assert.equal(app.resourceStatus().phase,'backup');entered.resolve();await held.promise;
      if(!succeeds)throw Error('PROBE_TEST_FAILURE');
      return {status:'PASS',allowAutomaticStart:true};
    })});
  let startup;
  app.server.prependOnceListener('listening',()=>{startup=lifecycle.start();});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  await entered.promise;assert.equal(workerStarts,0);assert.equal(backupStarts,0);
  held.resolve();await startup;
  assert.equal(workerStarts,succeeds?1:0);assert.equal(backupStarts,succeeds?1:0);
  assert.equal(app.resourceStatus().phase,'idle');passed=true;
});
