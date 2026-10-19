import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {createHostedCustomerServer} from '../hosted-customer-server.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';

const origin='https://molyvi-preparation-test.onrender.com';
async function fixture(t){
  const storage=path.join(PRIVATE_ROOT,`_preparation-http-${crypto.randomUUID()}`);
  const app=await createHostedCustomerServer({storage,publicOrigin:origin});
  t.after(async()=>{await app.stop();const base=await fs.realpath(PRIVATE_ROOT),target=await fs.realpath(storage),relative=path.relative(base,target);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('_preparation-http-'));await fs.rm(target,{recursive:true});});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const sample=createBasicAssemblyFixture({productCount:10,sizeProductCount:2});
  await app.workspaces.create(sample.record);
  const account=app.accounts.provision({address:'preparation@example.invalid',name:'Synthetic preparation'});
  await app.deliveries.grantProject({accountId:account.id,projectId:sample.record.id,ownerId:sample.record.ownerId,label:'Synthetic preparation'});
  const request=(route,{method='GET',headers={},value}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:route,method,headers:{Host:new URL(origin).host,...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode,headers:res.headers,body});});});req.on('error',reject);req.end(value===undefined?undefined:JSON.stringify(value));
  });
  const post=(route,value,headers={})=>request(route,{method:'POST',value,headers:{Origin:origin,'Content-Type':'application/json',...headers}});
  const login=await post('/api/customer/login',{address:account.email,code:app.accounts.issueCode(account.id)});
  assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0];
  const me=await request('/api/customer/me',{headers:{Cookie:cookie}}),headers={Cookie:cookie,'X-Molyvi-Csrf':me.body.csrfToken};
  return {app,storage,sample,request,post,headers};
}

test('authenticated readiness is read-only; acknowledgement deduplicates exact ten-product roster without changing workspace',async t=>{
  const f=await fixture(t),source=path.join(f.storage,'workspaces',f.sample.record.id,'workspace.json'),before=await fs.readFile(source),receiptRoot=path.join(f.storage,'controlled-operations','basic-preparation');
  const config=await f.request('/api/service-config');assert.equal(config.body.basicPreparationEnabled,true);
  const state=await f.request('/api/basic-preparation',{headers:f.headers});assert.equal(state.status,200);assert.equal(state.body.readiness.ready,true);assert.equal(state.body.readiness.summary.products,10);
  assert.equal(state.body.installationEnabled,false);assert.equal(state.body.published,false);
  await assert.rejects(fs.stat(receiptRoot),{code:'ENOENT'});
  const command={expectedSourceHash:state.body.sourceHash,acknowledged:true};
  const responses=await Promise.all([f.post('/api/basic-preparation-request',command,f.headers),f.post('/api/basic-preparation-request',command,f.headers)]);
  for(const response of responses)assert.equal(response.status,200,JSON.stringify(response.body));
  const saved=await f.request('/api/basic-preparation',{headers:f.headers});assert(saved.body.request?.requestId);assert.equal(saved.body.request.sourceHash,state.body.sourceHash);
  assert.deepEqual(await fs.readFile(source),before);
  const publicJson=JSON.stringify(saved.body);assert(!publicJson.includes(f.sample.record.ownerId));assert(!publicJson.includes(f.storage));assert(!publicJson.includes('providerResult'));
  assert.equal(f.app.basicInstaller,null);assert.equal(f.app.themeRechecks,null);
  assert.equal(f.app.accounts.db.prepare('SELECT count(*) n FROM mail_outbox').get().n,0);
});

test('preparation endpoints enforce session, CSRF, Origin, selected ownership and exact body schema',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/basic-preparation')).status,401);
  const state=(await f.request('/api/basic-preparation',{headers:f.headers})).body,command={expectedSourceHash:state.sourceHash,acknowledged:true};
  assert.equal((await f.post('/api/basic-preparation-request',command,{Cookie:f.headers.Cookie})).status,403);
  assert.equal((await f.post('/api/basic-preparation-request',command,{...f.headers,Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await f.request('/api/basic-preparation?projectId='+crypto.randomUUID(),{headers:f.headers})).status,400);
  for(const key of ['ownerId','projectId','targetStore','buildEnabled','storage','provider','authorization','budget','publish']){
    assert.equal((await f.post('/api/basic-preparation-request',{...command,[key]:'injected'},f.headers)).status,400,key);
  }
  assert.equal((await f.post('/api/basic-preparation-request',{...command,acknowledged:false},f.headers)).status,400);
  assert.equal((await f.post('/api/basic-preparation-request',{...command,expectedSourceHash:'0'.repeat(64)},f.headers)).status,409);
  assert.equal((await f.post('/api/basic-preparation-execute',{},f.headers)).status,404);
  assert.equal((await f.post('/api/basic-preparation-install',{},f.headers)).status,404);
  assert.equal((await f.post('/api/customer/select',{projectId:crypto.randomUUID()},f.headers)).status,404);
  const resume=await f.app.server.pauseForBackup();try{assert.equal((await f.post('/api/basic-preparation-request',command,f.headers)).status,503);}finally{resume();}
  const stat=await f.request('/api/basic-preparation',{headers:f.headers});assert.equal(stat.body.request,null);
});

test('readiness script is served with private no-store page and no dynamic customer HTML',async t=>{
  const f=await fixture(t),page=await f.request('/workspace/'),script=await f.request('/basic-preparation.js');
  assert.equal(page.status,200);assert.match(page.body,/basic-preparation\.js/);assert.match(page.body,/id="basic-preparation"/);
  assert.equal(script.status,200);assert(!script.body.includes('innerHTML'));assert.match(script.body,/expectedSourceHash/);
});

test('composition lease blocks mutations and audited downloads while keeping authenticated progress readable',async t=>{
  const f=await fixture(t),before=f.app.accounts.db.prepare('SELECT count(*) n FROM audit').get().n;
  const release=await f.app.server.pauseForPreparation();
  try{
    assert.equal((await f.post('/api/basic-preparation-request',{},f.headers)).body.error,'PREPARATION_IN_PROGRESS');
    assert.equal((await f.request('/customer-files/'+f.sample.record.id+'/archive.zip',{headers:f.headers})).status,503);
    assert.equal((await f.request('/operator-revision-files/'+f.sample.record.id+'/archive.zip',{headers:f.headers})).status,503);
    assert.equal((await f.request('/x/../customer-files/'+f.sample.record.id+'/archive.zip',{headers:f.headers})).status,503);
    assert.equal((await f.request('/x/%2e%2e/operator-revision-files/'+f.sample.record.id+'/archive.zip',{headers:f.headers})).status,503);
    assert.equal((await f.request('/api/operator/adjustment-preview',{headers:f.headers})).status,503);
    const progress=await f.request('/api/basic-preparation',{headers:f.headers});assert.equal(progress.status,200);assert.equal(progress.body.request,null);
    assert.equal((await f.request('/workspace/')).status,200);
    assert.equal(f.app.accounts.db.prepare('SELECT count(*) n FROM audit').get().n,before);
  }finally{release();release();}
  assert.equal((await f.request('/api/basic-preparation',{headers:f.headers})).status,200);
});
