import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const lib=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../lib');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonical(v));
const uuid=()=>crypto.randomUUID();

// Every test imports an independent copy with its own canonical PRIVATE_ROOT.
// Neither a real hosted permit nor an existing workspace is read or written.
async function fixture(t,{waiting=false,preflightFailure=false,foreignConfig=false,remaining=4*60*60*1000}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'molyvi-pipeline-'));
 const sessions=[];
 t.after(async()=>{for(const app of sessions)await app.stop();const actual=await fs.realpath(root),parent=await fs.realpath(os.tmpdir());assert.equal(path.dirname(actual),parent);assert(path.basename(actual).startsWith('molyvi-pipeline-'));await fs.rm(actual,{recursive:true});});
 await fs.cp(lib,path.join(root,'molyvi-growth','lib'),{recursive:true});
 await fs.cp(path.resolve(lib,'../../molyvi-contract'),path.join(root,'molyvi-contract'),{recursive:true});
 const api=await import(pathToFileURL(path.join(root,'molyvi-growth','lib','hosted-basic-pipeline.mjs')));
 const storage=path.join(root,'briefs','molyvi-hosted-staging'),directory=path.dirname(api.HOSTED_BASIC_PIPELINE_FILE);
 await fs.mkdir(directory,{recursive:true});
 let now=Date.parse('2026-10-19T16:00:00.000Z'),held=0,phase='prepared';const clock=()=>now,counters={preflight:0,prepare:0,installPrepare:0,load:0,start:0,token:0,release:0};
 const record={id:uuid(),ownerId:uuid(),synthetic:true},requestId=uuid();
 const body={schemaVersion:1,kind:'molyvi_basic_pipeline_permit',serviceId:'srv-db7othjrjlhs73cg7lf0',targetStore:'molyvi-still-dev.myshopify.com',projectId:record.id,ownerId:record.ownerId,sourceHash:hash(record),jobId:uuid(),authorizationSha256:'a'.repeat(64),operatorId:'molyvi-full-basic-test-20261019',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+remaining).toISOString(),credentialReference:{runId:uuid(),packageSha256:'b'.repeat(64),receiverSha256:'c'.repeat(64)},publicationAuthorized:false,newChargesAuthorized:false};
 const permit={...body,permitHash:hash(body)};await fs.writeFile(api.HOSTED_BASIC_PIPELINE_FILE,JSON.stringify(permit));
 const confirmation={requestId,sourceHash:permit.sourceHash,requestHash:'d'.repeat(64),projectId:record.id,ownerHash:hash(record.ownerId),planHash:'e'.repeat(64),themeZipSha256:'f'.repeat(64)};
 let acknowledged=true;
 const receipt=prepared=>({projectId:record.id,sourceHash:permit.sourceHash,readiness:{ready:true},request:acknowledged?{requestId,sourceHash:permit.sourceHash,state:prepared?'prepared_for_installation_review':'requested',outputVerifiedNow:prepared}:null});
 const resources=[{key:'catalog:p',kind:'catalog',remoteId:'2001'},...Array.from({length:3},(_,i)=>({key:`media:${i}`,kind:'media',remoteId:String(2101+i)})),{key:'variants',kind:'variant_media',remoteId:'2001'},{key:'collection',kind:'collection',remoteId:'2201'},...Array.from({length:7},(_,i)=>({key:`page:${i}`,kind:'page',remoteId:String(2301+i)})),{key:'theme',kind:'theme',remoteId:'2401'}];
 const report=()=>({phase,projectId:permit.projectId,jobId:permit.jobId,intentHash:'1'.repeat(64),counts:{succeeded:phase==='verified'?14:13,total:14},counters:{graphQLRequests:1,mutations:1,stagedUploads:1,externalRequests:1},resources});
 const preparation={status:async()=>receipt(counters.prepare>0),prepare:async()=>{assert.equal(held,1);counters.prepare++;return receipt(true);},loadPrepared:async()=>({confirmation,prepared:{plan:{},uploads:[]},theme:{manifest:{},zipBytes:Buffer.from('synthetic')}})};
 const dependencies={
  createPreparation:async()=>preparation,
  readToken:async()=>{counters.token++;return {accessToken:'SYNTHETIC_NEVER_A_REAL_CREDENTIAL'};},
  preflight:async()=>{assert.equal(held,1);counters.preflight++;if(preflightFailure)throw Object.assign(Error('synthetic'),{code:'SYNTHETIC_PREFLIGHT_FAILED'});return {evidence:{synthetic:true},preflightEvidence:{}};},
  prepareInstaller:async()=>{assert.equal(held,1);counters.installPrepare++;const config={runtimeProfile:'hosted_prepared_basic_v1',jobId:permit.jobId,projectId:foreignConfig?uuid():permit.projectId,authorizationSha256:permit.authorizationSha256,identity:{targetStore:permit.targetStore},confirmation,publicationAuthorized:false,newChargesAuthorized:false};const configFile=path.join(storage,'controlled-operations','basic-prepared-installer','jobs',permit.projectId,'config.json');await fs.mkdir(path.dirname(configFile),{recursive:true});const bytes=Buffer.from(JSON.stringify(config));await fs.writeFile(configFile,bytes,{flag:'wx'});return {configFile,configSha256:sha(bytes)};},
  loadInstaller:async options=>{counters.load++;const bytes=await fs.readFile(options.configFile);assert.equal(sha(bytes),options.configSha256);const config=JSON.parse(bytes);let lifecycle=phase==='verified'?'completed':'idle';return {config,start(){counters.start++;lifecycle='running';void options.getAccessToken().then(()=>{if(lifecycle==='stopped')return;phase=waiting?'waiting':'verified';if(!waiting)lifecycle='completed';});},status:()=>({phase,lifecycle}),inspect:async()=>report(),pause(){lifecycle='paused';},stop:async()=>{lifecycle='stopped';if(phase!=='verified')phase='stopped';}};}
 };
 const create=async overrides=>{const app=await api.createHostedBasicPipeline({permit,store:{read:async(id,owner)=>{assert.equal(id,record.id);assert.equal(owner,record.ownerId);return record;}},storage,clock,acquireLease:async()=>{assert.equal(held,0);held++;return()=>{assert.equal(held,1);held--;counters.release++;};},dependencies:{...dependencies,...overrides}});sessions.push(app);return app;};
 return {api,create,permit,record,directory,counters,session:{ownerId:record.ownerId,projectId:record.id},advance:ms=>now+=ms,acknowledge:value=>acknowledged=value,held:()=>held};
}
async function finished(app){for(let i=0;i<200;i++){const s=app.status();if(['completed','stopped_for_review'].includes(s.worker.lifecycle))return s;await new Promise(r=>setTimeout(r,10));}assert.fail('bounded worker completion timeout');}

