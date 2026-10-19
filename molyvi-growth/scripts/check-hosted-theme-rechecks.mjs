// Operator-only hosted proof. No Shopify client, secrets, email or R2 transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {HOSTED_THEME_RECHECK_PROBE_ROOT,prepareHostedThemeRecheckProbe,loadHostedThemeRecheckProbe} from '../lib/hosted-theme-recheck-probe.mjs';
import {HOSTED_THEME_RECHECK_ACTIVATION_FILE,loadHostedThemeRecheckActivation} from '../lib/hosted-theme-recheck-activation.mjs';

const filename=fileURLToPath(import.meta.url),args=process.argv.slice(2),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const paths=jobId=>({jobDirectory:path.join(HOSTED_THEME_RECHECK_PROBE_ROOT,'jobs',jobId),configFile:path.join(HOSTED_THEME_RECHECK_PROBE_ROOT,'jobs',jobId,'config.json')});
async function until(fn){const end=Date.now()+20000;for(;;){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('PROBE_TIMEOUT');await sleep(30);}}
async function writeNew(file,value){const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(bytes.length<=32*1024);const h=await fs.open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
function child(phase,prepared){
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','HOME','USERPROFILE'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
    const proc=spawn(process.execPath,['--max-old-space-size=128',filename,'--child',phase,prepared.binding.jobId,prepared.configSha256],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',failure=null,killTimer;
    const abort=code=>{if(failure)return;failure=code;proc.kill('SIGTERM');killTimer=setTimeout(()=>proc.kill('SIGKILL'),2000);};
    const timeout=setTimeout(()=>abort('CHILD_TIMEOUT'),30000);
    proc.stdout.on('data',b=>{if(stdout.length<64001)stdout+=b;if(stdout.length>64000)abort('CHILD_OUTPUT_LIMIT');});proc.stderr.on('data',b=>{if(stderr.length<64001)stderr+=b;if(stderr.length>64000)abort('CHILD_OUTPUT_LIMIT');});
    proc.on('error',e=>{clearTimeout(timeout);clearTimeout(killTimer);reject(e);});proc.on('close',code=>{clearTimeout(timeout);clearTimeout(killTimer);if(failure||code!==0)return reject(Error(failure??'CHILD_PROOF_FAILED'));try{resolve(JSON.parse(stdout.trim().split('\n').at(-1)));}catch{reject(Error('CHILD_REPORT_INVALID'));}});
  });
}
async function runChild(phase,jobId,configSha256){
  assert(['pause','finish'].includes(phase)&&uuid(jobId)&&digest(configSha256));
  const loc=paths(jobId),probe=await loadHostedThemeRecheckProbe({configFile:loc.configFile,configSha256});
  const before=await probe.inspect(),scratch=await fs.mkdtemp(path.join(PRIVATE_ROOT,'molyvi-theme-proof-scratch-'+jobId+'-'));
  const scratchReal=await fs.realpath(scratch),tmpReal=await fs.realpath(PRIVATE_ROOT);
  assert.equal(path.dirname(scratchReal),tmpReal);
  let app,receivedSignal=false,stopPromise;
  const stop=()=>stopPromise??=app?.stop()??Promise.resolve();
  const signal=()=>{receivedSignal=true;void stop();};
  const get=route=>new Promise((resolve,reject)=>{const started=performance.now();const req=http.get({host:'127.0.0.1',port:app.server.address().port,path:route,headers:{Host:'molyvi-theme-probe.onrender.com'}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,milliseconds:performance.now()-started}));});req.setTimeout(3000,()=>req.destroy(Error('LOOPBACK_TIMEOUT')));req.on('error',reject);});
  try{
    app=await createHostedCustomerServer({storage:scratchReal,publicOrigin:'https://molyvi-theme-probe.onrender.com',themeRecheckConfig:probe});
    process.once('SIGTERM',signal);
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
    const health=await get('/healthz');assert.equal(health.status,200);
    let gate=null;
    if(phase==='pause'){
      // Observe lifecycle only while the callback owns its durable write lock.
      await until(()=>app.themeRechecks.status().checksStarted===1);
      await app.quietSnapshot(async()=>{
        const frozen=await probe.inspect();assert.equal(frozen.status,'waiting');assert.equal(frozen.counters.readChecks,2);const wait=Math.max(0,Date.parse(frozen.nextCheckAt)-Date.now())+120;
        assert(wait<4000);await sleep(wait);const after=await probe.inspect();assert.equal(after.head,frozen.head);
        assert.equal((await get('/healthz')).status,200);assert.equal((await get('/api/customer/session')).status,503);
        gate={progressUnchanged:true,healthAvailable:true,accountWritesPaused:true};
      });
    }else {await until(()=>app.themeRechecks.status().lifecycle==='completed');assert.equal(app.themeRechecks.status().terminalSourceStatus,'verified');}
    assert.equal(app.accounts.db.prepare('SELECT count(*) n FROM projects').get().n,0);
    assert.equal(app.accounts.db.prepare('SELECT count(*) n FROM mail_outbox').get().n,0);
    if(process.platform==='linux'){process.kill(process.pid,'SIGTERM');await until(()=>receivedSignal);await stopPromise;}else await stop();
    const after=await probe.inspect(),report={phase,pid:process.pid,platform:process.platform,health,backupGate:gate,gracefulSigterm:receivedSignal,before,after,worker:app.themeRechecks.status(),maxRssKiB:process.resourceUsage().maxRSS,actualProviderCalls:0,emailsSent:0,realShopifyWrites:0};
    await writeNew(path.join(loc.jobDirectory,`process-${phase}.json`),report);return report;
  }finally{
    process.removeListener('SIGTERM',signal);await stop();
    assert.equal(await fs.realpath(scratchReal),scratchReal);assert.equal(path.dirname(scratchReal),tmpReal);assert(path.basename(scratchReal).startsWith('molyvi-theme-proof-scratch-'+jobId+'-'));
    const entries=await fs.readdir(scratchReal,{recursive:true});assert(entries.length<128);
    let bytes=0;for(const relative of entries){const s=await fs.lstat(path.join(scratchReal,relative));assert(!s.isSymbolicLink());if(s.isFile())bytes+=s.size;}assert(bytes<8*1024*1024);
    await fs.rm(scratchReal,{recursive:true});
  }
}
try{
  let result;
  if(args[0]==='--child'&&args.length===4)result=await runChild(args[1],args[2],args[3]);
  else if(args.length===1&&args[0]==='--prove'){
    const prepared=await prepareHostedThemeRecheckProbe(),first=await child('pause',prepared),second=await child('finish',prepared);
    assert.notEqual(first.pid,second.pid);assert.equal(first.after.head,second.before.head);assert.equal(first.after.deadlineAt,second.after.deadlineAt);assert.deepEqual(first.after.counters,second.before.counters);
    assert.equal(first.after.status,'waiting');assert.equal(second.after.status,'verified');assert.equal(second.after.counters.themeCreateAttempts,1);assert.equal(second.after.counters.stagedUploads,1);assert.equal(second.after.counters.readChecks,3);
    const reopened=await loadHostedThemeRecheckProbe({configFile:prepared.configFile,configSha256:prepared.configSha256});assert.equal((await reopened.inspect()).head,second.after.head);
    result={status:'PASS_HOSTED_SCHEDULER_AND_PROGRESS_ONLY',prepared,processes:[first,second],distinctProcesses:true,budgetsPreserved:true,provider:'synthetic',fullInstallerVerified:false,externalProviderCalls:0,newCharges:0,publication:false};
    await writeNew(path.join(prepared.jobDirectory,'proof.json'),result);
    result.finalStorage=(await reopened.inspect()).storage;
  }else if(args.length===1&&args[0]==='--activate-synthetic-on-next-start'){
    assert.equal(process.env.RENDER_SERVICE_ID,'srv-db7othjrjlhs73cg7lf0');
    try{await fs.lstat(HOSTED_THEME_RECHECK_ACTIVATION_FILE);throw Error('ACTIVATION_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
    const prepared=await prepareHostedThemeRecheckProbe();
    await writeNew(HOSTED_THEME_RECHECK_ACTIVATION_FILE,{schemaVersion:1,mode:'synthetic_theme_rechecks',jobId:prepared.binding.jobId,configSha256:prepared.configSha256});
    result={status:'SYNTHETIC_PERMIT_PREPARED_NOT_YET_RUNNING',prepared,externalProviderCalls:0,newCharges:0,publication:false};
  }else if(args.length===1&&args[0]==='--inspect-activation'){
    const probe=await loadHostedThemeRecheckActivation();assert(probe);result=await probe.inspect();
  }else throw Error('EXPLICIT_PROOF_MODE_REQUIRED');
  console.log(JSON.stringify(result));
}catch{console.error(JSON.stringify({status:'STOP',code:'HOSTED_THEME_RECHECK_PROOF_FAILED',automaticRetry:false}));process.exitCode=1;}
