import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
import {createWorkspace} from '../lib/task-workspace.mjs';
import {createPaidOrder} from '../lib/service-offer.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await delay(5);}throw Error('TEST_WAIT_TIMEOUT');}
async function fixture(t,{enabled=true}={}){
  const storage=path.join(PRIVATE_ROOT,'_backup-readonly-'+crypto.randomUUID());
  const app=await createHostedCustomerServer({storage,publicOrigin:'https://app.molyvi.com',backupReadOnly:enabled});
  const account=app.accounts.provision({address:'readonly@example.invalid',name:'Synthetic read-only customer'});
  const record=createWorkspace({ownerId:crypto.randomUUID(),order:createPaidOrder({id:'SYNTHETIC-READONLY-'+crypto.randomUUID(),packageId:'basic'}),budgetEur:0});
  await app.workspaces.create(record);
  await app.deliveries.grantProject({accountId:account.id,projectId:record.id,ownerId:record.ownerId,label:'Read-only fixture'});
  const login=app.accounts.login({address:account.email,code:app.accounts.issueCode(account.id)});
  const cookie='__Host-molyvi_customer='+login.token;
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.stop();const base=await fs.realpath(PRIVATE_ROOT),real=await fs.realpath(storage);assert.equal(path.dirname(real),base);assert(path.basename(real).startsWith('_backup-readonly-'));await fs.rm(real,{recursive:true});});
  await until(()=>app.server.resourceStatus().startupSettled);assert.equal(app.server.resourceStatus().startupFailed,false);
  const request=(route,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:route,method,headers:{Host:'app.molyvi.com',Cookie:cookie,...headers}},res=>{
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>3*1024*1024){req.destroy(Error('TEST_RESPONSE_BOUND'));return;}chunks.push(b);});
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
  const file=path.join(app.workspaces.storage,record.id,'workspace.json');
  return {app,record,account,request,cookie,file};
}
async function readMode(f,fn){return f.app.withBackupResources(async()=>{await f.app.quietSnapshot(async()=>({verified:true}));return fn();});}
function tableRows(accounts){return accounts.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:accounts.db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()}));}

