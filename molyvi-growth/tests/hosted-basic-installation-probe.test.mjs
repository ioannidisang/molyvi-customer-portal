import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {validateBasicInstallProbePermit,allowsHostedBasicInstallReferenceProbe,withHostedBasicInstallReferenceScope,BASIC_INSTALL_PROBE_SERVICE,BASIC_INSTALL_PROBE_WORKSPACE} from '../lib/basic-reference-install-probe-scope.mjs';
import {inspectBasicInstallProbeCapacity,runHostedBasicInstallationProbe,loadHostedBasicInstallationProbe,verifyBasicInstallProbeCompletion} from '../operations/hosted-basic-installation-probe.mjs';
import {createBasicPreparationService} from '../lib/basic-preparation.mjs';
import {TaskStore} from '../lib/task-store.mjs';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
const now=Date.now(),release='1'.repeat(40);
function permit(){return {schemaVersion:1,kind:'molyvi_basic_install_resident_once_v1',serviceId:BASIC_INSTALL_PROBE_SERVICE,workspaceId:BASIC_INSTALL_PROBE_WORKSPACE,release,runId:'install-20261021140000-1234abcd',expiresAt:now+3600000,fixtureSha256:'a'.repeat(64),donors:Array.from({length:30},(_,i)=>({file:'/opt/render/project/src/briefs/molyvi-hosted-staging/workspaces/4923cd43-11b7-47ed-a912-1b06458a6557/generated-c3db46a5-bf6b-4ff8-8275-008e5d32a964.bin',sha256:i.toString(16).padStart(64,'0'),bytes:100+i})),controls:['molyvi-r2-access/automatic.json','molyvi-r2-access/budget.sqlite','molyvi-r2-access/r2-config.json','molyvi-r2-access/retention.json','molyvi-r2-access/generation-format.json','molyvi-r2-automatic/retention.sqlite','molyvi-r2-automatic/schedule.sqlite','molyvi-r2-automatic/generations.sqlite','molyvi-r2-automatic/generations.sqlite.initialized.json'].map(file=>({file,sha256:'b'.repeat(64)}))};}
test('permit binds service, workspace, exact release, donor path, controls and expiry',()=>{
  const options={release,serviceId:BASIC_INSTALL_PROBE_SERVICE,now};assert.equal(validateBasicInstallProbePermit(permit(),options).release,release);
  for(const change of [p=>p.serviceId='other',p=>p.workspaceId='other',p=>p.release='2'.repeat(40),p=>p.expiresAt=now-1,p=>p.expiresAt=now+25*3600*1000,p=>p.extra=true,p=>p.donors[0].file='/etc/passwd',p=>p.donors[0].sha256=p.donors[1].sha256,p=>p.controls.pop(),p=>p.controls[0].file='other']){
    const p=permit();change(p);assert.throws(()=>validateBasicInstallProbePermit(p,options));
  }
});
test('capacity charges entire isolated scratch against original source cap',()=>{
  const a=inspectBasicInstallProbeCapacity({sourceBytes:368309689,freeBytes:7_900_000_000});assert.equal(a.projectedBytes,485750201);
  assert.throws(()=>inspectBasicInstallProbeCapacity({sourceBytes:400_000_000,freeBytes:7_900_000_000}),/SOURCE_CAPACITY/);
  assert.throws(()=>inspectBasicInstallProbeCapacity({sourceBytes:1,freeBytes:1024}),/DISK_CAPACITY/);
  assert.throws(()=>inspectBasicInstallProbeCapacity({sourceBytes:1,freeBytes:2**31,scratchBytes:105_000_000}),/SOURCE_CAPACITY/);
});
test('no authority can be supplied as JSON or unverified config',async()=>{
  assert.equal(allowsHostedBasicInstallReferenceProbe({store:{},storage:'x',buildRoot:'y'}),false);
  assert.throws(()=>runHostedBasicInstallationProbe({app:{withStartupPreparationResources(){throw Error('must not enter');}},config:{}}),/GENUINE_CONFIG/);
  await assert.rejects(withHostedBasicInstallReferenceScope({permitHash:'a'.repeat(64),store:{storage:'x'},storage:'x',buildRoot:'y'},()=>{}));
  assert.equal(await loadHostedBasicInstallationProbe({permitFile:path.join(PRIVATE_ROOT,'absent-basic-permit.json')}),null);
});
test('completed run requires exact receipt and report binding',()=>{
  const value={permitHash:'a',release,runId:'b',attempt:{hash:'c'},complete:{permitHash:'a',attemptHash:'c',reportHash:'d'},report:{hash:'d',value:{status:'PASS',permitHash:'a',release,runId:'b',sourceUnchanged:true}}};
  assert(verifyBasicInstallProbeCompletion(value));
  for(const change of [x=>x.complete.reportHash='wrong',x=>x.report.value.release='wrong',x=>x.report.value.sourceUnchanged=false,x=>x.report.value.status='FAIL',x=>x.complete.attemptHash='wrong']){const x=structuredClone(value);change(x);assert.throws(()=>verifyBasicInstallProbeCompletion(x),/COMPLETION_INVALID/);}
});
test('normal hosted reference requests remain forbidden',async()=>{
  const old=process.env.RENDER_SERVICE_ID;process.env.RENDER_SERVICE_ID=BASIC_INSTALL_PROBE_SERVICE;
  try{await assert.rejects(createBasicPreparationService({store:new TaskStore(PRIVATE_ROOT+'/fake-workspaces'),storage:PRIVATE_ROOT+'/fake-receipts',buildRoot:PRIVATE_ROOT+'/fake-builds',buildEnabled:true,referenceComposition:true,decodeImage:async()=>{}}),/REFERENCE_HOSTED_NOT_ENABLED/);}
  finally{if(old===undefined)delete process.env.RENDER_SERVICE_ID;else process.env.RENDER_SERVICE_ID=old;}
});
async function appFor(t,options={}){
  await fs.mkdir(PRIVATE_ROOT,{recursive:true});const storage=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_startup-basic-'));
  const app=await createHostedCustomerServer({storage,publicOrigin:'https://app.molyvi.com',...options});t.after(()=>app.stop());await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return app;
}
test('startup preparation is unavailable to normally running app or after resume',async t=>{
  const normal=await appFor(t);await assert.rejects(normal.withStartupPreparationResources(()=>{}),/EXCLUSIVE/);
  const app=await appFor(t,{deferBackgroundStart:true});assert.equal(await app.withStartupPreparationResources(()=>17),17);
  app.startBackground();await assert.rejects(app.withStartupPreparationResources(()=>{}),/EXCLUSIVE/);
});
test('startup preparation holds production and waits through shutdown',async t=>{
  const app=await appFor(t,{deferBackgroundStart:true});let release,enter;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);let done=false;
  const pending=app.withStartupPreparationResources(async()=>{assert.equal(app.resourceStatus().productionActive,true);enter();await held;});await entered;
  await assert.rejects(app.withStartupPreparationResources(()=>{}),/BUSY/);
  const stop=app.stop().then(()=>done=true);await new Promise(r=>setTimeout(r,30));assert.equal(done,false);release();await Promise.all([pending,stop]);assert(done);
});
test('only a settled installer may coexist before background start',async t=>{
  let phase='pending',started=0;
  const installer={start(){started++;},pause(){},resume(){},async stop(){},async drain(){},status:()=>({phase,lifecycle:'idle',inFlight:false})};
  const app=await appFor(t,{deferBackgroundStart:true,basicInstaller:installer});await assert.rejects(app.withStartupPreparationResources(()=>{}),/INSTALLER_UNSETTLED/);
  phase='verified';assert.equal(await app.withStartupPreparationResources(()=>23),23);assert.equal(started,0);app.startBackground();assert.equal(started,1);
});