test('confirmed source reaches one verified Draft handoff under lease; signal uses real worker API',async t=>{
 const f=await fixture(t),app=await f.create();app.signal();await finished(app);
 assert.equal(app.publicStatus(f.session).stage,'installed_draft');assert.equal(app.publicStatus({...f.session,ownerId:uuid()}),null);assert.equal(app.publicStatus(f.session).published,false);
 assert.deepEqual(f.counters,{preflight:1,prepare:1,installPrepare:1,load:1,start:1,token:1,release:1});assert.equal(f.held(),0);
 app.signal();await app.drain();assert.equal(f.counters.start,1);
});

test('completed journal reloads after permit expiry without start, credentials, composition or writes',async t=>{
 const f=await fixture(t),first=await f.create();first.start();await finished(first);await first.stop();
 const completionFile=path.join(f.directory,'completion.json'),before=await fs.readFile(completionFile),counts={...f.counters};f.advance(8*60*60*1000);
 const second=await f.create({readToken:async()=>{assert.fail('terminal reload must not access credentials');},preflight:async()=>{assert.fail('terminal reload must not preflight');}});second.start();await second.drain();
 assert.equal(second.publicStatus(f.session).stage,'installed_draft');assert.equal(second.status().worker.enabled,false);assert.deepEqual(await fs.readFile(completionFile),before);
 assert.equal(f.counters.load,counts.load+1);for(const k of ['prepare','start','token','preflight','installPrepare','release'])assert.equal(f.counters[k],counts[k],k);
});