test('opt-in disabled retains health-only behavior after snapshot',async t=>{
  const f=await fixture(t,{enabled:false});await readMode(f,async()=>{
    assert.equal((await f.request('/healthz')).status,200);
    for(const route of ['/customer/','/api/customer/me','/api/workspace'])assert.equal((await f.request(route)).status,503);
    assert.equal(f.app.server.resourceStatus().backupReadOnlyActive,false);
  });
});
test('initial drain remains closed; verified snapshot enables only bounded views without writes or pump',async t=>{
  const f=await fixture(t);
  await f.app.withBackupResources(async()=>{
    assert.equal((await f.request('/customer/')).status,503);
    const before=await fs.readFile(f.file),tables=tableRows(f.app.accounts);let mutations=0;
    const original=f.app.workspaces.transact.bind(f.app.workspaces);f.app.workspaces.transact=(...args)=>{mutations++;return original(...args);};
    await f.app.quietSnapshot(async()=>{assert.equal((await f.request('/api/customer/me')).status,503);});
    for(const route of ['/customer/','/workspace/','/api/service-config','/api/customer/me','/api/workspace']){
      const response=await f.request(route);assert.equal(response.status,200,route);assert.equal(response.headers['x-molyvi-backup-mode'],'read-only');
    }
    assert.equal(JSON.parse((await f.request('/api/workspace')).body).id,f.record.id);
    assert.equal(mutations,0);assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(tableRows(f.app.accounts),tables);
    assert.equal(f.app.server.resourceStatus().heavyPaused,true);
  });
  assert.equal(f.app.server.resourceStatus().backupReadOnlyActive,false);assert.equal((await f.request('/customer/')).status,200);
});
test('explicit route/method/auth/origin allowlist rejects all mutation, media, downloads and operator work',async t=>{
  const f=await fixture(t);await readMode(f,async()=>{
    for(const route of ['/api/customer/me?x=1','/api/workspace?x=1','/api/customer/delivery-feedback','/api/content-preview','/api/project-contract','/api/basic-preparation','/operator/','/operator.js','/customer-files/a/b.zip','/operator-revision-files/a/b.zip','/api/photo/a','/api/generated-photo/a','/api/logo/a']){
      const r=await f.request(route);assert.equal(r.status,503,route);assert.equal(r.headers['retry-after'],'15');
    }
    for(const method of ['POST','PUT','HEAD']){
      const r=await f.request('/api/workspace',{method,body:method==='HEAD'?undefined:'not-json'});assert.equal(r.status,503);
    }
    assert.equal((await f.request('/api/customer/me',{headers:{Cookie:''}})).status,401);
    assert.equal((await f.request('/api/customer/me',{headers:{Origin:'https://foreign.invalid'}})).status,403);
    assert.equal((await f.request('/healthz',{headers:{Host:'foreign.invalid'}})).status,403);
  });
});
test('parallel static page assets stay available while only one private read is admitted',async t=>{
  const f=await fixture(t),entered=deferred(),held=deferred(),original=f.app.workspaces.directory.bind(f.app.workspaces);
  await readMode(f,async()=>{
    f.app.workspaces.directory=async(...args)=>{entered.resolve();await held.promise;return original(...args);};
    const reading=f.request('/api/workspace');await entered.promise;
    assert.equal((await f.request('/api/customer/me')).status,503);
    const routes=['/customer/','/customer.js','/customer.css','/delivery-status.css','/adjustments.js','/adjustments.css'];
    assert.deepEqual((await Promise.all(routes.map(route=>f.request(route)))).map(r=>r.status),routes.map(()=>200));
    assert.equal((await f.request('/healthz')).status,200);held.resolve();assert.equal((await reading).status,200);
    await until(()=>f.app.server.resourceStatus().backupPrivateReaders===0);
    assert.equal((await f.request('/api/customer/me')).status,200);
  });
});
test('nested snapshot revokes a read after admission and waits its handler before copying',async t=>{
  const f=await fixture(t),entered=deferred(),held=deferred(),original=f.app.workspaces.directory.bind(f.app.workspaces);
  await readMode(f,async()=>{
    f.app.workspaces.directory=async(...args)=>{entered.resolve();await held.promise;return original(...args);};
    const reading=f.request('/api/workspace');await entered.promise;let copied=false;
    const snapshot=f.app.quietSnapshot(async()=>{copied=true;assert.equal(f.app.server.resourceStatus().backupReadResponses,0);});
    assert.equal(f.app.server.resourceStatus().backupReadOnlyActive,false);
    assert.equal((await f.request('/api/customer/me')).status,503);await delay(20);assert.equal(copied,false);
    held.resolve();const response=await reading;assert.equal(response.status,503);assert(!response.body.includes(f.record.id));
    await snapshot;assert.equal(copied,true);assert.equal((await f.request('/api/customer/me')).status,200);
  });
});
test('aborted read retains its private slot and snapshot drain until async handler settles',async t=>{
  const f=await fixture(t),entered=deferred(),held=deferred(),original=f.app.workspaces.directory.bind(f.app.workspaces);
  await readMode(f,async()=>{
    f.app.workspaces.directory=async(...args)=>{entered.resolve();await held.promise;return original(...args);};
    const req=http.request({host:'127.0.0.1',port:f.app.server.address().port,path:'/api/workspace',headers:{Host:'app.molyvi.com',Cookie:f.cookie}});req.on('error',()=>{});req.end();
    await entered.promise;req.destroy();await delay(20);
    assert.equal(f.app.server.resourceStatus().backupPrivateReaders,1);
    let copied=false;const snapshot=f.app.quietSnapshot(()=>{copied=true;});await delay(20);assert.equal(copied,false);
    held.resolve();await snapshot;assert.equal(f.app.server.resourceStatus().backupPrivateReaders,0);
  });
});
test('failed nested snapshot cannot reopen read mode and next outer lease starts closed',async t=>{
  const f=await fixture(t);await readMode(f,async()=>{
    await assert.rejects(f.app.quietSnapshot(()=>{throw Error('synthetic snapshot failure');}),/synthetic snapshot failure/);
    assert.equal(f.app.server.resourceStatus().backupReadOnlyActive,false);assert.equal((await f.request('/customer/')).status,503);
  });
  await f.app.withBackupResources(async()=>assert.equal((await f.request('/api/customer/me')).status,503));
});
test('shutdown revokes read mode synchronously and cannot reopen after successful snapshot',async t=>{
  const f=await fixture(t),entered=deferred(),held=deferred();
  const backup=f.app.withBackupResources(async()=>{await f.app.quietSnapshot(()=>{});entered.resolve();await held.promise;});
  await entered.promise;const stopping=f.app.stop();assert.equal(f.app.server.resourceStatus().backupReadOnlyActive,false);
  assert.equal((await f.request('/customer/')).status,503);held.resolve();await Promise.all([backup,stopping]);
});
test('oversized workspace is refused before JSON parsing and leaves normal file untouched',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(2097153,120);await fs.writeFile(f.file,bytes);
  await readMode(f,async()=>{const r=await f.request('/api/workspace');assert.equal(r.status,503);assert.match(r.body,/BACKUP_READ_TEMPORARILY_UNAVAILABLE/);});
  assert.deepEqual(await fs.readFile(f.file),bytes);
});
test('workspace response budget refuses a large otherwise valid record',async t=>{
  const f=await fixture(t),record=JSON.parse(await fs.readFile(f.file,'utf8'));record.tasks.branding.draft.syntheticPadding='x'.repeat(1100000);await fs.writeFile(f.file,JSON.stringify(record));
  await readMode(f,async()=>{const r=await f.request('/api/workspace');assert.equal(r.status,503);assert(r.body.length<1000);});
});
for(const field of ['ownerId','id'])test(`bounded workspace read rejects a foreign ${field}`,async t=>{
  const f=await fixture(t),record=JSON.parse(await fs.readFile(f.file,'utf8'));record[field]=crypto.randomUUID();await fs.writeFile(f.file,JSON.stringify(record));
  await readMode(f,async()=>{const r=await f.request('/api/workspace');assert.equal(r.status,403);assert(!r.body.includes(record[field]));});
});
test('foreign async context cannot run a snapshot or reopen reads during another backup',async t=>{
  const f=await fixture(t),entered=deferred(),held=deferred();
  const backup=f.app.withBackupResources(async()=>{await f.app.quietSnapshot(()=>{});entered.resolve();await held.promise;});
  await entered.promise;await assert.rejects(f.app.quietSnapshot(()=>assert.fail('foreign callback executed')),/BUSY/);
  held.resolve();await backup;assert.equal(f.app.server.resourceStatus().backupReadOnlyActive,false);
});
test('workspace growth during the same-fd read is rejected before any data is sent',async t=>{
  const f=await fixture(t),original=fs.open;let changed=false;
  await readMode(f,async()=>{
    fs.open=async(...args)=>{
      const handle=await original(...args);
      if(path.resolve(String(args[0]))!==path.resolve(f.file))return handle;
      return new Proxy(handle,{get(target,key){
        if(key==='read')return async(...readArgs)=>{const result=await target.read(...readArgs);if(!changed){changed=true;await fs.appendFile(f.file,' ');}return result;};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
    };
    try{const response=await f.request('/api/workspace');assert.equal(response.status,503);assert(!response.body.includes(f.record.id));}
    finally{fs.open=original;}
  });
  assert.equal(changed,true);
});
for(const kind of ['projects','deliveries','operatorProjects'])test(`account view bounds ${kind} before unbounded projection`,async t=>{
  const f=await fixture(t);
  if(kind==='projects')for(let i=0;i<32;i++)f.app.accounts.grant({accountId:f.account.id,projectId:crypto.randomUUID(),ownerId:crypto.randomUUID(),label:'Synthetic',orderId:'SYNTHETIC'});
  if(kind==='deliveries')for(let i=0;i<129;i++)f.app.accounts.registerDelivery({projectId:f.record.id,manifestHash:crypto.createHash('sha256').update(String(i)).digest('hex'),zipHash:'a'.repeat(64)});
  if(kind==='operatorProjects')for(let i=0;i<33;i++){
    const accountId=f.app.accounts.provision({address:`operator-bound-${i}@example.invalid`,name:'Synthetic other'}).id,projectId=crypto.randomUUID();
    f.app.accounts.grant({accountId,projectId,ownerId:crypto.randomUUID(),label:'Synthetic',orderId:'SYNTHETIC'});
    f.app.accounts.db.prepare('INSERT INTO feedback_operator_grants VALUES(?,?,?,?)').run(f.account.id,projectId,'Synthetic',Date.now());
  }
  let views=0;const original=f.app.accounts.view.bind(f.app.accounts);f.app.accounts.view=(...args)=>{views++;return original(...args);};
  await readMode(f,async()=>assert.equal((await f.request('/api/customer/me')).status,503));
  assert.equal(views,0);
});
