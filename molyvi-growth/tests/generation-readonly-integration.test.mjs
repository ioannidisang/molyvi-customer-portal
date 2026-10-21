import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
import {hostedBackupReadView} from '../lib/hosted-backup-read-view.mjs';
import {createWorkspace} from '../lib/task-workspace.mjs';
import {createPaidOrder} from '../lib/service-offer.mjs';
import {inventory} from '../operations/r2-backup/backup.mjs';
import {R2Budget} from '../operations/r2-backup/r2-budget.mjs';
import {GenerationCatalog} from '../operations/r2-backup/generation-catalog.mjs';
import {createGenerationBackupRun} from '../operations/r2-backup/generation-run.mjs';
import {createR2Transport} from '../operations/r2-backup/r2-transport.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const scope={serviceId:'srv-readview-local',workspaceId:'tea-readview-local'};
const config={accountId:'a'.repeat(32),accessKeyId:'b'.repeat(32),secretAccessKey:'c'.repeat(64),bucket:'molyvi-private-backups',jurisdiction:'eu'};
const rowState=app=>app.accounts.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({name})=>({name,rows:app.accounts.db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()}));
const sourceState=async source=>(await inventory(source,{skipSqliteSidecars:true})).filter(x=>x.file!=='accounts/customers.sqlite'&&x.path!=='accounts/customers.sqlite');

test('operator read-view opt-in defaults off and refuses ambiguous values',()=>{
  assert.equal(hostedBackupReadView(undefined),false);assert.equal(hostedBackupReadView('false'),false);assert.equal(hostedBackupReadView('true'),true);
  for(const value of ['',null,1,true,'TRUE','yes',' false '])assert.throws(()=>hostedBackupReadView(value),/HOSTED_BACKUP_READ_CONFIG/);
});

