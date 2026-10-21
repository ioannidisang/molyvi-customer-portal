// Private, expiring startup authority. No HTTP, environment flag or caller
// supplied JSON can turn on the general hosted reference profile.
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const BASIC_INSTALL_PROBE_ROOT='/opt/render/project/src/briefs/molyvi-basic-installation-probe-20261021-r2';
export const BASIC_INSTALL_PROBE_SERVICE='srv-db7othjrjlhs73cg7lf0';
export const BASIC_INSTALL_PROBE_WORKSPACE='tea-d9bnluoqmsqc7399dhfg';
const context=new AsyncLocalStorage();
const check=(v,c)=>{if(!v)throw Error(c);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export function validateBasicInstallProbePermit(p,{release,serviceId,now=Date.now(),checkExpiry=true}={}){
  const keys=['schemaVersion','kind','serviceId','workspaceId','release','runId','expiresAt','fixtureSha256','donors','controls'];
  check(p&&Object.keys(p).sort().join(',')===keys.sort().join(','),'BASIC_INSTALL_PROBE_PERMIT_FIELDS');
  check(p.schemaVersion===1&&p.kind==='molyvi_basic_install_resident_once_v1'&&p.serviceId===BASIC_INSTALL_PROBE_SERVICE&&serviceId===BASIC_INSTALL_PROBE_SERVICE&&p.workspaceId===BASIC_INSTALL_PROBE_WORKSPACE&&/^[a-f0-9]{40}$/.test(release)&&p.release===release&&/^install-[0-9]{14}-[a-f0-9]{8}$/.test(p.runId),'BASIC_INSTALL_PROBE_PERMIT_SCOPE');
  check(Number.isSafeInteger(p.expiresAt)&&(!checkExpiry||p.expiresAt>now&&p.expiresAt<=now+24*3600*1000),'BASIC_INSTALL_PROBE_EXPIRY');
  check(/^[a-f0-9]{64}$/.test(p.fixtureSha256)&&Array.isArray(p.donors)&&p.donors.length===30,'BASIC_INSTALL_PROBE_FIXTURE');
  const seen=new Set();for(const d of p.donors){
    check(d&&Object.keys(d).sort().join(',')==='bytes,file,sha256'&&/^[a-f0-9]{64}$/.test(d.sha256)&&Number.isSafeInteger(d.bytes)&&d.bytes>0&&d.bytes<=10*1024*1024&&!seen.has(d.sha256),'BASIC_INSTALL_PROBE_DONOR');
    check(/^\/opt\/render\/project\/src\/briefs\/molyvi-hosted-staging\/workspaces\/[a-f0-9-]{36}\/generated-[a-f0-9-]{36}\.bin$/.test(d.file),'BASIC_INSTALL_PROBE_DONOR_PATH');seen.add(d.sha256);
  }
  const required=['molyvi-r2-access/automatic.json','molyvi-r2-access/budget.sqlite','molyvi-r2-access/r2-config.json','molyvi-r2-access/retention.json','molyvi-r2-access/generation-format.json','molyvi-r2-automatic/retention.sqlite','molyvi-r2-automatic/schedule.sqlite','molyvi-r2-automatic/generations.sqlite','molyvi-r2-automatic/generations.sqlite.initialized.json'];
  check(Array.isArray(p.controls)&&p.controls.length===required.length&&p.controls.map(x=>x.file).sort().join(',')===required.sort().join(','),'BASIC_INSTALL_PROBE_CONTROLS');
  for(const c of p.controls)check(Object.keys(c).sort().join(',')==='file,sha256'&&/^[a-f0-9]{64}$/.test(c.sha256),'BASIC_INSTALL_PROBE_CONTROLS');
  return p;
}
async function safe(file){
  let at=path.parse(file).root;for(const bit of file.slice(at.length).split(path.sep).filter(Boolean)){
    at=path.join(at,bit);const s=await fs.lstat(at);check(!s.isSymbolicLink()&&(at===file?s.isFile()&&s.nlink===1:s.isDirectory()),'BASIC_INSTALL_PROBE_PRIVATE_PATH');
  }
  const s=await fs.stat(file);check(s.size<=128*1024,'BASIC_INSTALL_PROBE_METADATA_LIMIT');return fs.readFile(file);
}
export async function withHostedBasicInstallReferenceScope({permitHash,store,storage,buildRoot},fn){
  check(process.platform==='linux'&&process.env.RENDER_SERVICE_ID===BASIC_INSTALL_PROBE_SERVICE,'BASIC_INSTALL_PROBE_HOST_REQUIRED');
  check(!context.getStore()&&typeof fn==='function','BASIC_INSTALL_PROBE_SCOPE_ACTIVE');
  const raw=await safe(BASIC_INSTALL_PROBE_ROOT+'/permit.json'),p=validateBasicInstallProbePermit(JSON.parse(raw),{release:process.env.RENDER_GIT_COMMIT,serviceId:process.env.RENDER_SERVICE_ID});
  check(sha(raw)===permitHash,'BASIC_INSTALL_PROBE_PERMIT_CHANGED');
  const attempt=JSON.parse(await safe(BASIC_INSTALL_PROBE_ROOT+'/attempt.json'));
  check(attempt.permitHash===permitHash&&attempt.pid===process.pid&&attempt.release===p.release&&attempt.runId===p.runId,'BASIC_INSTALL_PROBE_ATTEMPT_SCOPE');
  for(const name of ['complete.json','failure.json']){try{await fs.lstat(BASIC_INSTALL_PROBE_ROOT+'/'+name);throw Error('BASIC_INSTALL_PROBE_CONSUMED');}catch(e){if(e.code!=='ENOENT')throw e;}}
  check(store.storage===BASIC_INSTALL_PROBE_ROOT+'/scratch/workspaces'&&storage===BASIC_INSTALL_PROBE_ROOT+'/scratch/receipts'&&buildRoot===BASIC_INSTALL_PROBE_ROOT+'/scratch/builds','BASIC_INSTALL_PROBE_STORAGE_SCOPE');
  const scope={store,storage,buildRoot,expiresAt:p.expiresAt,active:true};
  try{return await context.run(scope,fn);}finally{scope.active=false;}
}
export function allowsHostedBasicInstallReferenceProbe({store,storage,buildRoot}){
  const scope=context.getStore();return Boolean(scope?.active&&Date.now()<scope.expiresAt&&scope.store===store&&scope.storage===storage&&scope.buildRoot===buildRoot);
}
