import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WORKSPACE_ROOT} from '../lib/intake-store.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {createBasicAssemblyBinding,prepareBasicStorePackage} from '../lib/basic-store-package.mjs';
import {prepareStoredBasicReferenceComposition} from '../lib/basic-reference-composition.mjs';
import {buildBasicReferenceThemePackage} from '../lib/basic-theme-package.mjs';
import {createBasicInstallation,BASIC_INSTALL_HOSTED_PROFILE,BASIC_INSTALL_PREPARED_PROFILE} from '../lib/basic-installation.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t,{logo=false}={}){
  const f=createBasicAssemblyFixture({productCount:1,...(logo?{logoImage:()=>({bytes:png,name:'brand.png',mime:'image/png'})}:{})});
  const input=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'molyvi-ref-journal-input-'));
  const output=await fs.mkdtemp(path.join(WORKSPACE_ROOT,'briefs','_molyvi-ref-journal-'));
  t.after(async()=>{
    for(const [parent,dir]of [[await fs.realpath(os.tmpdir()),input],[path.join(WORKSPACE_ROOT,'briefs'),output]]){
      assert.equal(path.dirname(await fs.realpath(dir)),await fs.realpath(parent));
      await fs.rm(dir,{recursive:true});
    }
  });
  for(const [items,prefix]of [[f.options.assets,'generated'],[f.options.sourceAssets,'photo'],[f.options.logo?[f.options.logo]:[],'logo']])
    for(const item of items)await fs.writeFile(path.join(input,`${prefix}-${item.asset.id}.bin`),item.bytes,{flag:'wx'});
  await fs.writeFile(path.join(input,'workspace.json'),JSON.stringify(f.record),{flag:'wx'});
  const session={projectId:f.record.id,ownerId:f.record.ownerId};
  const store={serial:async(p,fn)=>{assert.equal(p,session.projectId);return fn();},directory:async p=>{assert.equal(p,session.projectId);return input;}};
  const binding=createBasicAssemblyBinding(f.record,{targetStore:f.options.targetStore});
  const referenceComposition=await prepareStoredBasicReferenceComposition(store,session,{
    targetStore:f.options.targetStore,binding,decodeImage:async(b,{mime})=>({decoded:true,mime,width:1,height:1}),
  });
  const built=await buildBasicReferenceThemePackage(referenceComposition,{outputDirectory:path.join(output,'theme'),compact:true});
  const theme={manifest:built.manifest,zipBytes:await fs.readFile(built.zipPath)};
  const context={projectId:f.record.id,ownerId:f.record.ownerId,targetStore:f.options.targetStore,planHash:referenceComposition.plan.planHash,themeZipSha256:built.zipSha256};
  const common={theme,context,authorization:{projectId:context.projectId,ownerHash:binding.ownerHash,targetStore:context.targetStore,planHash:context.planHash,createOnly:true,publicationAuthorized:false,newChargesAuthorized:false,referenceSha256:'a'.repeat(64)},
    preflightEvidence:{operatorId:'LOCAL_REFERENCE_JOURNAL_TEST',observedAt:new Date().toISOString(),evidenceSha256:'b'.repeat(64),scopeConfirmed:true},
    liveThemeId:'207379235153',inventoryLocationId:'125398417745',currency:'EUR'};
  async function args(name){
    const registryDirectory=path.join(output,`${name}-registry`);await fs.mkdir(registryDirectory);
    return {...common,registryDirectory,directory:path.join(output,`${name}-journal`)};
  }
  return {f,input,output,referenceComposition,args,legacy:()=>prepareBasicStorePackage(f.record,{...f.options,binding})};
}

test('reference journal preserves legacy package hash and steps including logo-first descriptor ordering',async t=>{
  const f=await fixture(t,{logo:true});
  assert(f.referenceComposition.assets.at(-1).fileName.startsWith('branding/'));
  const legacy=await createBasicInstallation({...await f.args('legacy'),prepared:f.legacy()});
  const reference=await createBasicInstallation({...await f.args('reference'),referenceComposition:f.referenceComposition});
  assert.equal(reference.intent.packageBytesHash,legacy.intent.packageBytesHash);
  assert.equal(reference.intent.planHash,legacy.intent.planHash);
  assert.equal(reference.intent.themeZipSha256,legacy.intent.themeZipSha256);
  assert.deepEqual(reference.intent.steps,legacy.intent.steps);
  assert.equal(reference.eventCount,0);assert.equal(reference.intent.newChargesAuthorized,false);
  assert.equal(reference.intent.publicationAuthorized,false);
});

test('reference mode refuses both hosted profiles before creating journal or reservation',async t=>{
  const f=await fixture(t);
  for(const runtimeProfile of [BASIC_INSTALL_HOSTED_PROFILE,BASIC_INSTALL_PREPARED_PROFILE]){
    const args=await f.args(runtimeProfile);
    await assert.rejects(createBasicInstallation({...args,referenceComposition:f.referenceComposition,runtimeProfile}),{code:'BASIC_INSTALL_REFERENCE_HOSTED_PROFILE_NOT_ENABLED'});
    assert.deepEqual(await fs.readdir(args.registryDirectory),[]);
    await assert.rejects(fs.lstat(args.directory),{code:'ENOENT'});
  }
});

test('changed actual source record cannot reserve a reference journal',async t=>{
  const f=await fixture(t),args=await f.args('changed');
  f.f.record.order.reference='changed since preparation';
  await fs.writeFile(path.join(f.input,'workspace.json'),JSON.stringify(f.f.record));
  await assert.rejects(createBasicInstallation({...args,referenceComposition:f.referenceComposition}));
  assert.deepEqual(await fs.readdir(args.registryDirectory),[]);
  await assert.rejects(fs.lstat(args.directory),{code:'ENOENT'});
});

test('copied capability and ambiguous legacy-plus-reference input cannot reserve a journal',async t=>{
  const f=await fixture(t);
  for(const [name,input]of [
    ['copy',{referenceComposition:{...f.referenceComposition}}],
    ['both',{referenceComposition:f.referenceComposition,prepared:f.legacy()}],
  ]){
    const args=await f.args(name);
    await assert.rejects(createBasicInstallation({...args,...input}));
    assert.deepEqual(await fs.readdir(args.registryDirectory),[]);
    await assert.rejects(fs.lstat(args.directory),{code:'ENOENT'});
  }
});