for(const failure of [false,true])test('real generation + resident customer views '+(failure?'preserves failed charge and stops replay':'restores fully while views stay read-only'),{timeout:120_000},async()=>{
  await fs.mkdir(PRIVATE_ROOT,{recursive:true});
  const root=await fs.mkdtemp(path.join(await fs.realpath(PRIVATE_ROOT),'_generation-readonly-'));
  const source=path.join(root,'source'),runs=path.join(root,'runs'),remote=path.join(root,'remote');
  let app,budget,catalog,passed=false,observer,done=false,observationError;
  const observations=[],calls=[];
  try{
    await fs.mkdir(runs);await fs.mkdir(remote);
    app=await createHostedCustomerServer({storage:source,publicOrigin:'https://app.molyvi.com',backupReadOnly:true});
    const account=app.accounts.provision({address:'generation-view@example.invalid',name:'Synthetic local customer'});
    const record=createWorkspace({ownerId:crypto.randomUUID(),order:createPaidOrder({id:'SYNTHETIC-READVIEW-'+crypto.randomUUID(),packageId:'basic'}),budgetEur:0});
    await app.workspaces.create(record);
    await app.deliveries.grantProject({accountId:account.id,projectId:record.id,ownerId:record.ownerId,label:'Synthetic local only'});
    const login=app.accounts.login({address:account.email,code:app.accounts.issueCode(account.id)});
    const cookie='__Host-molyvi_customer='+login.token;
    await fs.mkdir(path.join(source,'gmail-journal'),{recursive:true});
    // Fully written incompressible bytes, no sparse/zero padding or real customer data.
    const handle=await fs.open(path.join(source,'gmail-journal/synthetic.bin'),'wx');
    try{for(let n=0;n<(failure?2:32);n++)await handle.writeFile(crypto.randomBytes(1024*1024));}finally{await handle.close();}
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    for(let n=0;!app.server.resourceStatus().startupSettled&&n<400;n++)await pause(5);
    assert.equal(app.server.resourceStatus().startupFailed,false);
    const request=(route,method='GET')=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:route,method,
        headers:{Host:'app.molyvi.com',Cookie:cookie,Origin:'https://app.molyvi.com'}},res=>{
        const chunks=[];let bytes=0;res.on('data',b=>{bytes+=b.length;if(bytes>2*1024*1024){req.destroy(Error('RESPONSE_BOUND'));return;}chunks.push(b);});
        res.on('end',()=>resolve({status:res.statusCode,mode:res.headers['x-molyvi-backup-mode'],body:Buffer.concat(chunks).toString()}));
      });req.on('error',reject);req.end();
    });
    const objects=new Map(),sdk={};
    for(const kind of ['HeadObject','ListObjectsV2','PutObject','GetObject','DeleteObject'])sdk[kind+'Command']=class{constructor(input){this.kind=kind;this.input=input;}};
    sdk.S3Client=class{
      async send({kind,input:i}){
        assert.equal(app.resourceStatus().backupActive,true);assert.equal(app.server.resourceStatus().heavyPaused,true);
        assert.equal(app.server.resourceStatus().backupReadOnlyActive,true);
        calls.push(kind);const obj=objects.get(i.Key),file=path.join(remote,sha(i.Key??'list'));
        if(kind==='ListObjectsV2')return {IsTruncated:false,Contents:[...objects].map(([Key,v])=>({Key,Size:v.bytes,ETag:v.etag}))};
        if(kind==='HeadObject'){if(!obj)throw Object.assign(Error('mock missing'),{$metadata:{httpStatusCode:404}});return {ContentLength:obj.bytes,Metadata:obj.metadata,ETag:obj.etag};}
        if(kind==='PutObject'){
          assert(!obj);await pipeline(i.Body,createWriteStream(file,{flags:'wx'}));
          const digest=crypto.createHash('sha256');for await(const b of createReadStream(file))digest.update(b);
          const etag='"'+digest.digest('hex')+'"';objects.set(i.Key,{bytes:(await fs.stat(file)).size,etag,metadata:i.Metadata});return {ETag:etag};
        }
        if(kind==='GetObject'){
          if(failure)throw Object.assign(Error('synthetic download unavailable'),{$metadata:{httpStatusCode:503}});
          assert(obj);return {ContentLength:obj.bytes,Metadata:obj.metadata,ETag:obj.etag,Body:createReadStream(file)};
        }
        assert.fail('Unexpected deletion');
      }
      destroy(){}
    };
    const key=crypto.randomBytes(32),keyFile=path.join(root,'local-key.bin');await fs.writeFile(keyFile,key,{flag:'wx',mode:0o600});
    budget=await new R2Budget(path.join(root,'local-budget.sqlite')).ready();
    catalog=await new GenerationCatalog(path.join(root,'local-catalog.sqlite'),{scope}).ready();catalog.importLegacy([]);
    let mutations=0,insideState,beforeRows,afterRows,initialClosedMs,snapshotMs,readStarted,readonlyChecks=0;
    const transact=app.workspaces.transact.bind(app.workspaces);app.workspaces.transact=(...args)=>{mutations++;return transact(...args);};
    const started=performance.now();
    const runner=createGenerationBackupRun({source,root:runs,release:'a'.repeat(40),keyFile,keyHash:sha(key),scope,budget,catalog,
      withBackupResources:task=>app.withBackupResources(async()=>{
        assert.equal((await request('/customer/')).status,503);
        insideState=await sourceState(source);beforeRows=rowState(app);mutations=0;
        try{return await task();}finally{
          done=true;await observer;if(observationError)throw observationError;
          assert.deepEqual(await sourceState(source),insideState);afterRows=rowState(app);assert.deepEqual(afterRows,beforeRows);assert.equal(mutations,0);
        }
      }),
      quietSnapshot:async task=>{
        const start=performance.now();
        const result=await app.quietSnapshot(async()=>{assert.equal((await request('/api/workspace')).status,503);return task();});
        snapshotMs=performance.now()-start;initialClosedMs=performance.now()-started;readStarted=performance.now();
        // Probe sequential private reads, matching the one-reader memory bound.
        const checkViews=async()=>{
          for(const route of ['/customer/','/api/customer/me','/api/workspace']){
            const r=await request(route);assert.equal(r.status,200,route);assert.equal(r.mode,'read-only');
            if(route==='/api/workspace')assert.equal(JSON.parse(r.body).id,record.id);
            observations.push({route,status:r.status,mode:r.mode});
          }
          for(const [route,method]of [['/api/task','POST'],['/api/customer/request-code','POST'],['/api/generated-photo/example','GET'],['/customer-files/example/all.zip','GET']]){
            assert.equal((await request(route,method)).status,503,route);
          }
          readonlyChecks++;
        };
        await checkViews();
        observer=(async()=>{try{while(!done){await pause(35);if(!done)await checkViews();}}catch(e){observationError=e;}})();
        return result;
      },r2Factory:options=>createR2Transport(config,{sdk,...options})});
    let result;
    if(failure)await assert.rejects(runner('auto-20261021010000-00000002'),/R2_GETOBJECT_FAILED/);
    else{result=await runner('auto-20261021010000-00000001');assert.equal(result.status,'PASS');assert.equal(result.restore.database.integrity,'ok');assert.equal(result.restore.mailSent,false);assert.equal(result.restore.liveStorageOverwritten,false);catalog.assertSettled();}
    const durationMs=performance.now()-started;
    assert(readonlyChecks>0);assert.equal(app.server.resourceStatus().backupReadOnlyActive,false);
    assert.equal(app.server.resourceStatus().heavyPaused,false);assert.equal((await request('/customer/')).status,200);
    assert.equal((await request('/api/customer/me')).mode,undefined);
    if(failure){
      const charge={...budget.summary()},count=calls.length;
      assert(charge.uploadBytes>0&&charge.downloadBytes>0);assert.throws(()=>catalog.assertSettled(),/UNSETTLED|RECONCILIATION/);
      await assert.rejects(runner('auto-20261021010000-00000003'),/UNSETTLED|RECONCILIATION/);
      assert.equal(calls.length,count);assert.deepEqual({...budget.summary()},charge);
    }
    console.log('GENERATION_READVIEW_RESULT '+JSON.stringify({failureTest:failure,status:'PASS',sourceBytes:result?.sourceBytes??null,
      durationMs,initialClosedMs,snapshotMs,readViewMs:performance.now()-readStarted,readonlyChecks,httpReads:observations.length,
      databaseTables:afterRows.length,sourceAndDatabasePreserved:true,workMutationsDuringBackup:0,calls,
      provider:'LOCAL_DISK_FAKE_SDK',realProviderCalls:0,hostedProof:false,maxRSSKiB:process.resourceUsage().maxRSS}));
    key.fill(0);passed=true;
  }finally{
    done=true;await observer;await app?.stop();catalog?.close();budget?.close();
    if(passed){const resolved=await fs.realpath(root),base=await fs.realpath(PRIVATE_ROOT);assert.equal(path.dirname(resolved),base);assert(path.basename(resolved).startsWith('_generation-readonly-'));await fs.rm(resolved,{recursive:true});}
    else console.error('PRESERVED_READVIEW_FIXTURE='+root);
  }
});
