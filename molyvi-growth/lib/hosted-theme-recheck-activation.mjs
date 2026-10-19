import fs from 'node:fs/promises';
import path from 'node:path';
import {HOSTED_THEME_RECHECK_PROBE_ROOT,loadHostedThemeRecheckProbe} from './hosted-theme-recheck-probe.mjs';

export const HOSTED_THEME_RECHECK_ACTIVATION_FILE=path.join(HOSTED_THEME_RECHECK_PROBE_ROOT,'activation.json');
// This is an operator-created, single-use synthetic permit, not a customer
// queue or authorization to make Shopify requests. It has no public route.
export async function loadHostedThemeRecheckActivation(){
  let stat;try{stat=await fs.lstat(HOSTED_THEME_RECHECK_ACTIVATION_FILE);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024)throw Error('THEME_PROBE_ACTIVATION_INVALID');
  let current=path.parse(HOSTED_THEME_RECHECK_ACTIVATION_FILE).root;
  for(const bit of path.dirname(HOSTED_THEME_RECHECK_ACTIVATION_FILE).slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,bit);const s=await fs.lstat(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('THEME_PROBE_ACTIVATION_INVALID');
  }
  const raw=await fs.readFile(HOSTED_THEME_RECHECK_ACTIVATION_FILE);if(raw.length!==stat.size)throw Error('THEME_PROBE_ACTIVATION_CHANGED');
  const p=JSON.parse(raw);
  if(Object.keys(p).sort().join(',')!=='configSha256,jobId,mode,schemaVersion'||p.schemaVersion!==1||p.mode!=='synthetic_theme_rechecks'||typeof p.jobId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(p.jobId)||typeof p.configSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.configSha256))throw Error('THEME_PROBE_ACTIVATION_INVALID');
  return loadHostedThemeRecheckProbe({configFile:path.join(HOSTED_THEME_RECHECK_PROBE_ROOT,'jobs',p.jobId,'config.json'),configSha256:p.configSha256});
}
