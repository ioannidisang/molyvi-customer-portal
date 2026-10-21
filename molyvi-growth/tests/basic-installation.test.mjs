import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {canonicalJson,PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {buildBasicThemePackage} from '../lib/basic-theme-package.mjs';
import {createBasicInstallation,readBasicInstallation,claimBasicInstallationStep,recordBasicInstallationReceipt,reconcileBasicInstallationStep,blockBasicInstallationStep,getBasicVisibilityScope,claimBasicVisibilityReview,recordBasicRestoration,renameBasicInstallationCheckpoint} from '../lib/basic-installation.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>sha(canonicalJson(value));
const ev={operatorId:'synthetic-operator',observedAt:'2026-10-18T12:00:00.000Z',evidenceSha256:'b'.repeat(64),scopeConfirmed:true};
let root,prepared,theme,context,grant;
test.before(async()=>{
  root=await fs.mkdtemp(path.join(PRIVATE_ROOT,'_basic-installation-tests-'));
  const fixture=createBasicAssemblyFixture({productCount:1,sizeProductCount:1}),binding=createBasicAssemblyBinding(fixture.record,fixture.options);
  prepared=prepareBasicStorePackage(fixture.record,{...fixture.options,binding});
  const built=await buildBasicThemePackage(prepared,{outputDirectory:path.join(root,'theme')});
  theme={manifest:built.manifest,zipBytes:await fs.readFile(built.zipPath)};
  context={projectId:prepared.plan.projectId,ownerId:fixture.record.ownerId,targetStore:prepared.plan.targetStore,planHash:prepared.plan.planHash,themeZipSha256:built.zipSha256};
  grant={projectId:context.projectId,ownerHash:binding.ownerHash,targetStore:context.targetStore,planHash:context.planHash,createOnly:true,publicationAuthorized:false,newChargesAuthorized:false,referenceSha256:'a'.repeat(64)};
});
test.after(async()=>{if(root){const actual=await fs.realpath(root);assert.equal(path.dirname(actual),await fs.realpath(PRIVATE_ROOT));await fs.rm(actual,{recursive:true});}});
async function create(extra={}){
  const registryDirectory=extra.registryDirectory??path.join(root,crypto.randomUUID());if(!extra.registryDirectory)await fs.mkdir(registryDirectory);
  const directory=path.join(root,crypto.randomUUID()),options={directory,registryDirectory,prepared,theme,context,authorization:grant,preflightEvidence:ev,liveThemeId:'1',inventoryLocationId:'7',currency:'EUR',preexistingResources:[{kind:'catalog',remoteId:'9'}],...extra};
  const state=await createBasicInstallation(options);return {directory,registryDirectory,context,...extra,state};
}
function receipt(state,step,id){
  const e=step.expected;let observed;
  if(step.kind==='catalog')observed={...e,variants:e.variants.map((v,i)=>({...v,remoteId:String(Number(id)*10+i)}))};
  else if(step.kind==='media')observed={parentRemoteId:state.steps[e.parentKey].receipt.remoteId,position:e.position,sourceSha256:e.sourceSha256,alt:e.alt,loaded:true};
  else if(step.kind==='variant_media'){
    const parent=state.steps[e.parentKey].receipt;id=parent.remoteId;
    observed={parentRemoteId:parent.remoteId,associations:e.associations.map(a=>({variantRemoteId:parent.observed.variants.find(v=>v.localId===a.localId).remoteId,mediaRemoteId:state.steps[a.mediaKey].receipt.remoteId}))};
  }
  else if(step.kind==='collection')observed={title:e.title,handle:e.handle,productRemoteIds:e.productKeys.map(k=>state.steps[k].receipt.remoteId),channels:[]};
  else if(step.kind==='page')observed=e;
  else observed={...e,liveThemeIdUnchanged:state.intent.liveThemeId};
  return {remoteId:String(id),payloadHash:step.payloadHash,observed,evidence:ev};
}
async function finish(options){
  let state=await readBasicInstallation(options);let id=100;
  for(const step of state.intent.steps){
    state=await claimBasicInstallationStep({...options,key:step.key});
    state=await recordBasicInstallationReceipt({...options,key:step.key,attemptId:state.steps[step.key].attemptId,receipt:receipt(state,step,id++)});
  }
  return state;
}
function restored(scope){return {products:scope.products.map(remoteId=>({remoteId,status:'DRAFT',channels:[]})),collection:{remoteId:scope.collection,channels:[]},pages:scope.pages.map(remoteId=>({remoteId,visibility:'Hidden'})),theme:{remoteId:scope.theme,status:'Draft'},liveThemeId:scope.liveThemeId};}
const rejects=(promise,code)=>assert.rejects(promise,{code:`BASIC_INSTALL_${code}`});

test('new local intent freezes exact Basic, owner, target, ZIP and create-only scope without storing credentials or owner ID',async()=>{
  const run=await create(),state=run.state;
  assert.equal(state.intent.steps.length,14);assert.equal(state.intent.networkEnabled,false);assert.equal(state.intent.publicationAuthorized,false);assert.equal(state.intent.newChargesAuthorized,false);assert.equal(state.intent.overwriteExisting,false);
  assert.equal(state.intent.planHash,prepared.plan.planHash);assert.equal(state.intent.themeZipSha256,sha(theme.zipBytes));
  assert.equal(state.remoteVerification,'operator_attested_not_independent_remote_verification');
  assert(!JSON.stringify(state.intent).includes(context.ownerId));
  assert.equal(state.steps['theme'].status,'pending');assert.equal(state.visibility.status,'not_started');
  assert.deepEqual((await fs.readdir(run.directory)).sort(),['head.json','intent.json']);
  await rejects(create({directory:run.directory,registryDirectory:run.registryDirectory}),'INSTALLATION_ALREADY_RESERVED');
});

test('same store and project cannot reserve a second journal in the same configured registry',async()=>{
  const run=await create();await rejects(create({registryDirectory:run.registryDirectory}),'INSTALLATION_ALREADY_RESERVED');
  const copied=path.join(root,crypto.randomUUID());await fs.cp(run.directory,copied,{recursive:true});
  await rejects(readBasicInstallation({...run,directory:copied}),'REGISTRY_MISMATCH');
});

test('owner, project, shop, source plan and ZIP mismatches fail before any claim',async()=>{
  const run=await create();
  for(const changed of [{ownerId:crypto.randomUUID()},{projectId:crypto.randomUUID()},{targetStore:'another.myshopify.com'},{planHash:'f'.repeat(64)},{themeZipSha256:'f'.repeat(64)}]){
    await rejects(claimBasicInstallationStep({...run,context:{...context,...changed},key:run.state.intent.steps[0].key}),'CONTEXT_MISMATCH');
  }
  assert.equal((await readBasicInstallation(run)).eventCount,0);
});

test('tampered bytes, theme binding and missing explicit create-only authorization reject initialization',async()=>{
  const badPrepared={plan:prepared.plan,uploads:prepared.uploads.map(x=>({...x,bytes:Buffer.from(x.bytes)}))};badPrepared.uploads[0].bytes[0]^=1;
  await assert.rejects(create({prepared:badPrepared}),{code:'BASIC_PACKAGE_UPLOADS_CHANGED'});
  await rejects(create({theme:{...theme,zipBytes:Buffer.from('wrong')}}),'THEME_MISMATCH');
  await rejects(create({theme:{...theme,manifest:{...theme.manifest,targetStore:'other.myshopify.com'}}}),'THEME_MISMATCH');
  await rejects(create({currency:'USD'}),'CORRUPT_INTENT');
  await rejects(create({inventoryLocationId:null}),'CORRUPT_INTENT');
  for(const changed of [{publicationAuthorized:true},{newChargesAuthorized:true},{createOnly:false},{planHash:'0'.repeat(64)}])await rejects(create({authorization:{...grant,...changed}}),'AUTHORIZATION_SCOPE_MISMATCH');
});

test('dependencies block media, collection and theme until successful exact parents; arbitrary steps are rejected',async()=>{
  const run=await create();
  for(const key of [run.state.intent.steps[1].key,'collection','theme'])await rejects(claimBasicInstallationStep({...run,key}),'INVALID_TRANSITION');
  await rejects(claimBasicInstallationStep({...run,key:'publish'}),'UNKNOWN_STEP');
  await rejects(recordBasicInstallationReceipt({...run,key:'collection',attemptId:crypto.randomUUID(),receipt:{}}),'INVALID_TRANSITION');
  await rejects(getBasicVisibilityScope(run),'INSTALLATION_INCOMPLETE');
  assert.equal((await readBasicInstallation(run)).eventCount,0);
});

test('one claim persists across reopen; receipt and successful claim replay are idempotent and changed IDs fail',async()=>{
  const run=await create(),step=run.state.intent.steps[0],claimed=await claimBasicInstallationStep({...run,key:step.key}),attemptId=claimed.steps[step.key].attemptId;
  const reopened=await readBasicInstallation(run);assert.equal(reopened.installationStatus,'outcome_unknown');
  assert.equal(reopened.steps[step.key].attemptId,attemptId);
  await rejects(claimBasicInstallationStep({...run,key:step.key}),'RECONCILIATION_REQUIRED');
  const r=receipt(claimed,step,100),written=await recordBasicInstallationReceipt({...run,key:step.key,attemptId,receipt:r});
  assert.equal(written.eventCount,2);assert.equal(written.steps[step.key].status,'succeeded');
  assert.equal((await recordBasicInstallationReceipt({...run,key:step.key,attemptId,receipt:r})).duplicate,true);
  assert.equal((await claimBasicInstallationStep({...run,key:step.key})).duplicate,true);
  await rejects(recordBasicInstallationReceipt({...run,key:step.key,attemptId,receipt:{...r,remoteId:'200'}}),'RECEIPT_REPLAY_MISMATCH');
  assert.equal((await readBasicInstallation(run)).eventCount,2);
});

test('unknown outcomes require explicit reconciliation; confirmed absence is terminal and never resets attempt',async()=>{
  const run=await create(),step=run.state.intent.steps[0],claimed=await claimBasicInstallationStep({...run,key:step.key}),attemptId=claimed.steps[step.key].attemptId,r=receipt(claimed,step,100);
  await rejects(reconcileBasicInstallationStep({...run,key:step.key,attemptId,receipt:r}),'OPERATOR_EVIDENCE_REQUIRED');
  const done=await reconcileBasicInstallationStep({...run,key:step.key,attemptId,receipt:r,reconciliationEvidence:ev});assert.equal(done.steps[step.key].reconciled,true);
  const second=await create(),key=second.state.intent.steps[0].key,c=await claimBasicInstallationStep({...second,key});
  const blocked=await blockBasicInstallationStep({...second,key,attemptId:c.steps[key].attemptId,reason:'confirmed_absent',evidence:ev});
  assert.equal(blocked.installationStatus,'blocked');await rejects(claimBasicInstallationStep({...second,key}),'RECONCILIATION_REQUIRED');
});

test('parallel independent process claims serialize with exactly one successful attempt',async()=>{
  const run=await create(),key=run.state.intent.steps[0].key;
  const script=`import {claimBasicInstallationStep} from './molyvi-growth/lib/basic-installation.mjs';try{await claimBasicInstallationStep(JSON.parse(process.argv[1]));process.stdout.write('OK');}catch(e){process.stdout.write(e.code);}`;
  const child=()=>new Promise((resolve,reject)=>{let out='';const p=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify({directory:run.directory,context,key})],{cwd:path.resolve(PRIVATE_ROOT,'..'),windowsHide:true});p.stdout.on('data',b=>out+=b);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(new Error(out)));});
  const outcomes=await Promise.all([child(),child()]);assert.equal(outcomes.filter(v=>v==='OK').length,1);assert(outcomes.some(v=>['BASIC_INSTALL_BUSY_OR_INTERRUPTED_LOCK','BASIC_INSTALL_RECONCILIATION_REQUIRED'].includes(v)));
  assert.equal((await readBasicInstallation(run)).eventCount,1);
});

