// LOCAL create-only projection. This is deliberately a different format from
// the legacy package: image bytes remain in the owner-scoped source workspace.
// It cannot be submitted to the deployed installer or authorize provider work.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {WORKSPACE_ROOT,canonicalJson} from './intake-store.mjs';
import {basicStoreCatalogCsv} from './basic-store-package.mjs';
import {verifyBasicReferenceComposition} from './basic-reference-composition.mjs';

export const BASIC_REFERENCE_OUTPUT_LIMITS=Object.freeze({metadataBytes:1024*1024,files:32});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const fail=code=>{throw Object.assign(new Error(`BASIC_REFERENCE_OUTPUT_${code}`),{code:`BASIC_REFERENCE_OUTPUT_${code}`});};
const inside=(root,child)=>{const r=path.relative(root,child);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
async function directory(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)!==value)fail('PATH');
  let current=path.parse(value).root;
  for(const part of value.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const s=await fs.lstat(current);
    if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_DIRECTORY');
  }
  if(await fs.realpath(value)!==value)fail('PATH_ALIAS');
}
async function newDestination(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)!==value||
      !['briefs','customer-materials'].some(name=>inside(path.join(WORKSPACE_ROOT,name),value)))fail('PRIVATE_OUTPUT_REQUIRED');
  await directory(path.dirname(value));
  try{await fs.lstat(value);fail('EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  return value;
}
async function exactOutputFile(file,expected){
  await directory(path.dirname(file));
  const before=await fs.lstat(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(expected.length))fail('OUTPUT_CHANGED');
  const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(k=>a[k]===b[k]);
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    if(!same(before,await handle.stat({bigint:true})))fail('OUTPUT_CHANGED');
    const buffer=Buffer.alloc(expected.length);let offset=0;
    while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)fail('OUTPUT_CHANGED');offset+=bytesRead;}
    if((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead||!buffer.equals(expected))fail('OUTPUT_CHANGED');
    if(!same(before,await handle.stat({bigint:true}))||!same(before,await fs.lstat(file,{bigint:true})))fail('OUTPUT_CHANGED');
    await directory(path.dirname(file));
  }finally{await handle.close();}
}
async function exactInventory(root,expected){
  const names=[];
  async function walk(dir,prefix=''){
    await directory(dir);
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      const name=prefix+e.name,p=path.join(dir,e.name),s=await fs.lstat(p);
      if(s.isSymbolicLink())fail('OUTPUT_CHANGED');
      if(s.isDirectory())await walk(p,name+'/');
      else {if(!s.isFile()||names.length>=BASIC_REFERENCE_OUTPUT_LIMITS.files)fail('OUTPUT_CHANGED');names.push(name);}
    }
  }
  await walk(root);
  if(canonicalJson(names.sort())!==canonicalJson([...expected.keys()].sort()))fail('OUTPUT_CHANGED');
  for(const [name,b] of expected)await exactOutputFile(path.join(root,...name.split('/')),b);
}

export async function writeBasicReferenceMetadataPackage(composition,{outputDirectory}={}){
  const plan=verifyBasicReferenceComposition(composition);
  const destination=await newDestination(outputDirectory);
  await composition.revalidate();
  const files=new Map();
  const add=(name,value)=>{
    if(!/^[a-zA-Z0-9._/-]+$/.test(name)||name.split('/').some(x=>!x||x==='.'||x==='..')||files.has(name))fail('FILE_NAME');
    const b=Buffer.isBuffer(value)?value:Buffer.from(value);files.set(name,b);
  };
  add('package-plan.json',json(plan));
  add('catalog.csv',basicStoreCatalogCsv(plan));
  add('branding.json',json(plan.branding));
  for(const [id,artifact] of Object.entries(plan.operations))add(`operations/${id}.json`,json(artifact));
  for(const page of plan.pages){add(`pages/${page.documentId}.html`,page.bodyHtml);add(`pages/${page.documentId}.txt`,page.bodyText);}
  const assets=structuredClone(composition.assets);
  const referenceBody={
    schemaVersion:1,kind:'molyvi_basic_workspace_image_references_local',
    projectId:plan.projectId,ownerHash:plan.binding.ownerHash,sourceHash:plan.source.recordHash,
    planHash:plan.planHash,assets,applicationAuthorized:false,publicationAuthorized:false,
    retention:'source_files_must_remain_pinned_no_automatic_deletion',
  };
  const referenceHash=sha(canonicalJson(referenceBody));
  add('asset-references.json',json({...referenceBody,referenceHash}));
  add('README.md',`# Molyvi — ιδιωτική σύνθεση με αναφορές\n\n${plan.counts.products} προϊόντα, ${plan.counts.variants} παραλλαγές, ${plan.counts.photos} φωτογραφίες και 7 προσχέδια σελίδων.\n\nΟι εικόνες παραμένουν στον ιδιωτικό φάκελο του συγκεκριμένου έργου. Αυτός ο φάκελος δεν είναι αυτοτελές πακέτο παράδοσης ή εγκατάστασης: απαιτεί τον πιστοποιημένο αναγνώστη και τις ακριβείς πηγές του. Οι αναφορές δεν επιτρέπουν διαγραφή πηγών, εγκατάσταση ή δημοσίευση.\n\nΗ εφαρμογή παραγωγής δεν έχει ενεργοποιήσει αυτή τη μορφή. Τα προσχέδια χρειάζονται τελικό έλεγχο πελάτη και οι λειτουργικές ρυθμίσεις παραμένουν εκκρεμείς.\n`);
  const manifest={
    schemaVersion:1,kind:'molyvi_basic_reference_metadata_package',
    projectId:plan.projectId,planHash:plan.planHash,sourceRecordHash:plan.source.recordHash,referenceHash,
    imageBytesCopied:0,standalone:false,applicationAuthorized:false,publicationAuthorized:false,
    files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([file,b])=>({file,bytes:b.length,sha256:sha(b)})),
  };
  add('manifest.json',json(manifest));
  const totalBytes=[...files.values()].reduce((n,b)=>n+b.length,0);
  if(files.size>BASIC_REFERENCE_OUTPUT_LIMITS.files||totalBytes>BASIC_REFERENCE_OUTPUT_LIMITS.metadataBytes)fail('METADATA_LIMIT');
  // Recheck actual selected bytes before creating output, without retaining any
  // photo after its callback. The source capability checks original materials
  // and immutable record lineage on creation; it is never a caller JSON token.
  for(const asset of assets)await composition.withAsset(asset.fileName,async({bytes,metadata})=>{
    if(metadata.fileName!==asset.fileName||metadata.sha256!==asset.sha256||bytes.length!==asset.bytes||sha(bytes)!==asset.sha256)fail('SOURCE_CHANGED');
  });
  await composition.revalidate();
  if(verifyBasicReferenceComposition(composition).planHash!==plan.planHash)fail('SOURCE_CHANGED');
  await directory(path.dirname(destination));
  await fs.mkdir(destination,{mode:0o700});
  for(const [name,b] of files){
    await composition.revalidate();
    const file=path.join(destination,...name.split('/'));
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    await directory(path.dirname(file));
    await fs.writeFile(file,b,{flag:'wx',mode:0o600});
    await exactOutputFile(file,b);
  }
  await composition.revalidate();
  await exactInventory(destination,files);
  await composition.revalidate();
  return Object.freeze({directory:destination,manifest,manifestSha256:sha(files.get('manifest.json')),referenceHash,
    fileCount:files.size,totalBytes,imageBytesCopied:0,applicationAuthorized:false});
}
