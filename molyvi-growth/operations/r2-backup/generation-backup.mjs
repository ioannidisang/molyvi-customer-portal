// LOCAL codec only. A generation is a complete manifest plus replacements
// relative to one immutable base. It never depends on another generation.
// Descriptors are verified metadata, not authorization capabilities.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {verifyService} from './backup.mjs';

export const GENERATION_BACKUP_LIMITS=Object.freeze({
  sourceBytes:512_000_000,objectBytes:512_000_000,reservedBytes:12*1024*1024,
  metadataBytes:16*1024*1024,files:100_000,chunkBytes:64*1024,diskHeadroomBytes:512_000_000,
});
const L=GENERATION_BACKUP_LIMITS,MAGIC=Buffer.from('MOLYVI-GENERATION-1\n'),PACK=Buffer.from('MOLYVI-GENERATION-PACK-1\n');
const HASH=/^[a-f0-9]{64}$/,DB='accounts/customers.sqlite';
const ROOTS=new Set(['accounts','controlled-operations','controlled-photos','controlled-pro','deliveries','delivery-imports','gmail-journal','hosted-scope.json','mail','regeneration-import-1005-r1','workspaces']);
const check=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const json=v=>Buffer.from(JSON.stringify(v)),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exactKeys=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===n.split(',').sort().join(',');
const sorted=rows=>rows.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
function safeName(value){
  check(typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\\:\x00-\x1f?#<>|"*]/.test(value)&&!path.isAbsolute(value),'GENERATION_PATH');
  const parts=value.split('/');check(parts.length<=24,'GENERATION_PATH');
  for(const p of parts)check(p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),'GENERATION_PATH');
  return value;
}
function scopeValue(scope){
  check(exactKeys(scope,'serviceId,workspaceId')&&Object.values(scope).every(v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v)),'GENERATION_SCOPE');
  return {serviceId:scope.serviceId,workspaceId:scope.workspaceId};
}
function rowsValue(rows,{empty=false}={}){
  check(Array.isArray(rows)&&(empty||rows.length>0)&&rows.length<=L.files,'GENERATION_ENTRIES');
  const seen=new Set();let bytes=0,previous='';
  for(const e of rows){
    check(exactKeys(e,'file,bytes,sha256')&&Number.isSafeInteger(e.bytes)&&e.bytes>=0&&HASH.test(e.sha256),'GENERATION_ENTRY');
    safeName(e.file);check(e.file>previous,'GENERATION_ORDER');previous=e.file;
    const lower=e.file.toLowerCase();check(!seen.has(lower),'GENERATION_COLLISION');seen.add(lower);
    bytes+=e.bytes;check(Number.isSafeInteger(bytes)&&bytes<=L.sourceBytes-L.reservedBytes,'GENERATION_SOURCE_LIMIT');
  }
  for(const file of seen){const parts=file.split('/');while(parts.length>1){parts.pop();check(!seen.has(parts.join('/')),'GENERATION_COLLISION');}}
  return bytes;
}
function manifestValue(m){
  check(m?.schemaVersion===1&&m.kind==='molyvi_private_service_snapshot'&&/^[a-f0-9]{40}$/.test(m.release)&&m.database?.integrity==='ok','GENERATION_MANIFEST');
  check(json(m).length<=L.metadataBytes,'GENERATION_METADATA_LIMIT');
  const bytes=rowsValue(m.files);check(m.files.some(e=>e.file===DB),'GENERATION_DATABASE');
  check(m.files.every(e=>ROOTS.has(e.file.split('/')[0])),'GENERATION_ROOT');return bytes;
}
function identity(d){return {cipherHash:d.cipherHash,cipherBytes:d.cipherBytes,manifestHash:d.manifestHash};}
function descriptorValue(d,kind,scope){
  const fields=kind==='base'?'schemaVersion,format,kind,scope,manifest,manifestHash,cipherHash,cipherBytes,logicalBytes':
    'schemaVersion,format,kind,scope,manifest,manifestHash,cipherHash,cipherBytes,logicalBytes,base,changedFiles,deletedPaths';
  check(exactKeys(d,fields)&&d.schemaVersion===1&&d.format==='MOLYVI-GENERATION-1'&&d.kind===kind,'GENERATION_DESCRIPTOR');
  check(eq(scopeValue(d.scope),scope),'GENERATION_SCOPE_MISMATCH');
  const logicalBytes=manifestValue(d.manifest);check(d.logicalBytes===logicalBytes&&d.manifestHash===sha(json(d.manifest)),'GENERATION_MANIFEST_HASH');
  check(HASH.test(d.cipherHash)&&Number.isSafeInteger(d.cipherBytes)&&d.cipherBytes>MAGIC.length+28&&d.cipherBytes<=L.objectBytes,'GENERATION_OBJECT_LIMIT');
  if(kind==='generation'){
    check(exactKeys(d.base,'cipherHash,cipherBytes,manifestHash')&&HASH.test(d.base.cipherHash)&&HASH.test(d.base.manifestHash)&&Number.isSafeInteger(d.base.cipherBytes)&&d.base.cipherBytes>MAGIC.length+28&&d.base.cipherBytes<=L.objectBytes,'GENERATION_BASE_IDENTITY');
    rowsValue(d.changedFiles,{empty:true});check(Array.isArray(d.deletedPaths)&&d.deletedPaths.length<=L.files,'GENERATION_DELETIONS');
    let previous='';for(const file of d.deletedPaths){safeName(file);check(file>previous,'GENERATION_DELETIONS');previous=file;}
  }
  check(json(d).length<=L.metadataBytes,'GENERATION_METADATA_LIMIT');return d;
}
function diff(base,current){
  const old=new Map(base.files.map(e=>[e.file,e])),now=new Set(current.files.map(e=>e.file));
  return {changedFiles:current.files.filter(e=>!eq(old.get(e.file),e)),deletedPaths:base.files.filter(e=>!now.has(e.file)).map(e=>e.file)};
}
function disjoint(a,b){
  for(const [x,y]of [[path.resolve(a),path.resolve(b)],[path.resolve(b),path.resolve(a)]]){
    const r=path.relative(x,y);check(r&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'GENERATION_OVERLAP');
  }
}
async function directory(value){
  const root=path.resolve(value),parsed=path.parse(root);let at=parsed.root;
  for(const bit of root.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    at=path.join(at,bit);const s=await fs.lstat(at);check(s.isDirectory()&&!s.isSymbolicLink(),'GENERATION_DIRECTORY');
  }
  const real=await fs.realpath(root);check(process.platform==='win32'?real.toLowerCase()===root.toLowerCase():real===root,'GENERATION_ALIAS');return root;
}
async function fresh(value){await directory(path.dirname(value));await fs.mkdir(value,{mode:0o700});return directory(value);}
async function absent(value){try{await fs.lstat(value);throw Error('GENERATION_OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}}
const signature=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
const ordinary=s=>check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.size>=0n&&s.size<=BigInt(L.objectBytes+L.metadataBytes+PACK.length+4),'GENERATION_UNSAFE_FILE');
async function openFile(file){
  file=path.resolve(file);await directory(path.dirname(file));const before=await fs.lstat(file,{bigint:true});ordinary(before);
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const s=await handle.stat({bigint:true});ordinary(s);check(signature(s)===signature(before),'GENERATION_CHANGED');return {handle,file,before};}
  catch(e){await handle.close();throw e;}
}
async function unchanged(r){
  await directory(path.dirname(r.file));const a=await r.handle.stat({bigint:true}),b=await fs.lstat(r.file,{bigint:true});ordinary(a);ordinary(b);
  check(signature(a)===signature(r.before)&&signature(b)===signature(r.before),'GENERATION_CHANGED');
}
async function* range(r,start,length,expected){
  check(Number.isSafeInteger(start)&&Number.isSafeInteger(length)&&start>=0&&length>=0&&start+length<=Number(r.before.size),'GENERATION_RANGE');
  const h=crypto.createHash('sha256'),buffer=Buffer.alloc(L.chunkBytes);let used=0;
  while(used<length){
    const n=await r.handle.read(buffer,0,Math.min(buffer.length,length-used),start+used);check(n.bytesRead>0,'GENERATION_TRUNCATED');
    const bytes=Buffer.from(buffer.subarray(0,n.bytesRead));used+=n.bytesRead;h.update(bytes);yield bytes;
  }
  await unchanged(r);const hash=h.digest('hex');
  if(expected)check(expected.bytes===length&&expected.sha256===hash,'GENERATION_FILE_HASH');
}
async function* fileChunks(root,e){
  const r=await openFile(path.join(root,safeName(e.file)));
  try{check(Number(r.before.size)===e.bytes,'GENERATION_CHANGED');yield*range(r,0,e.bytes,e);}finally{await r.handle.close();}
}
async function digest(file){
  const r=await openFile(file),h=crypto.createHash('sha256');let bytes=0;
  try{for await(const b of range(r,0,Number(r.before.size))){bytes+=b.length;h.update(b);}return {bytes,sha256:h.digest('hex')};}finally{await r.handle.close();}
}
async function inventory(root){
  root=await directory(root);const rows=[];let count=0,total=0;
  async function walk(prefix=''){
    await directory(path.join(root,prefix));
    for await(const e of await fs.opendir(path.join(root,prefix))){
      check(++count<=L.files*2,'GENERATION_ENTRIES');const file=safeName(prefix?`${prefix}/${e.name}`:e.name);
      check(!e.isSymbolicLink(),'GENERATION_UNSAFE_FILE');
      if(e.isDirectory())await walk(file);
      else{check(e.isFile()&&rows.length<L.files,'GENERATION_UNSAFE_FILE');const pin=await digest(path.join(root,file));total+=pin.bytes;check(total<=L.sourceBytes-L.reservedBytes,'GENERATION_SOURCE_LIMIT');rows.push({file,...pin});}
    }
  }
  await walk();sorted(rows);rowsValue(rows);return rows;
}
async function verifySource(root,m){
  check(eq(await inventory(root),m.files),'GENERATION_SOURCE_CHANGED');await verifyService(root,m);
  check(eq(await inventory(root),m.files),'GENERATION_SOURCE_CHANGED');
}
async function freeSpace(parent,needed){
  await directory(parent);const s=await fs.statfs(parent,{bigint:true});
  check(s.bavail*s.bsize>=BigInt(needed+L.diskHeadroomBytes),'GENERATION_DISK_SPACE');
}
async function writeAll(handle,bytes,position){
  let used=0;while(used<bytes.length){const r=await handle.write(bytes,used,Math.min(L.chunkBytes,bytes.length-used),position+used);check(r.bytesWritten>0,'GENERATION_WRITE');used+=r.bytesWritten;}
}
function sink(handle,start=0){
  let position=start;
  return new Writable({highWaterMark:L.chunkBytes,write(bytes,_encoding,cb){writeAll(handle,bytes,position).then(()=>{position+=bytes.length;cb();},cb);}});
}
const bound=max=>{let bytes=0;return new Transform({highWaterMark:L.chunkBytes,transform(b,_encoding,cb){bytes+=b.length;cb(bytes>max?Error('GENERATION_STREAM_LIMIT'):null,b);}});};
async function writeStream(file,...streams){
  await directory(path.dirname(file));const h=await fs.open(file,'wx',0o600);
  try{await pipeline(...streams,sink(h));await h.sync();}finally{await h.close();}
}
function envelope(kind,scope,manifest,base,changes){
  return {schemaVersion:1,kind,scope,manifest,manifestHash:sha(json(manifest)),base:base??null,changedFiles:changes??manifest.files,deletedPaths:base?diff(base.manifest,manifest).deletedPaths:[]};
}
function encodedEnvelope(kind,scope,manifest,baseDescriptor,changes){
  const value=envelope(kind,scope,manifest,baseDescriptor,changes);if(baseDescriptor)value.base=identity(baseDescriptor);
  const raw=json(value);check(raw.length<=L.metadataBytes,'GENERATION_METADATA_LIMIT');return {value,raw};
}
async function* packed(root,raw,files){const size=Buffer.alloc(4);size.writeUInt32BE(raw.length);yield PACK;yield size;yield raw;for(const e of files)yield*fileChunks(root,e);}
async function encrypt({root,manifest,key,file,scope,baseDescriptor}){
  manifest=structuredClone(manifest);scope=scopeValue(scope);const logicalBytes=manifestValue(manifest);
  if(baseDescriptor){baseDescriptor=structuredClone(baseDescriptor);descriptorValue(baseDescriptor,'base',scope);}
  check(Buffer.isBuffer(key)&&key.length===32,'GENERATION_KEY');key=Buffer.from(key);
  try{
    root=await directory(root);file=path.resolve(file);disjoint(root,file);await directory(path.dirname(file));await absent(file);
    await verifySource(root,manifest);const kind=baseDescriptor?'generation':'base',changes=baseDescriptor?diff(baseDescriptor.manifest,manifest):{changedFiles:manifest.files,deletedPaths:[]};
    const {raw}=encodedEnvelope(kind,scope,manifest,baseDescriptor,changes.changedFiles);
    await freeSpace(path.dirname(file),Math.min(L.objectBytes,logicalBytes+L.metadataBytes));
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
    const handle=await fs.open(file,'wx',0o600);
    try{
      await writeAll(handle,Buffer.concat([MAGIC,iv]),0);
      await pipeline(Readable.from(packed(root,raw,changes.changedFiles)),createGzip({level:6,chunkSize:L.chunkBytes}),cipher,bound(L.objectBytes-MAGIC.length-28),sink(handle,MAGIC.length+12));
      const end=Number((await handle.stat()).size);await writeAll(handle,cipher.getAuthTag(),end);await handle.sync();
    }finally{await handle.close();}
    await verifySource(root,manifest);const pin=await digest(file);
    const descriptor={schemaVersion:1,format:'MOLYVI-GENERATION-1',kind,scope,manifest,manifestHash:sha(json(manifest)),cipherHash:pin.sha256,cipherBytes:pin.bytes,logicalBytes,
      ...(baseDescriptor?{base:identity(baseDescriptor),changedFiles:changes.changedFiles,deletedPaths:changes.deletedPaths}:{})};
    descriptorValue(descriptor,kind,scope);
    return {descriptor,report:{status:'PASS',kind,logicalBytes,payloadBytes:changes.changedFiles.reduce((n,e)=>n+e.bytes,0),changedFiles:changes.changedFiles.length,deletedPaths:changes.deletedPaths.length,
      cipherBytes:pin.bytes,providerCalls:0,hostedAdmission:false,activationReady:false}};
  }finally{key.fill(0);}
}
export async function createGenerationBase(options){check(!options.baseDescriptor,'GENERATION_BASE_ONLY');return encrypt(options);}
export async function encryptGeneration(options){check(options.baseDescriptor,'GENERATION_BASE_REQUIRED');return encrypt(options);}
async function exact(handle,n,position){
  check(Number.isSafeInteger(n)&&n>=0&&n<=L.metadataBytes,'GENERATION_METADATA_LIMIT');const b=Buffer.alloc(n);let used=0;
  while(used<n){const r=await handle.read(b,used,Math.min(L.chunkBytes,n-used),position+used);check(r.bytesRead>0,'GENERATION_TRUNCATED');used+=r.bytesRead;}return b;
}
async function authenticate(file,d,key,target){
  const r=await openFile(file);
  try{
    check(Number(r.before.size)===d.cipherBytes,'GENERATION_CIPHER_BYTES');const pin=await digest(file);check(pin.sha256===d.cipherHash,'GENERATION_CIPHER_HASH');
    const prefix=await exact(r.handle,MAGIC.length+12,0);check(prefix.subarray(0,MAGIC.length).equals(MAGIC),'GENERATION_FORMAT');
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,prefix.subarray(MAGIC.length));decipher.setAAD(MAGIC);decipher.setAuthTag(await exact(r.handle,16,d.cipherBytes-16));
    await writeStream(target,Readable.from(range(r,MAGIC.length+12,d.cipherBytes-MAGIC.length-28)),decipher,bound(L.objectBytes));
    await unchanged(r);check((await digest(file)).sha256===d.cipherHash,'GENERATION_CIPHER_CHANGED');
  }finally{await r.handle.close();}
}
async function unpack(file,target,d,baseDescriptor){
  const r=await openFile(file);
  try{await writeStream(target,Readable.from(range(r,0,Number(r.before.size))),createGunzip({chunkSize:L.chunkBytes}),bound(L.sourceBytes+L.metadataBytes+PACK.length+4));}
  finally{await r.handle.close();}
  const pack=await openFile(target);
  try{
    check((await exact(pack.handle,PACK.length,0)).equals(PACK),'GENERATION_PACK');
    const length=(await exact(pack.handle,4,PACK.length)).readUInt32BE(0);check(length>0&&length<=L.metadataBytes,'GENERATION_METADATA_LIMIT');
    const raw=await exact(pack.handle,length,PACK.length+4),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    const expected=encodedEnvelope(d.kind,d.scope,d.manifest,baseDescriptor,d.kind==='base'?d.manifest.files:d.changedFiles).value;
    check(eq(value,expected),'GENERATION_AUTHENTICATED_METADATA');
    let position=PACK.length+4+length;const positions=new Map();
    for(const e of value.changedFiles){
      positions.set(e.file,{position,entry:e});for await(const _ of range(pack,position,e.bytes,e)){}position+=e.bytes;
    }
    check(position===Number(pack.before.size),'GENERATION_PACK_LENGTH');await unchanged(pack);
    return {pack,positions};
  }catch(e){await pack.handle.close();throw e;}
}
export async function restoreGeneration({baseFile,baseDescriptor,generationFile,generationDescriptor,key,output,scope}){
  scope=scopeValue(scope);baseDescriptor=structuredClone(baseDescriptor);generationDescriptor=structuredClone(generationDescriptor);
  descriptorValue(baseDescriptor,'base',scope);descriptorValue(generationDescriptor,'generation',scope);
  check(eq(generationDescriptor.base,identity(baseDescriptor)),'GENERATION_BASE_MISMATCH');
  const changes=diff(baseDescriptor.manifest,generationDescriptor.manifest);
  check(eq(changes.changedFiles,generationDescriptor.changedFiles)&&eq(changes.deletedPaths,generationDescriptor.deletedPaths),'GENERATION_DIFF_MISMATCH');
  check(Buffer.isBuffer(key)&&key.length===32,'GENERATION_KEY');key=Buffer.from(key);
  let scratch,b,g;
  try{
    baseFile=path.resolve(baseFile);generationFile=path.resolve(generationFile);output=path.resolve(output);
    disjoint(baseFile,generationFile);disjoint(baseFile,output);disjoint(generationFile,output);await directory(path.dirname(output));await absent(output);
    await freeSpace(path.dirname(output),5*L.sourceBytes+2*L.metadataBytes+L.reservedBytes);
    scratch=await fresh(`${output}.generation-restore-${crypto.randomUUID()}`);
    const bgz=path.join(scratch,'base.authenticated.gz'),ggz=path.join(scratch,'generation.authenticated.gz');
    // Authenticate BOTH complete objects before decompression or extracting paths.
    await authenticate(baseFile,baseDescriptor,key,bgz);await authenticate(generationFile,generationDescriptor,key,ggz);
    b=await unpack(bgz,path.join(scratch,'base.pack'),baseDescriptor);
    g=await unpack(ggz,path.join(scratch,'generation.pack'),generationDescriptor,baseDescriptor);
    await fresh(output);
    for(const e of generationDescriptor.manifest.files){
      const source=g.positions.has(e.file)?g:b,row=source.positions.get(e.file);check(row&&eq(row.entry,e),'GENERATION_MAPPING');
      const target=path.join(output,e.file);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await directory(path.dirname(target));
      await writeStream(target,Readable.from(range(source.pack,row.position,e.bytes,e)));
    }
    await unchanged(b.pack);await unchanged(g.pack);await verifySource(output,generationDescriptor.manifest);
    check((await digest(baseFile)).sha256===baseDescriptor.cipherHash&&(await digest(generationFile)).sha256===generationDescriptor.cipherHash,'GENERATION_CIPHER_CHANGED');
    const report=await verifyService(output,generationDescriptor.manifest);
    return {manifest:generationDescriptor.manifest,report:{...report,format:'MOLYVI-GENERATION-1',baseCipherHash:baseDescriptor.cipherHash,generationCipherHash:generationDescriptor.cipherHash,
      changedFiles:changes.changedFiles.length,deletedPaths:changes.deletedPaths.length,providerCalls:0,hostedAdmission:false,activationReady:false,sourceFallback:false},scratchDirectory:scratch};
  }catch(e){if(scratch)e.generationScratchDirectory=scratch;throw e;}
  finally{key.fill(0);await b?.pack.handle.close();await g?.pack.handle.close();}
}

