import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {R2Budget,R2_LIMITS} from './r2-budget.mjs';
import {GenerationCatalog} from './generation-catalog.mjs';
import {createR2Transport} from './r2-transport.mjs';
import {createGenerationBackupRun,AUTOMATIC_GENERATION_POLICY,GENERATION_AUTOMATIC_DISK_BYTES} from './generation-run.mjs';
import {selectAutomaticBackupFormat,readLegacyGenerationImport,requireExistingBackupDatabase,validateExistingGenerationBudget} from './automatic.mjs';
import {RetentionCatalog} from './retention.mjs';
import {BackupScheduler} from './scheduler.mjs';

const scope={serviceId:'srv-generation-run-test',workspaceId:'tea-generation-run-test'},release='a'.repeat(40);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const objectName=k=>hash(k)+'.bin';
const error=n=>Object.assign(Error('local injected failure'),{$metadata:{httpStatusCode:n}});
const config={accountId:'a'.repeat(32),accessKeyId:'b'.repeat(32),secretAccessKey:'c'.repeat(64),
  bucket:'molyvi-private-backups',jurisdiction:'eu'};
const runId=(n,stamp='20261001010000')=>`auto-${stamp}-${n.toString(16).padStart(8,'0')}`;

async function fixture(run,{seedLegacy=false}={}){
  const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'molyvi-generation-run-'));
  const source=path.join(root,'source'),runs=path.join(root,'runs'),remote=path.join(root,'remote');
  let passed=false,catalog,budget,scheduler;
  try{
    for(const d of [path.join(source,'accounts'),path.join(source,'gmail-journal'),runs,remote])await fs.mkdir(d,{recursive:true});
    const db=new DatabaseSync(path.join(source,'accounts/customers.sqlite'));
    db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT); CREATE TABLE projects(id TEXT,owner_id TEXT,order_id TEXT);
      CREATE TABLE deliveries(id TEXT,project_id TEXT,manifest_hash TEXT,zip_hash TEXT); CREATE TABLE reviews(delivery_id TEXT);
      CREATE TABLE sessions(hash TEXT); CREATE TABLE mail_outbox(payload TEXT);`);
    db.prepare('INSERT INTO accounts VALUES(?,?)').run('local-owner','test@example.invalid');db.close();
    await fs.writeFile(path.join(source,'gmail-journal/opaque.bin'),crypto.randomBytes(96*1024));
    await fs.writeFile(path.join(source,'hosted-scope.json'),'{"local":true,"revision":0}');
    const key=crypto.randomBytes(32),keyFile=path.join(root,'key.bin');await fs.writeFile(keyFile,key,{mode:0o600});
    let now=Date.parse('2026-10-01T01:00:00.000Z'),lease=false,clientCount=0,mode=null,triggered=false;
    const calls=[],objects=new Map(),catalogFile=path.join(root,'catalog.sqlite');
    budget=await new R2Budget(path.join(root,'budget.sqlite'),{now:()=>now}).ready();
    catalog=await new GenerationCatalog(catalogFile,{scope}).ready();
    // Synthetic previous verified record exercises format migration; it is not
    // a real historical restore receipt and is never described as one.
    const legacyKey='snapshots/2026-09-01/auto-20260901010000-11111111/service-backup.mlvb';
    if(seedLegacy){
      const bytes=crypto.randomBytes(77),sha256=hash(bytes),etag='"'+sha256+'"';
      await fs.writeFile(path.join(remote,objectName(legacyKey)),bytes);
      objects.set(legacyKey,{bytes:bytes.length,etag,metadata:{'molyvi-sha256':sha256,'molyvi-format':'1'}});
      catalog.importLegacy([{key:legacyKey,bytes:bytes.length,sha256,etag,verifiedAt:'2026-09-01T01:00:00.000Z',release,proofHash:hash('synthetic-prior-proof')}]);
    }else catalog.importLegacy([]);
    const sdk={};
    for(const name of ['HeadObject','ListObjectsV2','PutObject','GetObject','DeleteObject'])
      sdk[name+'Command']=class{constructor(input){this.input=input;this.kind=name;}};
    sdk.S3Client=class{
      constructor(){clientCount++;}
      async send(command){
        assert(lease,'provider outside whole production lease');
        const {kind,input:i}=command;calls.push({kind,key:i.Key??null});
        const obj=objects.get(i.Key),filename=path.join(remote,objectName(i.Key??'list'));
        if(kind==='ListObjectsV2')return {IsTruncated:false,Contents:[...objects].map(([Key,v])=>({Key,Size:v.bytes,ETag:v.etag}))};
        if(kind==='HeadObject'){if(!obj)throw error(404);return {ContentLength:obj.bytes,Metadata:obj.metadata,ETag:obj.etag};}
        if(kind==='PutObject'){
          assert(!obj);await pipeline(i.Body,createWriteStream(filename,{flags:'wx'}));
          const bytes=(await fs.stat(filename)).size,etag='"'+hash(await fs.readFile(filename))+'"';
          objects.set(i.Key,{bytes,etag,metadata:i.Metadata});
          if(mode==='put-unknown'&&!triggered){triggered=true;throw error(503);}
          return {ETag:etag};
        }
        if(kind==='GetObject'){
          if(!obj)throw error(404);
          let Body=createReadStream(filename);
          if(mode==='corrupt-get'&&!triggered){
            triggered=true;Body.destroy();const bytes=await fs.readFile(filename);bytes[bytes.length-1]^=1;Body=Readable.from(bytes);
          }
          return {ContentLength:obj.bytes,Metadata:obj.metadata,ETag:obj.etag,Body};
        }
        if(kind==='DeleteObject'){
          assert(obj);await fs.unlink(filename);objects.delete(i.Key);
          if(mode==='delete-unknown'&&!triggered){triggered=true;throw error(503);}
          return {};
        }
        assert.fail(kind);
      }
      destroy(){}
    };
    const f={root,source,runs,remote,calls,objects,scope,budget,legacyKey,
      get catalog(){return catalog;},get clientCount(){return clientCount;},
      date:value=>{now=Date.parse(value);},mode:value=>{mode=value;triggered=false;},
      now:()=>now,async mutate(n){await fs.writeFile(path.join(source,'hosted-scope.json'),JSON.stringify({local:true,revision:n}));},
      runner(extra={}){
        return createGenerationBackupRun({source,root:runs,release,keyFile,keyHash:hash(key),scope,budget,catalog,now:()=>now,
          withBackupResources:async task=>{assert(!lease);lease=true;try{return await task();}finally{lease=false;}},
          quietSnapshot:async task=>{assert(lease);return task();},
          r2Factory:options=>createR2Transport(config,{sdk,...options}),...extra});
      },
      async reopen(){catalog.close();catalog=await new GenerationCatalog(catalogFile,{scope}).ready();},
      async addUnknown(key){
        const bytes=crypto.randomBytes(77),filename=path.join(remote,objectName(key));await fs.writeFile(filename,bytes);
        objects.set(key,{bytes:bytes.length,etag:'"unknown"',metadata:{}});
      },
      async schedule(extra={}){
        scheduler=await new BackupScheduler({file:path.join(root,'schedule.sqlite'),firstAt:now,now:()=>now,perform:f.runner(),...extra}).ready();
        return scheduler;
      }
    };
    await run(f);passed=true;
  }finally{
    await scheduler?.stop();catalog?.close();budget?.close();
    if(passed){const real=await fs.realpath(root);assert.equal(path.dirname(real),temp);assert(path.basename(real).startsWith('molyvi-generation-run-'));await fs.rm(real,{recursive:true});}
    else process.stderr.write(`PRESERVED_GENERATION_RUN_FIXTURE=${root}\n`);
  }
}

test('explicit format gate defaults legacy, prevents downgrade or ambiguous configuration',()=>{
  const generation={...AUTOMATIC_GENERATION_POLICY,enabled:true},reference={schemaVersion:1,format:'MOLYVI-BACKUP-2',selection:'duplicate-images-v1',enabled:true};
  assert.equal(selectAutomaticBackupFormat(),'legacy');
  assert.equal(selectAutomaticBackupFormat({reference}),'reference');
  assert.equal(selectAutomaticBackupFormat({generation}),'generation');
  assert.throws(()=>selectAutomaticBackupFormat({reference,generation}),/FORMAT_CONFLICT/);
  assert.throws(()=>selectAutomaticBackupFormat({generationStatePresent:true}),/DOWNGRADE_FORBIDDEN/);
  assert.throws(()=>selectAutomaticBackupFormat({generation:{...generation,enabled:false}}),/ACTIVATION_INVALID/);
  assert.throws(()=>selectAutomaticBackupFormat({generation:{...generation,extra:true}}),/ACTIVATION_INVALID/);
});

test('budget-only wait preserves real catalog/ledger, sends one limit notice and rebuilds fresh input after restart',async()=>{
  await fixture(async f=>{
    f.budget.reserve({downloadBytes:R2_LIMITS.downloadBytes});
    const initial=JSON.stringify(f.catalog.snapshot()),ledger=JSON.stringify(f.budget.entries());let alerts=0;
    const s=await f.schedule({allowBudgetDeferral:true,perform:f.runner({allowBudgetDeferral:true}),notify:async a=>{alerts++;assert(a.notBefore>f.now());}});
    await s.tick();const waiting=s.status();
    assert.equal(waiting.status,'waiting');assert.equal(waiting.error,'BACKUP_TRANSFER_BUDGET_WAIT');assert.equal(waiting.alert_status,'accepted');assert.equal(alerts,1);
    assert.equal(f.clientCount,0);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.budget.entries()),ledger);assert.equal(JSON.stringify(f.catalog.snapshot()),initial);f.catalog.assertSettled();
    assert.equal(s.db.prepare('SELECT count(*) n FROM budget_waits').get().n,1);assert.equal(waiting.last_result,null);
    const runDir=path.join(f.runs,waiting.run_id);assert.deepEqual((await fs.readdir(runDir)).sort(),['budget-wait-complete.json','budget-wait.json']);
    await s.stop();await f.reopen();const restarted=await f.schedule({allowBudgetDeferral:true,perform:f.runner({allowBudgetDeferral:true}),notify:async()=>alerts++});
    await restarted.tick();assert.equal(alerts,1);assert.equal(f.clientCount,0);assert.deepEqual(restarted.status(),waiting);
    await f.mutate(91);const changed=hash(await fs.readFile(path.join(f.source,'hosted-scope.json')));
    f.date(new Date(waiting.next_at).toISOString());await restarted.tick();
    assert.equal(restarted.status().status,'waiting');assert.equal(restarted.status().error,null);assert.equal(restarted.status().last_result.status,'PASS');
    assert.equal(f.catalog.snapshot().base.descriptor.manifest.files.find(r=>r.file==='hosted-scope.json').sha256,changed);
    assert(f.calls.some(c=>c.kind==='PutObject'));assert(f.budget.summary().downloadBytes<R2_LIMITS.downloadBytes);f.catalog.assertSettled();
  });
});

test('new deferral-enabled path never defers or retries an uncertain provider PUT',async()=>{
  await fixture(async f=>{
    f.mode('put-unknown');let alerts=0;
    const s=await f.schedule({allowBudgetDeferral:true,perform:f.runner({allowBudgetDeferral:true}),notify:async()=>alerts++});
    await s.tick();assert.equal(s.status().status,'paused');assert.equal(alerts,1);assert(f.budget.summary().uploadBytes>0);
    assert.equal(s.db.prepare('SELECT count(*) n FROM budget_waits').get().n,0);const calls=f.calls.length;
    await s.stop();await f.reopen();const restarted=await f.schedule({allowBudgetDeferral:true,perform:f.runner({allowBudgetDeferral:true}),notify:async()=>alerts++});
    await restarted.tick();assert.equal(f.calls.length,calls);assert.equal(alerts,1);assert.equal(restarted.status().status,'paused');
  });
});

test('real codec + transport + SQLite catalog retains 4 weekly/3 monthly, shared base and unknown opaque data',async()=>{
  await fixture(async f=>{
    await f.addUnknown('unmanaged/opaque.mlvb');
    const dates=['2026-10-01','2026-10-08','2026-10-15','2026-11-01','2026-11-08','2026-12-01','2027-01-01'];
    let firstBase,deleted=0;
    for(let n=0;n<dates.length;n++){
      f.date(dates[n]+'T01:00:00.000Z');await f.mutate(n);
      const result=await f.runner()(runId(n+1));
      assert.equal(result.status,'PASS');assert.equal(result.restore.database.integrity,'ok');
      assert.equal(result.restore.mailSent,false);assert.equal(result.restore.liveStorageOverwritten,false);
      const state=f.catalog.snapshot();firstBase??=state.base.key;assert.equal(state.base.key,firstBase);
      assert(state.generations.length<=6);assert(result.retention.weekly.length<=4);assert(result.retention.monthly.length<=3);
      deleted+=result.retention.deleted.length;assert(f.objects.has('unmanaged/opaque.mlvb'));
      assert.equal(f.calls.filter(x=>x.kind==='PutObject'&&x.key===firstBase).length,1);
      await f.reopen();f.catalog.assertSettled();
    }
    assert(deleted>0);assert(f.objects.has(firstBase));assert(!f.objects.has(f.legacyKey));
    const before=f.calls.length;
    await assert.rejects(f.runner()(runId(7)),/EXISTS|DUPLICATE/);assert.equal(f.calls.length,before);
    assert(f.budget.entries().length>0);
    const dbUsage=f.budget.summary();assert(dbUsage.requests<=R2_LIMITS.requests);
    assert.equal(f.clientCount,7);
  },{seedLegacy:true});
});

test('lost PUT response keeps its charge and unresolved run, no replay or cleanup after restart',async()=>{
  await fixture(async f=>{
    f.mode('put-unknown');await assert.rejects(f.runner()(runId(20)),/R2_PUTOBJECT_FAILED/);
    const calls=f.calls.length,usage={...f.budget.summary()},remote=[...f.objects.keys()];
    assert(usage.uploadBytes>0);assert.equal(remote.length,1);
    await f.reopen();await assert.rejects(f.runner()(runId(21)),/RECONCILIATION|UNSETTLED/);
    assert.equal(f.calls.length,calls);assert.deepEqual({...f.budget.summary()},usage);
    assert.deepEqual([...f.objects.keys()],remote);assert(!f.calls.some(x=>x.kind==='DeleteObject'));
  });
});

test('corrupted downloaded ciphertext never commits new generation or deletes older objects',async()=>{
  await fixture(async f=>{
    await f.runner()(runId(30));const prior=f.catalog.snapshot();
    f.date('2026-10-08T01:00:00.000Z');await f.mutate(2);f.mode('corrupt-get');
    await assert.rejects(f.runner()(runId(31)),/R2_DOWNLOAD|HASH|INTEGRITY/);
    assert.deepEqual(f.catalog.snapshot().generations,prior.generations);
    assert(!f.calls.some(x=>x.kind==='DeleteObject'));assert.throws(()=>f.catalog.assertSettled(),/RECONCILIATION|UNSETTLED/);
  });
});

test('unknown generation object stops before upload and is preserved',async()=>{
  await fixture(async f=>{
    await f.addUnknown(`generations/v1/bases/${'f'.repeat(64)}.mlvb`);
    await assert.rejects(f.runner()(runId(40)),/UNKNOWN_GENERATION_OBJECT/);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'ListObjectsV2');
    assert.equal(f.objects.size,1);
  });
});

test('budget/source disk guards cause no provider construction or calls',async()=>{
  await fixture(async f=>{
    await assert.rejects(f.runner({statfs:async()=>({bavail:1,bsize:1})})(runId(50)),/LOCAL_DISK_LIMIT/);
    assert.equal(f.clientCount,0);f.catalog.assertSettled();
    f.budget.reserve({downloadBytes:R2_LIMITS.downloadBytes});
    await assert.rejects(f.runner()(runId(51)),/TRANSFER_BUDGET_STOP/);
    assert.equal(f.clientCount,0);assert.equal(f.calls.length,0);
    assert(GENERATION_AUTOMATIC_DISK_BYTES>5_000_000_000);
  });
});

test('partial remote delete remains unresolved and never retries on scheduler restart',async()=>{
  await fixture(async f=>{
    for(let n=0;n<4;n++){
      f.date(`2026-10-${String(1+n*7).padStart(2,'0')}T01:00:00.000Z`);await f.mutate(n);
      await f.runner()(runId(60+n));
    }
    f.date('2026-10-29T01:00:00.000Z');await f.mutate(5);f.mode('delete-unknown');
    let alerts=0;const s=await f.schedule({notify:async()=>{alerts++;}});
    await s.tick();assert.equal(s.status().status,'paused');assert.equal(alerts,1);
    assert(f.calls.some(x=>x.kind==='DeleteObject'));const callCount=f.calls.length,usage={...f.budget.summary()};
    await s.stop();await f.reopen();
    const restarted=await f.schedule({notify:async()=>{alerts++;}});
    await restarted.tick();assert.equal(alerts,1);assert.equal(f.calls.length,callCount);
    assert.deepEqual({...f.budget.summary()},usage);assert.throws(()=>f.catalog.assertSettled(),/RECONCILIATION|UNSETTLED/);
  });
});

test('reserveRecorded is actual persistent row, global failed/unknown usage remains after reopen',async()=>{
  await fixture(async f=>{
    const a=f.budget.reserveRecorded({requests:1}),b=f.budget.reserveRecorded({uploadBytes:123});
    assert(b.id>a.id);assert.equal(a.at,f.now());assert.equal(b.uploadBytes,123);
    assert.deepEqual(f.budget.entries().map(x=>x.id),[a.id,b.id]);
    assert.deepEqual({...f.budget.summary()},{requests:1,uploadBytes:123,downloadBytes:0});
  });
});

test('missing old catalog or cost ledger cannot create replacements; old catalog import is read-only',async()=>{
  await fixture(async f=>{
    const missing=path.join(f.root,'missing.sqlite');
    await assert.rejects(readLegacyGenerationImport(missing),{code:'ENOENT'});
    await assert.rejects(requireExistingBackupDatabase(missing),{code:'ENOENT'});
    await assert.rejects(fs.stat(missing),{code:'ENOENT'});
    const oldFile=path.join(f.root,'old.sqlite'),old=await new RetentionCatalog(oldFile).ready();
    old.close();const before=hash(await fs.readFile(oldFile));
    assert.deepEqual(await readLegacyGenerationImport(oldFile),[]);
    assert.equal(hash(await fs.readFile(oldFile)),before);
    assert.equal(f.calls.length,0);
  });
});

test('existing wrong or corrupt cost database stops unchanged; valid prior reservations are preserved',async()=>{
  await fixture(async f=>{
    const unrelated=path.join(f.root,'unrelated.sqlite'),db=new DatabaseSync(unrelated);
    db.exec('CREATE TABLE unrelated(id INTEGER)');db.close();
    const original=hash(await fs.readFile(unrelated));
    await assert.rejects(validateExistingGenerationBudget(unrelated),/SCHEMA_REQUIRED/);
    assert.equal(hash(await fs.readFile(unrelated)),original);
    const corrupt=path.join(f.root,'corrupt.sqlite');await fs.writeFile(corrupt,'corrupt SQLite bytes');
    await assert.rejects(validateExistingGenerationBudget(corrupt));
    assert.equal(await fs.readFile(corrupt,'utf8'),'corrupt SQLite bytes');
    f.budget.reserve({requests:7,uploadBytes:100});const valid=path.join(f.root,'budget.sqlite');
    const before=hash(await fs.readFile(valid));assert.equal(await validateExistingGenerationBudget(valid),true);
    assert.equal(hash(await fs.readFile(valid)),before);
    assert.deepEqual({...f.budget.summary()},{requests:7,uploadBytes:100,downloadBytes:0});assert.equal(f.calls.length,0);
  });
});
