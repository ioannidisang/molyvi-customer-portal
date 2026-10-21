import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {canonicalJson} from '../lib/intake-store.mjs';
import {validateReferencePipelinePermit,allowsReferencePipelineAuthority,REFERENCE_PIPELINE_KIND,REFERENCE_PIPELINE_PROJECT,REFERENCE_PIPELINE_OWNER,REFERENCE_PIPELINE_SERVICE} from '../lib/basic-reference-pipeline-authority.mjs';
import {settleKnownReferenceTheme} from '../lib/basic-prepared-reference-installer.mjs';
const hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const now=Date.now(),release='a'.repeat(40);
const body={schemaVersion:1,kind:REFERENCE_PIPELINE_KIND,serviceId:REFERENCE_PIPELINE_SERVICE,release,projectId:REFERENCE_PIPELINE_PROJECT,ownerId:REFERENCE_PIPELINE_OWNER,sourceHash:'b'.repeat(64),authorizationSha256:'c'.repeat(64),credentialReference:{runId:crypto.randomUUID(),packageSha256:'b'.repeat(64),receiverSha256:'d'.repeat(64)},createdAt:new Date(now).toISOString(),expiresAt:new Date(now+3*3600000).toISOString(),publicationAuthorized:false,newChargesAuthorized:false};
const seal=b=>({...b,permitHash:hash(b)});
test('only the exact project, owner, store service and release may activate',()=>{
 assert.deepEqual(validateReferencePipelinePermit(seal(body),{release,now,active:true}),seal(body));
 for(const change of [{projectId:crypto.randomUUID()},{ownerId:crypto.randomUUID()},{serviceId:'other'},{release:'f'.repeat(40)},{publicationAuthorized:true},{newChargesAuthorized:true}])assert.throws(()=>validateReferencePipelinePermit(seal({...body,...change}),{release,now,active:true}));
});
test('expired permits remain readable but cannot admit new work; credential scope and hash are bound',()=>{
 assert(validateReferencePipelinePermit(seal(body),{release,now:now+4*3600000}));
 assert.throws(()=>validateReferencePipelinePermit(seal(body),{release,now:now+4*3600000,active:true}),/PERMIT_EXPIRED/);
 assert.throws(()=>validateReferencePipelinePermit({...seal(body),sourceHash:'e'.repeat(64)}));
 assert.throws(()=>validateReferencePipelinePermit(seal({...body,credentialReference:{...body.credentialReference,packageSha256:'e'.repeat(64)}})),/CREDENTIAL_SCOPE/);
 assert.throws(()=>validateReferencePipelinePermit(seal({...body,expiresAt:new Date(now+7*3600000).toISOString()})),/PERMIT_WINDOW/);
});
test('caller JSON cannot forge the private reference capability',()=>{const config={store:{},storage:'x',buildRoot:'y'};assert.equal(allowsReferencePipelineAuthority({...config},config),false);assert.equal(allowsReferencePipelineAuthority(undefined,config),false);});
const waiting=(id='208999')=>({waiting:{kind:'shopify_theme_processing',stepKey:'theme',remoteId:id,nextCheckAt:new Date(now+1000).toISOString(),deadlineAt:new Date(now+60000).toISOString()}});
test('known theme waits until due and uses only readback; it does not recreate the theme',async()=>{
 let at=now,reads=0,waits=0;const done={installationStatus:'installed_operator_attested'};
 const result=await settleKnownReferenceTheme({result:waiting(),clock:()=>at,sleep:async ms=>{assert.equal(ms,1000);at+=ms;waits++;},readback:async()=>{reads++;return done;}});
 assert.equal(result,done);assert.equal(reads,1);assert.equal(waits,1);
});
test('foreign theme, early wake, expired wait and resource stop cannot dispatch another readback',async()=>{
 let reads=0;await assert.rejects(settleKnownReferenceTheme({result:waiting(),clock:()=>now,sleep:async()=>{},readback:async()=>{reads++;}}),/EARLY_WAKE/);assert.equal(reads,0);
 await assert.rejects(settleKnownReferenceTheme({result:waiting(),clock:()=>now+60001,readback:async()=>{reads++;}}),/WAIT_INVALID/);assert.equal(reads,0);
 await assert.rejects(settleKnownReferenceTheme({result:waiting(),assertActive:()=>{throw Error('STOP');},readback:async()=>{reads++;}}),/STOP/);assert.equal(reads,0);
 let at=now;await assert.rejects(settleKnownReferenceTheme({result:waiting(),clock:()=>at,sleep:async ms=>{at+=ms;},readback:async()=>{reads++;return waiting('209999');}}),/WAIT_INVALID/);assert.equal(reads,1);
});
test('endless pending readbacks stop at a bounded count',async()=>{let reads=0,at=now;await assert.rejects(settleKnownReferenceTheme({result:waiting(),clock:()=>at,sleep:async ms=>{at+=ms;},readback:async()=>{reads++;return waiting();}}),/WAIT_LIMIT/);assert.equal(reads,13);});
