import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PRIVATE_ROOT,canonicalJson} from './intake-store.mjs';

export const REFERENCE_PIPELINE_KIND='molyvi_basic_reference_pipeline_1005_v1';
export const REFERENCE_PIPELINE_PROJECT='4923cd43-11b7-47ed-a912-1b06458a6557';
export const REFERENCE_PIPELINE_OWNER='a83f86bc-85dd-41cb-9f08-9db072c695b9';
export const REFERENCE_PIPELINE_SERVICE='srv-db7othjrjlhs73cg7lf0';
export const REFERENCE_PIPELINE_ROOT=path.join(PRIVATE_ROOT,'molyvi-hosted-staging','controlled-operations','basic-reference-1005-r2');
export const REFERENCE_PIPELINE_PERMIT=path.join(REFERENCE_PIPELINE_ROOT,'resume-r4','permit.json');
const authorities=new WeakSet(),hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===k.sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export const requireReferencePipeline=(ok,code)=>{if(!ok){const e=new Error('BASIC_REFERENCE_PIPELINE_'+code);e.code=e.message;throw e;}};
const need=requireReferencePipeline;
export function validateReferencePipelinePermit(p,{release,now=Date.now(),active=false}={}){
 need(exact(p,['schemaVersion','kind','serviceId','release','projectId','ownerId','sourceHash','authorizationSha256','credentialReference','createdAt','expiresAt','publicationAuthorized','newChargesAuthorized','permitHash',...(p?.resumeSha256?['resumeSha256']:[])]),'PERMIT_FIELDS');
 need(p.schemaVersion===1&&p.kind===REFERENCE_PIPELINE_KIND&&p.serviceId===REFERENCE_PIPELINE_SERVICE&&p.projectId===REFERENCE_PIPELINE_PROJECT&&p.ownerId===REFERENCE_PIPELINE_OWNER&&/^[a-f0-9]{40}$/.test(p.release)&&(!release||p.release===release)&&p.publicationAuthorized===false&&p.newChargesAuthorized===false,'PERMIT_SCOPE');
 need([p.sourceHash,p.authorizationSha256,p.permitHash,...(p.resumeSha256?[p.resumeSha256]:[])].every(hex),'PERMIT_HASH');
 const c=p.credentialReference;need(exact(c,['runId','packageSha256','receiverSha256'])&&uuid(c.runId)&&hex(c.packageSha256)&&hex(c.receiverSha256)&&c.packageSha256===p.sourceHash,'CREDENTIAL_SCOPE');
 const from=Date.parse(p.createdAt),to=Date.parse(p.expiresAt);
 need(Number.isFinite(from)&&Number.isFinite(to)&&new Date(from).toISOString()===p.createdAt&&new Date(to).toISOString()===p.expiresAt&&to>from&&to-from<=6*3600000,'PERMIT_WINDOW');
 if(active)need(now>=from&&now<to,'PERMIT_EXPIRED');
 const {permitHash,...body}=p;need(hash(body)===permitHash,'PERMIT_HASH');return structuredClone(p);
}
export async function readReferencePipelineRecord(file,max=256*1024){
 const absolute=path.resolve(file);let at=path.parse(absolute).root;
 for(const bit of absolute.slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at);need(!s.isSymbolicLink()&&(at===absolute?s.isFile()&&s.nlink===1:s.isDirectory()),'PRIVATE_PATH');}
 const before=await fs.stat(absolute);need(before.size<=max,'RECORD_LIMIT');const raw=await fs.readFile(absolute),after=await fs.stat(absolute);need(raw.length===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ino===after.ino,'RECORD_CHANGED');return JSON.parse(raw);
}
export async function loadReferencePipelinePermit(){
 try{await fs.lstat(REFERENCE_PIPELINE_PERMIT);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 need(process.platform==='linux'&&process.env.RENDER_SERVICE_ID===REFERENCE_PIPELINE_SERVICE,'HOST_SCOPE');
 return validateReferencePipelinePermit(await readReferencePipelineRecord(REFERENCE_PIPELINE_PERMIT),{release:process.env.RENDER_GIT_COMMIT});
}
export async function createReferencePipelineAuthority({permit,store,storage,buildRoot}){
 const current=await loadReferencePipelinePermit();need(current&&hash(current)===hash(permit),'PERMIT_CHANGED');
 need(store.storage===path.join(PRIVATE_ROOT,'molyvi-hosted-staging','workspaces')&&storage===path.join(REFERENCE_PIPELINE_ROOT,'receipts')&&buildRoot===path.join(REFERENCE_PIPELINE_ROOT,'builds'),'STORAGE_SCOPE');
 const authority=Object.freeze({store,storage,buildRoot});authorities.add(authority);return authority;
}
export function allowsReferencePipelineAuthority(authority,{store,storage,buildRoot}){
 return authorities.has(authority)&&authority.store===store&&authority.storage===storage&&authority.buildRoot===buildRoot;
}