test('abandoned writer locks fail closed and are never automatically removed',async()=>{
  const run=await create();await fs.mkdir(path.join(run.directory,'.writer-lock'));
  await rejects(claimBasicInstallationStep({...run,key:run.state.intent.steps[0].key}),'BUSY_OR_INTERRUPTED_LOCK');
  assert((await fs.lstat(path.join(run.directory,'.writer-lock'))).isDirectory());
  await rejects(readBasicInstallation(run),'BUSY_OR_INTERRUPTED_LOCK');
});

test('altered, truncated, missing or unexpected journal files fail closed without writing replacement events',async()=>{
  for(const mutation of ['alter','truncate','gap','unexpected']){
    const run=await create(),key=run.state.intent.steps[0].key;await claimBasicInstallationStep({...run,key});
    const file=path.join(run.directory,'000001.json');
    if(mutation==='alter'){const event=JSON.parse(await fs.readFile(file));event.key='theme';await fs.writeFile(file,JSON.stringify(event));}
    if(mutation==='truncate')await fs.writeFile(file,'{"sequence":');
    if(mutation==='gap')await fs.rename(file,path.join(run.directory,'000002.json'));
    if(mutation==='unexpected')await fs.writeFile(path.join(run.directory,'extra.txt'),'unexpected');
    await rejects(readBasicInstallation(run),'CORRUPT_JOURNAL');
    await rejects(claimBasicInstallationStep({...run,key}),'CORRUPT_JOURNAL');
  }
});

