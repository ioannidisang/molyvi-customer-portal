// One operator-created permit for the existing test store. No public route.
import fs from 'node:fs/promises';
import path from 'node:path';
import {PRIVATE_ROOT} from './intake-store.mjs';
export const HOSTED_BASIC_INSTALLER_ACTIVATION_FILE=path.join(PRIVATE_ROOT,'molyvi-hosted-staging','controlled-operations','basic-installer','activation.json');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export async function loadHostedBasicInstallerActivation(){
  let info;try{info=await fs.lstat(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2048)throw Error('BASIC_ACTIVATION_INVALID');
  let current=path.parse(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE).root;
  for(const bit of path.dirname(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE).slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,bit);const st=await fs.lstat(current);if(st.isSymbolicLink()||!st.isDirectory())throw Error('BASIC_ACTIVATION_INVALID');
  }
  const raw=await fs.readFile(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE);if(raw.length!==info.size)throw Error('BASIC_ACTIVATION_CHANGED');
  const p=JSON.parse(raw);
  if(Object.keys(p).sort().join(',')!=='configSha256,jobId,mode,packageSha256,projectId,receiverSha256,schemaVersion'||p.schemaVersion!==1||p.mode!=='real_basic_draft_test'||!uuid(p.jobId)||!uuid(p.projectId)||!['configSha256','packageSha256','receiverSha256'].every(k=>hash(p[k])))throw Error('BASIC_ACTIVATION_INVALID');
  if(process.env.RENDER_SERVICE_ID!=='srv-db7othjrjlhs73cg7lf0')throw Error('BASIC_ACTIVATION_SERVICE_MISMATCH');
  const [{loadHostedBasicInstaller},{readExactToken}]=await Promise.all([import('./hosted-basic-installer.mjs'),import('./hosted-basic-installer-access.mjs')]);
  const configFile=path.join(path.dirname(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE),'jobs',p.projectId,'config.json');
  const worker=await loadHostedBasicInstaller({configFile,configSha256:p.configSha256,networkEnabled:true,
    getAccessToken:async()=>{const token=await readExactToken({runId:p.jobId,packageSha256:p.packageSha256,receiverSha256:p.receiverSha256});return token.accessToken;}});
  if(worker.config.jobId!==p.jobId||worker.config.projectId!==p.projectId||worker.config.bundleSha256!==p.packageSha256)throw Error('BASIC_ACTIVATION_BINDING_MISMATCH');
  return worker;
}
