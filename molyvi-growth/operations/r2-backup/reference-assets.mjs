// Explicit opt-in image byte storage for reference backups. No application
// imports, automatic activation, migration, cleanup, network or provider API.
// Binding/manifest pins must come from the trusted backup/session owner: a hash
// proves content equality, not customer authority. Header checks do NOT decode
// images or certify their appearance. ZIP/database/mail remain outside this vault.
import fs from 'node:fs/promises';
import {constants,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const ASSET_VAULT_LIMITS=Object.freeze({files:131,fileBytes:10*1024*1024,logicalBytes:128*1024*1024,manifestBytes:1024*1024});
const LIMITS=ASSET_VAULT_LIMITS;
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const roles=new Set(['original','selected','logo','delivery']);
const extensions=Object.freeze({'image/png':['.png'],'image/jpeg':['.jpg','.jpeg'],'image/webp':['.webp']});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(value,code)=>{if(!value)fail(code);};
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.split(',').sort().join(',');
const equalPath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const normalize=value=>path.resolve(value);

function safeRelative(value){
  check(typeof value==='string'&&value.length>0&&value.length<=240&&!/[\\:\x00-\x1f?#<>|"*]/.test(value)&&!path.isAbsolute(value),'UNSAFE_PATH');
  check(value.split('/').length<=16,'PATH_DEPTH_LIMIT');
  for(const part of value.split('/')){
    check(part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),'UNSAFE_PATH');
  }
  return value;
}
function checkedBinding(value){
  check(keys(value,'ownerHash,projectId,selectionHash')&&HASH.test(value.ownerHash)&&UUID.test(value.projectId)&&HASH.test(value.selectionHash),'INVALID_BINDING');
  return Object.freeze({...value});
}
function sameBinding(actual,expected){
  checkedBinding(actual);
  check(actual.ownerHash===expected.ownerHash&&actual.projectId===expected.projectId&&actual.selectionHash===expected.selectionHash,'BINDING_MISMATCH');
}
function disjoint(a,b){
  a=normalize(a);b=normalize(b);
  for(const [first,second] of [[a,b],[b,a]]){
    const relative=path.relative(first,second);
    check(relative&&(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)),'OVERLAPPING_ROOTS');
  }
}
async function directory(value){
  const target=normalize(value),parsed=path.parse(target);let current=parsed.root;
  for(const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const stat=await fs.lstat(current);
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_DIRECTORY');
  }
  check(equalPath(await fs.realpath(target),target),'DIRECTORY_ALIAS');
  return target;
}
async function newDirectory(value){
  const target=normalize(value);await directory(path.dirname(target));
  await fs.mkdir(target,{mode:0o700});
  return directory(target);
}
function signature(stat){
  return {dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
}
function checkedStat(stat){
  check(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'UNSAFE_FILE');
  check(Number.isSafeInteger(stat.size)&&stat.size>=0&&stat.size<=LIMITS.logicalBytes,'FILE_SIZE_LIMIT');
  return signature(stat);
}
const sameStat=(a,b)=>Object.keys(a).every(key=>a[key]===b[key]);
async function opened(root,name,maxBytes){
  safeRelative(name);let current=await directory(root),parts=name.split('/');
  for(const part of parts.slice(0,-1)){current=path.join(current,part);await directory(current);}
  const file=path.join(current,parts.at(-1)),before=checkedStat(await fs.lstat(file));
  check(before.size<=maxBytes,'FILE_SIZE_LIMIT');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    check(sameStat(before,checkedStat(await handle.stat())),'FILE_CHANGED');
    return {handle,file,before};
  }catch(error){await handle.close();throw error;}
}
async function unchanged(read){
  check(sameStat(read.before,checkedStat(await read.handle.stat()))&&sameStat(read.before,checkedStat(await fs.lstat(read.file))),'FILE_CHANGED');
}
function headerMediaType(bytes){
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
async function digestFile(root,name,maxBytes=LIMITS.fileBytes){
  const read=await opened(root,name,maxBytes),h=crypto.createHash('sha256');let bytes=0,prefix=Buffer.alloc(0);
  try{
    for await(const chunk of read.handle.createReadStream({start:0,autoClose:false,highWaterMark:65536})){
      if(prefix.length<12)prefix=Buffer.concat([prefix,chunk.subarray(0,12-prefix.length)]);
      bytes+=chunk.length;check(bytes<=maxBytes,'FILE_SIZE_LIMIT');h.update(chunk);
    }
    await unchanged(read);check(bytes===read.before.size,'FILE_CHANGED');
    return {bytes,sha256:h.digest('hex'),mediaType:headerMediaType(prefix),stat:read.before};
  }finally{await read.handle.close();}
}
async function boundedRead(root,name,maxBytes){
  const read=await opened(root,name,maxBytes);
  try{
    // Fixed initial-size allocation; a concurrently growing file cannot force a
    // larger readFile() allocation before the mutation check.
    const bytes=Buffer.alloc(read.before.size);let offset=0;
    while(offset<bytes.length){
      const result=await read.handle.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);
      check(result.bytesRead>0,'FILE_CHANGED');offset+=result.bytesRead;
    }
    const probe=Buffer.alloc(1);check((await read.handle.read(probe,0,1,offset)).bytesRead===0,'FILE_CHANGED');
    await unchanged(read);return bytes;
  }finally{await read.handle.close();}
}
async function writeNew(file,bytes){
  await directory(path.dirname(file));
  const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try{await handle.writeFile(bytes);await handle.sync();check(checkedStat(await handle.stat()).size===bytes.length,'WRITE_CHANGED');}
  finally{await handle.close();}
}
async function copyExact(fromRoot,fromName,toRoot,toName,expected){
  const read=await opened(fromRoot,fromName,LIMITS.fileBytes);safeRelative(toName);
  const destination=path.join(toRoot,...toName.split('/'));
  await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await directory(path.dirname(destination));
  let bytes=0;const h=crypto.createHash('sha256');
  try{
    const guard=new Transform({transform(chunk,encoding,callback){
      bytes+=chunk.length;if(bytes>expected.bytes||bytes>LIMITS.fileBytes)return callback(Object.assign(new Error('COPY_SIZE_MISMATCH'),{code:'COPY_SIZE_MISMATCH'}));
      h.update(chunk);callback(null,chunk);
    }});
    await pipeline(read.handle.createReadStream({start:0,autoClose:false,highWaterMark:65536}),guard,createWriteStream(destination,{flags:'wx',mode:0o600,highWaterMark:65536}));
    check(bytes===expected.bytes&&h.digest('hex')===expected.sha256,'COPY_HASH_MISMATCH');await unchanged(read);
    // Windows FlushFileBuffers requires a writable handle. This is only the
    // fresh destination created above, never the immutable source object.
    const target=await fs.open(destination,constants.O_RDWR|(constants.O_NOFOLLOW??0));
    try{check(checkedStat(await target.stat()).size===expected.bytes,'WRITE_CHANGED');await target.sync();}finally{await target.close();}
    const actual=await digestFile(toRoot,toName);check(actual.bytes===expected.bytes&&actual.sha256===expected.sha256,'COPY_HASH_MISMATCH');
  }finally{await read.handle.close();}
}
async function inventory(root){
  root=await directory(root);const files=[];let visited=0;
  async function walk(prefix=''){
    for await(const item of await fs.opendir(await directory(path.join(root,prefix)))){
      const name=safeRelative(prefix?prefix+'/'+item.name:item.name),target=path.join(root,...name.split('/'));
      visited++;check(visited<=LIMITS.files*16+2,'TREE_ENTRY_LIMIT');
      const stat=await fs.lstat(target);check(!stat.isSymbolicLink(),'UNSAFE_FILE');
      if(stat.isDirectory()){await directory(target);await walk(name);}
      else{files.push({file:name,...checkedStat(stat)});check(files.length<=LIMITS.files+2,'VAULT_FILE_COUNT_LIMIT');}
    }
  }
  await walk();return files.sort((a,b)=>a.file.localeCompare(b.file,'en'));
}
function fileEntries(entries,{source=false}={}){
  check(Array.isArray(entries)&&entries.length>0&&entries.length<=LIMITS.files,'ENTRY_COUNT_LIMIT');
  const seen=new Set();let total=0;
  const checked=entries.map(entry=>{
    check(keys(entry,source?'logicalPath,sourcePath,role,versionId,mediaType,bytes,sha256':'logicalPath,role,versionId,mediaType,bytes,sha256'),'INVALID_ENTRY');
    safeRelative(entry.logicalPath);if(source)safeRelative(entry.sourcePath);
    const folded=entry.logicalPath.toLowerCase();check(!seen.has(folded),'DUPLICATE_LOGICAL_PATH');seen.add(folded);
    check(roles.has(entry.role)&&typeof entry.versionId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(entry.versionId),'INVALID_ENTRY');
    // Existing workspace image names are .bin. Their explicit, pinned type
    // must still agree with actual bytes; .bin is not permission for opaque data.
    const extension=path.posix.extname(entry.logicalPath).toLowerCase();
    check(Object.hasOwn(extensions,entry.mediaType)&&(extension==='.bin'||extensions[entry.mediaType].includes(extension)),'IMAGE_TYPE_MISMATCH');
    check(HASH.test(entry.sha256)&&Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<=LIMITS.fileBytes,'INVALID_ENTRY');
    total+=entry.bytes;check(total<=LIMITS.logicalBytes,'LOGICAL_SIZE_LIMIT');
    return {...entry};
  });
  const paths=[...seen];
  for(const value of paths)check(!paths.some(other=>other!==value&&value.startsWith(other+'/')),'LOGICAL_PATH_COLLISION');
  return checked.sort((a,b)=>a.logicalPath.localeCompare(b.logicalPath,'en'));
}
function expectedObjects(files){
  const objects=new Map();
  for(const file of files){
    const previous=objects.get(file.sha256);
    check(!previous||(previous.bytes===file.bytes&&previous.mediaType===file.mediaType),'HASH_SIZE_CONFLICT');
    objects.set(file.sha256,{sha256:file.sha256,bytes:file.bytes,mediaType:file.mediaType,file:`objects/${file.sha256}.bin`});
  }
  return [...objects.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256,'en'));
}
function parseManifest(raw,binding,expectedSha256){
  check(HASH.test(expectedSha256)&&hash(raw)===expectedSha256,'MANIFEST_HASH_MISMATCH');
  const m=JSON.parse(raw);
  check(keys(m,'schemaVersion,kind,binding,sourceInventoryHash,files,objects,logicalBytes,uniqueBytes,scope')&&m.schemaVersion===1&&m.kind==='molyvi_reference_asset_vault','INVALID_MANIFEST');
  sameBinding(binding,m.binding);checkedBinding(m.binding);
  check(HASH.test(m.sourceInventoryHash)&&m.scope==='EXPLICIT_CALLER_BOUND_NO_AUTOMATIC_ACTIVATION','INVALID_MANIFEST');
  const files=fileEntries(m.files),objects=expectedObjects(files);
  check(JSON.stringify(files)===JSON.stringify(m.files)&&JSON.stringify(objects)===JSON.stringify(m.objects),'INVALID_MANIFEST');
  check(m.logicalBytes===files.reduce((n,f)=>n+f.bytes,0)&&m.uniqueBytes===objects.reduce((n,f)=>n+f.bytes,0),'INVALID_MANIFEST');
  return m;
}
async function pinnedVault(root,manifest,rawHash,{content=true}={}){
  const top=[];
  for await(const entry of await fs.opendir(await directory(root))){top.push(entry);check(top.length<=2,'VAULT_INVENTORY_MISMATCH');}
  check(top.length===2&&top.some(e=>e.name==='manifest.json'&&e.isFile())&&top.some(e=>e.name==='objects'&&e.isDirectory()),'VAULT_INVENTORY_MISMATCH');
  const objectNames=[];
  for await(const entry of await fs.opendir(await directory(path.join(root,'objects')))){objectNames.push(entry);check(objectNames.length<=manifest.objects.length,'VAULT_INVENTORY_MISMATCH');}
  check(objectNames.length===manifest.objects.length&&objectNames.every(e=>e.isFile()&&/^[a-f0-9]{64}\.bin$/.test(e.name)),'VAULT_INVENTORY_MISMATCH');
  const rows=await inventory(root),expected=['manifest.json',...manifest.objects.map(x=>x.file)].sort();
  check(JSON.stringify(rows.map(x=>x.file).sort())===JSON.stringify(expected),'VAULT_INVENTORY_MISMATCH');
  check(hash(await boundedRead(root,'manifest.json',LIMITS.manifestBytes))===rawHash,'MANIFEST_HASH_MISMATCH');
  if(content)for(const object of manifest.objects){
    const actual=await digestFile(root,object.file);check(actual.bytes===object.bytes&&actual.sha256===object.sha256,'BLOB_HASH_MISMATCH');
    check(actual.mediaType===object.mediaType,'IMAGE_TYPE_MISMATCH');
  }
  return rows;
}
export async function createAssetVault({sourceDirectory,vaultDirectory,binding,entries}){
  binding=checkedBinding(binding);entries=fileEntries(entries,{source:true});
  const source=await directory(sourceDirectory),target=normalize(vaultDirectory);disjoint(source,target);
  const sourceRows=[];
  for(const entry of entries){
    const actual=await digestFile(source,entry.sourcePath);
    check(actual.bytes===entry.bytes&&actual.sha256===entry.sha256,'SOURCE_HASH_MISMATCH');
    check(actual.mediaType===entry.mediaType,'IMAGE_TYPE_MISMATCH');
    sourceRows.push({sourcePath:entry.sourcePath,logicalPath:entry.logicalPath,...actual});
  }
  const files=entries.map(({sourcePath,...entry})=>entry),objects=expectedObjects(files);
  const manifest={schemaVersion:1,kind:'molyvi_reference_asset_vault',binding,sourceInventoryHash:hash(json(sourceRows)),files,objects,
    logicalBytes:files.reduce((n,f)=>n+f.bytes,0),uniqueBytes:objects.reduce((n,f)=>n+f.bytes,0),scope:'EXPLICIT_CALLER_BOUND_NO_AUTOMATIC_ACTIVATION'};
  const raw=json(manifest);check(raw.length<=LIMITS.manifestBytes,'MANIFEST_SIZE_LIMIT');
  await newDirectory(target);
  for(const object of objects){
    const entry=entries.find(e=>e.sha256===object.sha256);
    await copyExact(source,entry.sourcePath,target,object.file,object);
  }
  // Commit metadata only after all objects and all source pins still match.
  for(const row of sourceRows){
    const actual=await digestFile(source,row.sourcePath);
    check(actual.bytes===row.bytes&&actual.sha256===row.sha256&&sameStat(actual.stat,row.stat),'SOURCE_CHANGED');
  }
  await writeNew(path.join(target,'manifest.json'),raw);
  const manifestSha256=hash(raw);await pinnedVault(target,manifest,manifestSha256);
  return Object.freeze({directory:target,manifestSha256,logicalBytes:manifest.logicalBytes,uniqueBytes:manifest.uniqueBytes,
    manifestBytes:raw.length,physicalBytes:manifest.uniqueBytes+raw.length,logicalFiles:files.length,objects:objects.length,
    savedBytes:manifest.logicalBytes-manifest.uniqueBytes-raw.length,productionAdmission:false});
}
export async function openAssetVault({vaultDirectory,binding,expectedManifestSha256}){
  binding=checkedBinding(binding);const root=await directory(vaultDirectory),raw=await boundedRead(root,'manifest.json',LIMITS.manifestBytes);
  const manifest=parseManifest(raw,binding,expectedManifestSha256),pins=await pinnedVault(root,manifest,expectedManifestSha256);
  let active=false;
  async function validate(){
    const current=await pinnedVault(root,manifest,expectedManifestSha256,{content:false});
    check(JSON.stringify(current)===JSON.stringify(pins),'VAULT_CHANGED');
  }
  async function lease(operation){
    check(!active,'CONCURRENT_READ');active=true;
    try{return await operation();}finally{active=false;}
  }
  return Object.freeze({
    manifestSha256:expectedManifestSha256,
    entries:Object.freeze(manifest.files.map(row=>Object.freeze({...row}))),
    async withAsset({binding:context,logicalPath,versionId},consumer){
      sameBinding(context,binding);check(typeof consumer==='function','CONSUMER_REQUIRED');safeRelative(logicalPath);
      const entry=manifest.files.find(row=>row.logicalPath===logicalPath&&row.versionId===versionId);check(entry,'REFERENCE_NOT_FOUND');
      return lease(async()=>{
        await validate();const bytes=await boundedRead(root,`objects/${entry.sha256}.bin`,LIMITS.fileBytes);
        check(bytes.length===entry.bytes&&hash(bytes)===entry.sha256,'BLOB_HASH_MISMATCH');
        check(headerMediaType(bytes)===entry.mediaType,'IMAGE_TYPE_MISMATCH');
        const result=await consumer(Object.freeze({bytes,metadata:Object.freeze({...entry})}));
        check(bytes.length===entry.bytes&&hash(bytes)===entry.sha256,'CONSUMED_BYTES_CHANGED');
        await validate();return result;
      });
    },
    async restore({binding:context,outputDirectory,afterFile}){
      sameBinding(context,binding);check(afterFile===undefined||typeof afterFile==='function','INVALID_OBSERVER');
      const output=normalize(outputDirectory);disjoint(root,output);
      return lease(async()=>{
        await validate();await newDirectory(output);
        for(const [index,entry] of manifest.files.entries()){
          await validate();await copyExact(root,`objects/${entry.sha256}.bin`,output,entry.logicalPath,entry);
          if(afterFile)await afterFile(Object.freeze({index,logicalPath:entry.logicalPath}));
          await validate();
        }
        const rows=await inventory(output);check(rows.length===manifest.files.length,'RESTORE_INVENTORY_MISMATCH');
        for(const entry of manifest.files){
          const actual=await digestFile(output,entry.logicalPath);check(actual.bytes===entry.bytes&&actual.sha256===entry.sha256,'RESTORE_HASH_MISMATCH');
        }
        await validate();
        return Object.freeze({status:'PASS_EXACT_LOGICAL_RESTORE',directory:output,files:rows.length,bytes:manifest.logicalBytes,
          inventoryHash:hash(json(manifest.files.map(({logicalPath,bytes,sha256})=>({file:logicalPath,bytes,sha256})))),
          sourceDeleted:false,productionAdmission:false});
      });
    },
    async revalidate(){return lease(async()=>{await validate();await pinnedVault(root,manifest,expectedManifestSha256);return true;});}
  });
}