// Recovery bootstrap when the private external descriptor/catalog is lost.
// The recovery key and intended service scope remain trusted caller inputs.
// This returns authenticated metadata, never a retention/delete capability.
function discoveredEnvelope(value,scope,expectedKind,pin){
  check(exactKeys(value,'schemaVersion,kind,scope,manifest,manifestHash,base,changedFiles,deletedPaths')&&value.schemaVersion===1,'GENERATION_DISCOVERY_ENVELOPE');
  check(value.kind===expectedKind,'GENERATION_DISCOVERY_KIND');
  check(eq(scopeValue(value.scope),scope),'GENERATION_SCOPE_MISMATCH');
  const logicalBytes=manifestValue(value.manifest);
  check(value.manifestHash===sha(json(value.manifest)),'GENERATION_MANIFEST_HASH');
  rowsValue(value.changedFiles,{empty:true});
  check(Array.isArray(value.deletedPaths)&&value.deletedPaths.length<=L.files,'GENERATION_DELETIONS');
  const current=new Map(value.manifest.files.map(e=>[e.file,e]));let previous='';
  for(const file of value.deletedPaths){
    safeName(file);check(file>previous&&!current.has(file)&&ROOTS.has(file.split('/')[0]),'GENERATION_DELETIONS');previous=file;
  }
  for(const e of value.changedFiles)check(eq(current.get(e.file),e),'GENERATION_DISCOVERY_REPLACEMENT');
  if(expectedKind==='base')check(value.base===null&&value.deletedPaths.length===0&&eq(value.changedFiles,value.manifest.files),'GENERATION_DISCOVERY_BASE');
  else check(exactKeys(value.base,'cipherHash,cipherBytes,manifestHash'),'GENERATION_BASE_IDENTITY');
  const descriptor={schemaVersion:1,format:'MOLYVI-GENERATION-1',kind:expectedKind,scope,
    manifest:value.manifest,manifestHash:value.manifestHash,cipherHash:pin.sha256,cipherBytes:pin.bytes,logicalBytes,
    ...(expectedKind==='generation'?{base:value.base,changedFiles:value.changedFiles,deletedPaths:value.deletedPaths}:{})};
  descriptorValue(descriptor,expectedKind,scope);return descriptor;
}
export async function discoverGenerationDescriptor({file,key,scope,expectedKind,output}){
  scope=scopeValue(scope);check(expectedKind==='base'||expectedKind==='generation','GENERATION_DISCOVERY_KIND');
  check(typeof output==='string'&&output.length>0,'GENERATION_DISCOVERY_OUTPUT_REQUIRED');
  check(Buffer.isBuffer(key)&&key.length===32,'GENERATION_KEY');key=Buffer.from(key);
  let scratch,pack;
  try{
    file=path.resolve(file);output=path.resolve(output);disjoint(file,output);
    await directory(path.dirname(output));await absent(output);
    const input=await openFile(file);
    try{check(Number(input.before.size)>MAGIC.length+28&&Number(input.before.size)<=L.objectBytes,'GENERATION_OBJECT_LIMIT');}
    finally{await input.handle.close();}
    const actual=await digest(file);check(actual.bytes>MAGIC.length+28&&actual.bytes<=L.objectBytes,'GENERATION_OBJECT_LIMIT');
    await freeSpace(path.dirname(output),2*L.sourceBytes+L.metadataBytes+L.reservedBytes);
    scratch=await fresh(output);
    const compressed=path.join(scratch,'authenticated.gz'),packed=path.join(scratch,'authenticated.pack');
    await authenticate(file,{cipherHash:actual.sha256,cipherBytes:actual.bytes},key,compressed);
    // No gunzip/parser starts until the complete ciphertext passed GCM final().
    const gz=await openFile(compressed);
    try{await writeStream(packed,Readable.from(range(gz,0,Number(gz.before.size))),createGunzip({chunkSize:L.chunkBytes}),bound(L.sourceBytes+L.metadataBytes+PACK.length+4));}
    finally{await gz.handle.close();}
    pack=await openFile(packed);
    check((await exact(pack.handle,PACK.length,0)).equals(PACK),'GENERATION_PACK');
    const length=(await exact(pack.handle,4,PACK.length)).readUInt32BE(0);check(length>0&&length<=L.metadataBytes,'GENERATION_METADATA_LIMIT');
    const raw=await exact(pack.handle,length,PACK.length+4),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    check(raw.equals(json(value)),'GENERATION_METADATA_ENCODING');
    const descriptor=discoveredEnvelope(value,scope,expectedKind,actual);
    let position=PACK.length+4+length;
    for(const e of value.changedFiles){for await(const _ of range(pack,position,e.bytes,e)){}position+=e.bytes;}
    check(position===Number(pack.before.size),'GENERATION_PACK_LENGTH');await unchanged(pack);
    const after=await digest(file);check(after.sha256===actual.sha256&&after.bytes===actual.bytes,'GENERATION_CIPHER_CHANGED');
    return {descriptor,report:{status:'PASS_AUTHENTICATED_DESCRIPTOR_DISCOVERY',format:descriptor.format,kind:expectedKind,
      cipherBytes:actual.bytes,cipherHash:actual.sha256,manifestHash:descriptor.manifestHash,
      logicalFiles:descriptor.manifest.files.length,logicalBytes:descriptor.logicalBytes,
      payloadFiles:value.changedFiles.length,payloadBytes:value.changedFiles.reduce((n,e)=>n+e.bytes,0),
      authenticatedBeforeDecompression:true,payloadHashesVerified:true,scopeVerified:true,
      baseDiffVerified:expectedKind==='base',serviceSemanticVerified:false,sourceFallback:false,
      descriptorCatalogRequired:false,providerCalls:0,hostedAdmission:false,activationReady:false},scratchDirectory:scratch};
  }catch(e){if(scratch)e.generationDiscoveryScratchDirectory=scratch;throw e;}
  finally{key.fill(0);await pack?.handle.close();}
}
