// Opt-in, read-only delivery backing store. This module neither migrates files
// nor grants customer access: callers must authorize the project/order first.
// Only exact flat delivery manifests are supported. Legacy prefixed/inherited
// archives remain ordinary files; there is no implicit path rewriting.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createInflateRaw} from 'node:zlib';

export const DELIVERY_ARCHIVE_LIMITS=Object.freeze({
  archiveBytes:128*1024*1024,expandedBytes:128*1024*1024,
  manifestBytes:1024*1024,smallReadBytes:1024*1024,
  directoryBytes:1024*1024,files:256,pathBytes:1024,depth:24,chunkBytes:65536,
});
const L=DELIVERY_ARCHIVE_LIMITS,ZIP='Molyvi-Service-Delivery.zip',MANIFEST='delivery-manifest.json';
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const capabilities=new WeakSet(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const check=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const signature=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
function fileName(value){
  check(typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=L.pathBytes&&!/[\\:\x00-\x1f?#<>|"*]/.test(value)&&!path.isAbsolute(value),'DELIVERY_ARCHIVE_PATH');
  const parts=value.split('/');check(parts.length<=L.depth,'DELIVERY_ARCHIVE_PATH');
  for(const part of parts)check(part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),'DELIVERY_ARCHIVE_PATH');
  return value;
}
function collisionCheck(names){
  const seen=new Set();
  for(const value of names){const name=fileName(value).toLowerCase();check(!seen.has(name),'DELIVERY_ARCHIVE_COLLISION');seen.add(name);}
  for(const name of seen){const parts=name.split('/');while(parts.length>1){parts.pop();check(!seen.has(parts.join('/')),'DELIVERY_ARCHIVE_COLLISION');}}
}
async function directory(value){
  const root=path.resolve(value),parsed=path.parse(root);let current=parsed.root;
  for(const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const s=await fs.lstat(current);
    check(s.isDirectory()&&!s.isSymbolicLink(),'DELIVERY_ARCHIVE_DIRECTORY');
  }
  const real=await fs.realpath(root);
  check(process.platform==='win32'?real.toLowerCase()===root.toLowerCase():real===root,'DELIVERY_ARCHIVE_ALIAS');return root;
}
function ordinary(s){
  check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.size>=22n&&s.size<=BigInt(L.archiveBytes),'DELIVERY_ARCHIVE_UNSAFE_FILE');
}
async function stable(state){
  check(!state.closed,'DELIVERY_ARCHIVE_CLOSED');await directory(state.root);
  const a=await state.handle.stat({bigint:true}),b=await fs.lstat(state.file,{bigint:true});
  ordinary(a);ordinary(b);
  check(signature(a)===state.signature&&signature(b)===state.signature,'DELIVERY_ARCHIVE_CHANGED');
}
async function exact(state,position,length){
  check(Number.isSafeInteger(position)&&Number.isSafeInteger(length)&&position>=0&&length>=0&&length<=L.directoryBytes&&position+length<=state.size,'DELIVERY_ARCHIVE_BOUNDS');
  const out=Buffer.alloc(length);let used=0;
  while(used<length){const r=await state.handle.read(out,used,Math.min(L.chunkBytes,length-used),position+used);check(r.bytesRead>0,'DELIVERY_ARCHIVE_TRUNCATED');used+=r.bytesRead;}
  return out;
}
async function* range(state,start,length){
  check(Number.isSafeInteger(start)&&Number.isSafeInteger(length)&&start>=0&&length>=0&&start+length<=state.size,'DELIVERY_ARCHIVE_BOUNDS');
  await stable(state);let used=0;
  while(used<length){
    const b=Buffer.alloc(Math.min(L.chunkBytes,length-used)),r=await state.handle.read(b,0,b.length,start+used);
    check(r.bytesRead===b.length,'DELIVERY_ARCHIVE_TRUNCATED');used+=r.bytesRead;yield b;
  }
  await stable(state);
}
function manifestInput(raw,manifestHash,projectId,orderId){
  check(Buffer.isBuffer(raw)||raw instanceof Uint8Array,'DELIVERY_ARCHIVE_MANIFEST');
  check(raw.byteLength>0&&raw.byteLength<=L.manifestBytes,'DELIVERY_ARCHIVE_MANIFEST_LIMIT');
  const bytes=Buffer.from(raw);check(HASH.test(manifestHash??'')&&sha(bytes)===manifestHash,'DELIVERY_ARCHIVE_MANIFEST_HASH');
  check(UUID.test(projectId??'')&&typeof orderId==='string'&&orderId.length>0&&orderId.length<=200&&!/[\x00-\x1f]/.test(orderId),'DELIVERY_ARCHIVE_IDENTITY');
  let model;try{model=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{check(false,'DELIVERY_ARCHIVE_MANIFEST');}
  check(plain(model)&&model.schemaVersion===1&&model.kind==='molyvi_handoff_manifest'&&model.projectId===projectId&&model.serviceOrderId===orderId,'DELIVERY_ARCHIVE_IDENTITY');
  check(Array.isArray(model.files)&&model.files.length>0&&model.files.length<=L.files,'DELIVERY_ARCHIVE_FILE_LIMIT');
  const rows=[];let total=bytes.length;
  for(const f of model.files){
    check(plain(f)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&HASH.test(f.sha256??''),'DELIVERY_ARCHIVE_MANIFEST_ENTRY');
    const file=fileName(f.file);check(file!==MANIFEST&&file!==ZIP,'DELIVERY_ARCHIVE_MANIFEST_ENTRY');
    total+=f.bytes;check(Number.isSafeInteger(total)&&total<=L.expandedBytes,'DELIVERY_ARCHIVE_EXPANDED_LIMIT');
    rows.push({file,bytes:f.bytes,sha256:f.sha256});
  }
  rows.push({file:MANIFEST,bytes:bytes.length,sha256:manifestHash});collisionCheck(rows.map(e=>e.file));
  return {bytes,rows};
}
function decodeName(bytes,flags){
  check(bytes.length>0&&bytes.length<=L.pathBytes,'DELIVERY_ARCHIVE_PATH');
  // Unflagged ASCII is the format emitted by the existing legacy ZIPs.
  // Non-ASCII names require the UTF-8 flag; CP437/Unicode extra aliases are not accepted.
  check((flags&0x800)!==0||bytes.every(b=>b<128),'DELIVERY_ARCHIVE_ENCODING');
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{check(false,'DELIVERY_ARCHIVE_ENCODING');}
  check(Buffer.from(name,'utf8').equals(bytes),'DELIVERY_ARCHIVE_ENCODING');return fileName(name);
}
async function parseArchive(state,expected){
  const end=await exact(state,state.size-22,22);
  check(end.readUInt32LE(0)===0x06054b50&&end.readUInt16LE(4)===0&&end.readUInt16LE(6)===0&&end.readUInt16LE(20)===0,'DELIVERY_ARCHIVE_END');
  const count=end.readUInt16LE(10),centralBytes=end.readUInt32LE(12),centralStart=end.readUInt32LE(16);
  check(count===end.readUInt16LE(8)&&count===expected.size&&count<=L.files+1&&count!==0xffff,'DELIVERY_ARCHIVE_MEMBERS');
  check(centralBytes>0&&centralBytes<=L.directoryBytes&&centralStart!==0xffffffff&&centralStart+centralBytes===state.size-22,'DELIVERY_ARCHIVE_BOUNDS');
  const central=await exact(state,centralStart,centralBytes),rows=[];let at=0,total=0;
  for(let i=0;i<count;i++){
    check(at+46<=central.length&&central.readUInt32LE(at)===0x02014b50,'DELIVERY_ARCHIVE_CENTRAL');
    const needed=central.readUInt16LE(at+6),flags=central.readUInt16LE(at+8),method=central.readUInt16LE(at+10);
    const crc=central.readUInt32LE(at+16),compressed=central.readUInt32LE(at+20),bytes=central.readUInt32LE(at+24);
    const names=central.readUInt16LE(at+28),extra=central.readUInt16LE(at+30),comment=central.readUInt16LE(at+32);
    const disk=central.readUInt16LE(at+34),attributes=central.readUInt32LE(at+38),offset=central.readUInt32LE(at+42);
    check(needed<=20&&(method===0||method===8)&&(flags&~0x080e)===0&&(method===8||(flags&6)===0),'DELIVERY_ARCHIVE_FORMAT');
    check(extra===0&&comment===0&&disk===0&&compressed!==0xffffffff&&bytes!==0xffffffff&&offset!==0xffffffff,'DELIVERY_ARCHIVE_FORMAT');
    const unixType=(attributes>>>16)&0xf000;
    check((attributes&0x10)===0&&(unixType===0||unixType===0x8000),'DELIVERY_ARCHIVE_LINK_OR_DIRECTORY');
    check(at+46+names<=central.length,'DELIVERY_ARCHIVE_BOUNDS');
    const nameBytes=Buffer.from(central.subarray(at+46,at+46+names)),file=decodeName(nameBytes,flags),pin=expected.get(file);
    check(pin&&pin.bytes===bytes,'DELIVERY_ARCHIVE_MEMBER_BINDING');
    check(method!==0||compressed===bytes,'DELIVERY_ARCHIVE_SIZE');
    total+=bytes;check(total<=L.expandedBytes,'DELIVERY_ARCHIVE_EXPANDED_LIMIT');
    rows.push({file,bytes,sha256:pin.sha256,method,compressedBytes:compressed,crc,offset,flags,needed,nameBytes,
      time:central.readUInt16LE(at+12),date:central.readUInt16LE(at+14)});
    at+=46+names;
  }
  check(at===central.length,'DELIVERY_ARCHIVE_CENTRAL');collisionCheck(rows.map(e=>e.file));
  rows.sort((a,b)=>a.offset-b.offset);
  for(let i=0;i<rows.length;i++){
    const e=rows[i],next=i+1<rows.length?rows[i+1].offset:centralStart;
    check((i!==0||e.offset===0)&&e.offset<next&&e.offset+30<=next,'DELIVERY_ARCHIVE_OVERLAP');
    const local=await exact(state,e.offset,30),names=local.readUInt16LE(26),extra=local.readUInt16LE(28);
    check(local.readUInt32LE(0)===0x04034b50&&local.readUInt16LE(4)===e.needed&&local.readUInt16LE(6)===e.flags&&local.readUInt16LE(8)===e.method&&local.readUInt16LE(10)===e.time&&local.readUInt16LE(12)===e.date,'DELIVERY_ARCHIVE_LOCAL');
    check(extra===0&&names===e.nameBytes.length&&e.offset+30+names<=next,'DELIVERY_ARCHIVE_LOCAL');
    check((await exact(state,e.offset+30,names)).equals(e.nameBytes),'DELIVERY_ARCHIVE_LOCAL');
    const lc=local.readUInt32LE(14),cs=local.readUInt32LE(18),us=local.readUInt32LE(22),descriptor=(e.flags&8)!==0;
    check(descriptor?(lc===0&&cs===0&&us===0||lc===e.crc&&cs===e.compressedBytes&&us===e.bytes):(lc===e.crc&&cs===e.compressedBytes&&us===e.bytes),'DELIVERY_ARCHIVE_LOCAL');
    e.start=e.offset+30+names;const dataEnd=e.start+e.compressedBytes;
    check(dataEnd<=next,'DELIVERY_ARCHIVE_OVERLAP');
    if(descriptor){
      const n=next-dataEnd;check(n===12||n===16,'DELIVERY_ARCHIVE_DESCRIPTOR');const d=await exact(state,dataEnd,n),p=n===16?4:0;
      check((n!==16||d.readUInt32LE(0)===0x08074b50)&&d.readUInt32LE(p)===e.crc&&d.readUInt32LE(p+4)===e.compressedBytes&&d.readUInt32LE(p+8)===e.bytes,'DELIVERY_ARCHIVE_DESCRIPTOR');
    }else check(dataEnd===next,'DELIVERY_ARCHIVE_OVERLAP');
  }
  await stable(state);return new Map(rows.map(e=>[e.file,e]));
}
async function* decoded(state,entry){
  const input=Readable.from(range(state,entry.start,entry.compressedBytes),{objectMode:false,highWaterMark:L.chunkBytes});
  const inflate=entry.method===8?createInflateRaw({chunkSize:L.chunkBytes,highWaterMark:L.chunkBytes}):null;
  const output=inflate??input,completion=inflate?pipeline(input,inflate):null;
  completion?.catch(()=>{});let total=0,crc=0xffffffff;const hash=crypto.createHash('sha256');
  try{
    for await(const raw of output){
      for(let at=0;at<raw.length;at+=L.chunkBytes){
        const b=raw.subarray(at,at+L.chunkBytes);
        total+=b.length;check(total<=entry.bytes&&total<=L.expandedBytes,'DELIVERY_ARCHIVE_EXPANDED_LIMIT');
        hash.update(b);for(const byte of b)crc=crcTable[(crc^byte)&255]^(crc>>>8);
        const emittedHash=sha(b);yield b;
        check(sha(b)===emittedHash,'DELIVERY_ARCHIVE_CONSUMER_MUTATED');
      }
    }
    if(completion)await completion;
    check(total===entry.bytes,'DELIVERY_ARCHIVE_SIZE');
    check(!inflate||inflate.bytesWritten===entry.compressedBytes,'DELIVERY_ARCHIVE_DEFLATE_TRAILING');
    check(((crc^0xffffffff)>>>0)===entry.crc,'DELIVERY_ARCHIVE_CRC');
    check(hash.digest('hex')===entry.sha256,'DELIVERY_ARCHIVE_MEMBER_HASH');await stable(state);
  }finally{
    output.destroy();input.destroy();if(completion)await completion.catch(()=>{});
  }
}
const publicEntry=e=>Object.freeze({file:e.file,bytes:e.bytes,sha256:e.sha256,method:e.method,compressedBytes:e.compressedBytes});
function requested(state,file,expected){
  check(!state.closed,'DELIVERY_ARCHIVE_CLOSED');fileName(file);
  const e=state.entries.get(file);check(e,'DELIVERY_ARCHIVE_NOT_FOUND');
  if(expected!==undefined){
    check(plain(expected)&&Object.keys(expected).sort().join(',')==='bytes,sha256'&&Number.isSafeInteger(expected.bytes)&&expected.bytes>=0&&HASH.test(expected.sha256??''),'DELIVERY_ARCHIVE_EXPECTED_PIN');
    check(expected.bytes===e.bytes&&expected.sha256===e.sha256,'DELIVERY_ARCHIVE_EXPECTED_PIN');
  }
  return e;
}
async function operation(state,body){
  check(!state.closed,'DELIVERY_ARCHIVE_CLOSED');check(!state.busy,'DELIVERY_ARCHIVE_CONCURRENT_READ');state.busy=true;
  try{await stable(state);const result=await body();await stable(state);return result;}finally{state.busy=false;}
}
async function verifyEntry(state,e){for await(const unused of decoded(state,e)){void unused;}return publicEntry(e);}

export function isDeliveryArchiveSource(value){return capabilities.has(value);}
export async function openArchiveSource({root,manifestRaw,manifestHash,zipHash,projectId,orderId}={}){
  // Snapshot caller-owned bytes and identity synchronously, before any I/O.
  const manifest=manifestInput(manifestRaw,manifestHash,projectId,orderId);
  check(typeof root==='string'&&root.length>0&&HASH.test(zipHash??''),'DELIVERY_ARCHIVE_CONFIG');
  root=path.resolve(root);await directory(root);const file=path.join(root,ZIP),before=await fs.lstat(file,{bigint:true});ordinary(before);
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const state={root,file,handle,size:Number(before.size),signature:signature(before),closed:false,busy:false,entries:null};
  try{
    await stable(state);const h=crypto.createHash('sha256');for await(const b of range(state,0,state.size))h.update(b);
    check(h.digest('hex')===zipHash,'DELIVERY_ARCHIVE_ZIP_HASH');
    state.entries=await parseArchive(state,new Map(manifest.rows.map(e=>[e.file,e])));
    const embedded=[];for await(const b of decoded(state,state.entries.get(MANIFEST)))embedded.push(b);
    check(Buffer.concat(embedded).equals(manifest.bytes),'DELIVERY_ARCHIVE_EMBEDDED_MANIFEST');
    const entries=Object.freeze([...state.entries.values()].map(publicEntry).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0));
    const capability=Object.freeze({
      projectId,orderId,manifestHash,zipHash,entries,
      entry(file,expected){return publicEntry(requested(state,file,expected));},
      digest(file,expected){const e=requested(state,file,expected);return operation(state,()=>verifyEntry(state,e));},
      readSmall(file,{maxBytes=L.smallReadBytes,expected}={}){
        const e=requested(state,file,expected);
        check(Number.isSafeInteger(maxBytes)&&maxBytes>=0&&maxBytes<=L.smallReadBytes&&e.bytes<=maxBytes,'DELIVERY_ARCHIVE_SMALL_READ_LIMIT');
        return operation(state,async()=>{
          const b=Buffer.alloc(e.bytes);let at=0;
          for await(const chunk of decoded(state,e)){chunk.copy(b,at);at+=chunk.length;}return b;
        });
      },
      streamVerify(file,consumer,{expected}={}){
        const e=requested(state,file,expected);check(typeof consumer==='function','DELIVERY_ARCHIVE_CONSUMER');
        return operation(state,async()=>{
          const entry=await verifyEntry(state,e);let complete=false,active=true;
          const chunks=(async function*(){
            check(active,'DELIVERY_ARCHIVE_LEASE_CLOSED');
            for await(const b of decoded(state,e)){check(active,'DELIVERY_ARCHIVE_LEASE_CLOSED');yield b;}
            complete=true;
          })();
          try{
            const result=await consumer(Object.freeze({chunks,entry}));
            check(complete,'DELIVERY_ARCHIVE_CONSUMER_INCOMPLETE');return result;
          }finally{active=false;await chunks.return();}
        });
      },
      async close(){check(!state.busy,'DELIVERY_ARCHIVE_CONCURRENT_READ');if(state.closed)return;state.closed=true;await handle.close();},
    });
    capabilities.add(capability);return capability;
  }catch(error){state.closed=true;await handle.close();throw error;}
}