test('unknown claimed handoff failure is retained and cannot retry preflight on restart',async t=>{
 const f=await fixture(t,{preflightFailure:true}),first=await f.create();first.start();await finished(first);assert.equal(first.publicStatus(f.session).stage,'blocked');assert.equal(f.counters.preflight,1);assert.equal(f.counters.installPrepare,0);await first.stop();
 const claim=await fs.readFile(path.join(f.directory,'handoff-claim.json'));
 const second=await f.create();second.start();await finished(second);assert.equal(second.publicStatus(f.session).stage,'blocked');assert.equal(f.counters.preflight,1);assert.equal(f.counters.start,0);assert.deepEqual(await fs.readFile(path.join(f.directory,'handoff-claim.json')),claim);assert.equal(f.held(),0);
});

test('foreign installer config is rejected before any start or credential access',async t=>{
 const f=await fixture(t,{foreignConfig:true}),app=await f.create();app.start();await finished(app);assert.equal(app.status().code,'BASIC_PIPELINE_INSTALLER_BINDING');assert.equal(f.counters.start,0);assert.equal(f.counters.token,0);assert.equal(f.held(),0);
});

test('insufficient permit window stops before handoff claim or provider preflight',async t=>{
 const f=await fixture(t,{remaining:60*60*1000}),app=await f.create();app.start();await finished(app);assert.equal(app.status().code,'BASIC_PIPELINE_PERMIT_WINDOW_INSUFFICIENT');assert.equal(f.counters.preflight,0);assert.equal(f.counters.start,0);await assert.rejects(fs.stat(path.join(f.directory,'handoff-claim.json')),{code:'ENOENT'});
});

test('shutdown during known-theme waiting drains installer and releases lease without deadlock',async t=>{
 const f=await fixture(t,{waiting:true}),app=await f.create();app.start();for(let i=0;i<200&&app.status().installer?.phase!=='waiting';i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.status().installer?.phase,'waiting');assert.equal(f.held(),1);
 await Promise.race([app.stop(),new Promise((_,reject)=>setTimeout(()=>reject(Error('shutdown deadlock')),2000))]);assert.equal(f.held(),0);assert.equal(f.counters.release,1);await assert.rejects(fs.stat(path.join(f.directory,'completion.json')),{code:'ENOENT'});
});

test('no confirmation starts no preparation; later signal starts exactly once',async t=>{
 const f=await fixture(t);f.acknowledge(false);const app=await f.create();app.start();await app.drain();assert.equal(f.counters.prepare,0);assert.equal(f.counters.start,0);f.acknowledge(true);app.signal();await finished(app);assert.equal(f.counters.start,1);
});

test('tampered completion and foreign handoff do not restore a false terminal status',async t=>{
 const f=await fixture(t),app=await f.create();app.start();await finished(app);await app.stop();const file=path.join(f.directory,'completion.json'),original=await fs.readFile(file),value=JSON.parse(original);value.themeId='999';await fs.writeFile(file,JSON.stringify(value));await assert.rejects(f.create(),{code:'BASIC_PIPELINE_COMPLETION_INVALID'});
 await fs.writeFile(file,original);const handoffFile=path.join(f.directory,'handoff.json'),handoff=JSON.parse(await fs.readFile(handoffFile));handoff.configFile=handoff.configFile.replace(f.permit.projectId,uuid());await fs.writeFile(handoffFile,JSON.stringify(handoff));await assert.rejects(f.create(),{code:'BASIC_PIPELINE_HANDOFF_MISMATCH'});assert.equal(f.counters.start,1);assert.equal(f.counters.token,1);
});