test('deleted valid tail or checkpoint ahead of events cannot reopen a pending step',async()=>{
  const run=await create(),key=run.state.intent.steps[0].key;await claimBasicInstallationStep({...run,key});
  await fs.unlink(path.join(run.directory,'000001.json'));
  await rejects(readBasicInstallation(run),'HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  await rejects(claimBasicInstallationStep({...run,key}),'HEAD_MISMATCH_RECONCILIATION_REQUIRED');
  assert.equal(JSON.parse(await fs.readFile(path.join(run.directory,'head.json'))).sequence,1);
});

test('existing remote resources, repeated variant IDs, wrong price/stock and publication are rejected',async()=>{
  const run=await create(),step=run.state.intent.steps[0],c=await claimBasicInstallationStep({...run,key:step.key}),attemptId=c.steps[step.key].attemptId;
  const bads=[r=>r.remoteId='9',r=>r.observed.variants[1].remoteId=r.observed.variants[0].remoteId,r=>r.observed.variants[0].priceMinor++,r=>r.observed.variants[0].stock++,r=>r.observed.variants[0].optionValues=['WRONG SIZE'],r=>r.observed.variants[0].weightGrams=9999,r=>r.observed.variants[0].imagePosition=3,r=>r.observed.inventoryLocationId='999',r=>r.observed.title='Changed title',r=>r.observed.descriptionHtmlSha256='f'.repeat(64),r=>r.observed.status='ACTIVE',r=>r.observed.channels=['Online Store'],r=>r.payloadHash='f'.repeat(64)];
  for(const change of bads){const r=receipt(c,step,100);change(r);await assert.rejects(recordBasicInstallationReceipt({...run,key:step.key,attemptId,receipt:r}),error=>['BASIC_INSTALL_REMOTE_ID_CONFLICT','BASIC_INSTALL_RECEIPT_MISMATCH'].includes(error.code));}
  assert.equal((await readBasicInstallation(run)).eventCount,1);
});

test('media parent and position are exact and one remote media ID cannot fill two slots',async()=>{
  const run=await create(),product=run.state.intent.steps[0];let c=await claimBasicInstallationStep({...run,key:product.key});
  c=await recordBasicInstallationReceipt({...run,key:product.key,attemptId:c.steps[product.key].attemptId,receipt:receipt(c,product,100)});
  const media=run.state.intent.steps[1];c=await claimBasicInstallationStep({...run,key:media.key});let r=receipt(c,media,200);r.observed.parentRemoteId='999';
  await rejects(recordBasicInstallationReceipt({...run,key:media.key,attemptId:c.steps[media.key].attemptId,receipt:r}),'RECEIPT_MISMATCH');
  c=await recordBasicInstallationReceipt({...run,key:media.key,attemptId:c.steps[media.key].attemptId,receipt:receipt(c,media,200)});
  const next=run.state.intent.steps[2];c=await claimBasicInstallationStep({...run,key:next.key});
  await rejects(recordBasicInstallationReceipt({...run,key:next.key,attemptId:c.steps[next.key].attemptId,receipt:receipt(c,next,200)}),'REMOTE_ID_CONFLICT');
});

test('variant media association rejects another image or variant and cannot run before media',async()=>{
  const run=await create(),mapping=run.state.intent.steps.find(s=>s.kind==='variant_media');
  await rejects(claimBasicInstallationStep({...run,key:mapping.key}),'INVALID_TRANSITION');
  let state=run.state,id=100;
  for(const step of state.intent.steps.filter(s=>['catalog','media'].includes(s.kind))){state=await claimBasicInstallationStep({...run,key:step.key});state=await recordBasicInstallationReceipt({...run,key:step.key,attemptId:state.steps[step.key].attemptId,receipt:receipt(state,step,id++)});}
  state=await claimBasicInstallationStep({...run,key:mapping.key});const attemptId=state.steps[mapping.key].attemptId;
  for(const change of [r=>r.observed.associations[0].mediaRemoteId='999',r=>r.observed.associations[0].variantRemoteId='999',r=>r.remoteId='999']){const value=receipt(state,mapping,200);change(value);await rejects(recordBasicInstallationReceipt({...run,key:mapping.key,attemptId,receipt:value}),'RECEIPT_MISMATCH');}
  assert.equal((await recordBasicInstallationReceipt({...run,key:mapping.key,attemptId,receipt:receipt(state,mapping,200)})).steps[mapping.key].status,'succeeded');
});

test('complete installation remains draft; separately scoped temporary visibility must be restored exactly',async()=>{
  const run=await create(),done=await finish(run);assert.equal(done.installationStatus,'installed_operator_attested');assert.equal(done.visibility.status,'not_started');
  const scope=await getBasicVisibilityScope(run),authorization={scopeHash:scope.scopeHash,referenceSha256:'c'.repeat(64),temporaryOnly:true,restoreRequired:true,themePublishAuthorized:false};
  await rejects(claimBasicVisibilityReview({...run,authorization:{...authorization,themePublishAuthorized:true},evidence:ev}),'VISIBILITY_SCOPE_MISMATCH');
  const claimed=await claimBasicVisibilityReview({...run,authorization,evidence:ev});assert.equal(claimed.visibility.status,'restoration_required');
  const observed=restored(scope);observed.products[0].channels=['Online Store'];
  await rejects(recordBasicRestoration({...run,observed,evidence:ev}),'RESTORATION_MISMATCH');
  const wrongTheme=restored(scope);wrongTheme.liveThemeId='999';await rejects(recordBasicRestoration({...run,observed:wrongTheme,evidence:ev}),'RESTORATION_MISMATCH');
  const restoredState=await recordBasicRestoration({...run,observed:restored(scope),evidence:ev});assert.equal(restoredState.visibility.status,'restored_operator_attested');
  assert.equal((await recordBasicRestoration({...run,observed:restored(scope),evidence:ev})).duplicate,true);
  assert.equal((await readBasicInstallation(run)).visibility.status,'restored_operator_attested');
  await rejects(claimBasicVisibilityReview({...run,authorization,evidence:ev}),'VISIBILITY_SCOPE_MISMATCH');
});

test('unsafe public output and symlinked directories or journal files are not accepted',async t=>{
  await rejects(create({directory:path.join(PRIVATE_ROOT,'..','public-installation-test')}),'PRIVATE_DIRECTORY_REQUIRED');
  const run=await create(),target=path.join(root,crypto.randomUUID());
  try{await fs.symlink(run.directory,target,'junction');}catch(error){if(['EPERM','EACCES','UNKNOWN'].includes(error.code)){t.skip('Platform cannot create directory links.');return;}throw error;}
  await rejects(readBasicInstallation({...run,directory:target}),'UNSAFE_DIRECTORY');
});

async function stagedCheckpoint(){
  const run=await create(),source=path.join(run.directory,'head.next.json'),target=path.join(run.directory,'head.json'),lock=path.join(run.directory,'.writer-lock');
  const old=await fs.readFile(target),next=JSON.stringify({intentHash:run.state.intentHash,sequence:1,eventHash:'f'.repeat(64)})+'\n';
  await fs.writeFile(source,next,{flag:'wx'});await fs.mkdir(lock);
  return {...run,source,target,lock,old,next};
}

test('checkpoint rename retries only unchanged local bytes under the existing lock',async()=>{
  const run=await stagedCheckpoint();let attempts=0;const delays=[];
  await renameBasicInstallationCheckpoint(run.directory,{rename:async(source,target)=>{
    assert.equal(source,run.source);assert.equal(target,run.target);assert.equal(await fs.readFile(source,'utf8'),run.next);assert((await fs.lstat(run.lock)).isDirectory());
    attempts++;if(attempts<=2)throw Object.assign(new Error('synthetic transient file lock'),{code:attempts===1?'EPERM':'EBUSY'});await fs.rename(source,target);
  },wait:async ms=>delays.push(ms)});
  assert.equal(attempts,3);assert.deepEqual(delays,[20,50]);assert.equal(await fs.readFile(run.target,'utf8'),run.next);
  await assert.rejects(fs.lstat(run.source),{code:'ENOENT'});
  // No provider call, event construction, or second claim occurs in this helper.
  assert.equal((await fs.readdir(run.directory)).filter(name=>/^\d{6}\.json$/.test(name)).length,0);
});

test('exhausted checkpoint lock retries retain old head and pending checkpoint and fail closed',async()=>{
  const run=await stagedCheckpoint();let attempts=0;const delays=[];
  await assert.rejects(renameBasicInstallationCheckpoint(run.directory,{rename:async()=>{attempts++;throw Object.assign(new Error('synthetic persistent file lock'),{code:'EPERM'});},wait:async ms=>delays.push(ms)}),{code:'EPERM'});
  assert.equal(attempts,5);assert.deepEqual(delays,[20,50,100,200]);assert.deepEqual(await fs.readFile(run.target),run.old);assert.equal(await fs.readFile(run.source,'utf8'),run.next);
  await fs.rmdir(run.lock);await rejects(readBasicInstallation(run),'CORRUPT_JOURNAL');await rejects(claimBasicInstallationStep({...run,key:run.state.intent.steps[0].key}),'CORRUPT_JOURNAL');
});

test('checkpoint errors other than transient locks are never retried',async()=>{
  for(const code of ['EACCES','ENOENT','EIO']){
    const run=await stagedCheckpoint();let attempts=0,waits=0;
    await assert.rejects(renameBasicInstallationCheckpoint(run.directory,{rename:async()=>{attempts++;throw Object.assign(new Error('synthetic nonretryable failure'),{code});},wait:async()=>{waits++;}}),{code});
    assert.equal(attempts,1);assert.equal(waits,0);assert.deepEqual(await fs.readFile(run.target),run.old);assert.equal(await fs.readFile(run.source,'utf8'),run.next);
  }
});

test('changed checkpoint or destination during a transient lock aborts before a second rename',async()=>{
  for(const changed of ['source','target']){
    const run=await stagedCheckpoint();let attempts=0;
    await rejects(renameBasicInstallationCheckpoint(run.directory,{rename:async()=>{attempts++;throw Object.assign(new Error('synthetic file lock'),{code:'EPERM'});},wait:async()=>{await fs.appendFile(run[changed],' ');}}),'CHECKPOINT_CHANGED_RECONCILIATION_REQUIRED');
    assert.equal(attempts,1);assert.equal((await fs.readdir(run.directory)).filter(name=>/^\d{6}\.json$/.test(name)).length,0);
  }
});

test('checkpoint helper requires held private lock and exact next sequence',async()=>{
  const run=await stagedCheckpoint();let attempts=0;await fs.rmdir(run.lock);
  await assert.rejects(renameBasicInstallationCheckpoint(run.directory,{rename:async()=>{attempts++;}}),{code:'ENOENT'});
  await fs.mkdir(run.lock);await fs.writeFile(run.source,JSON.stringify({intentHash:run.state.intentHash,sequence:2,eventHash:'f'.repeat(64)}));
  await rejects(renameBasicInstallationCheckpoint(run.directory,{rename:async()=>{attempts++;}}),'HEAD_MISMATCH_RECONCILIATION_REQUIRED');assert.equal(attempts,0);
});
