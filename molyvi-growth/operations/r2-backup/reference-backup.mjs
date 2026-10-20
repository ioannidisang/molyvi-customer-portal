// Opt-in backup representation. Activation is separately controlled by the caller.
// Start with an independently captured, verified v1 service snapshot. Only
// explicitly selected, project-bound images are deduplicated; everything else
// (including SQLite, ZIPs, keys and empty files) remains opaque.
import fs from 'node:fs/promises';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {verifyService} from './backup.mjs';
import {createAssetVault,openAssetVault,ASSET_VAULT_LIMITS} from './reference-assets.mjs';

export const REFERENCE_BACKUP_LIMITS=Object.freeze({
  sourceBytes:512_000_000,objectBytes:512_000_000,reservedBytes:12*1024*1024,
  manifestBytes:16*1024*1024,files:100_000,projects:32,workspaceBytes:2*1024*1024,
  diskHeadroomBytes:512_000_000,
});
const L=REFERENCE_BACKUP_LIMITS,MAGIC=Buffer.from('MOLYVI-BACKUP-2\n'),PACK=Buffer.from('MOLYVI-REFERENCE-PACK-2\n');
const DB='accounts/customers.sqlite',HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ROOT_NAMES=new Set(['accounts','controlled-operations','controlled-photos','controlled-pro','deliveries','delivery-imports','gmail-journal','hosted-scope.json','mail','regeneration-import-1005-r1','workspaces']);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),json=v=>Buffer.from(JSON.stringify(v));
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const check=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const sort=a=>a.sort((x,y)=>x.file<y.file?-1:x.file>y.file?1:0);
const keys=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===n.split(',').sort().join(',');
function name(value){
  check(typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\\:\x00-\x1f?#<>|"*]/.test(value)&&!path.isAbsolute(value),'REFERENCE_BACKUP_PATH');
  const parts=value.split('/');check(parts.length<=24,'REFERENCE_BACKUP_PATH');
  for(const part of parts)check(part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),'REFERENCE_BACKUP_PATH');
  return value;
}
function entries(rows,max=L.sourceBytes){
  check(Array.isArray(rows)&&rows.length>0&&rows.length<=L.files,'REFERENCE_BACKUP_ENTRIES');
  const names=new Set();let bytes=0;
  for(const e of rows){
    check(keys(e,'file,bytes,sha256')&&Number.isSafeInteger(e.bytes)&&e.bytes>=0&&HASH.test(e.sha256),'REFERENCE_BACKUP_ENTRY');name(e.file);
    const key=e.file.toLowerCase();check(!names.has(key),'REFERENCE_BACKUP_COLLISION');names.add(key);
    bytes+=e.bytes;check(Number.isSafeInteger(bytes)&&bytes<=max,'REFERENCE_BACKUP_SOURCE_LIMIT');
  }
  for(const key of names){const parts=key.split('/');while(parts.length>1){parts.pop();check(!names.has(parts.join('/')),'REFERENCE_BACKUP_COLLISION');}}
  return bytes;
}
function logicalManifest(m){
  check(m?.schemaVersion===1&&m.kind==='molyvi_private_service_snapshot'&&/^[a-f0-9]{40}$/.test(m.release),'REFERENCE_BACKUP_LOGICAL_MANIFEST');
  check(json(m).length<=L.manifestBytes,'REFERENCE_BACKUP_METADATA_LIMIT');
  const bytes=entries(m.files,L.sourceBytes-L.reservedBytes);check(m.files.some(e=>e.file===DB),'REFERENCE_BACKUP_DATABASE');
  check(m.files.every(e=>ROOT_NAMES.has(e.file.split('/')[0])),'REFERENCE_BACKUP_SERVICE_ROOT');
  check(m.database?.integrity==='ok','REFERENCE_BACKUP_DATABASE');return bytes;
}
function disjoint(a,b){
  for(const [x,y]of [[path.resolve(a),path.resolve(b)],[path.resolve(b),path.resolve(a)]]){
    const r=path.relative(x,y);check(r&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'REFERENCE_BACKUP_OVERLAP');
  }
}
async function directory(value){
  const root=path.resolve(value),parsed=path.parse(root);let at=parsed.root;
  for(const bit of root.slice(parsed.root.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at);check(s.isDirectory()&&!s.isSymbolicLink(),'REFERENCE_BACKUP_DIRECTORY');}
  const real=await fs.realpath(root);check(process.platform==='win32'?real.toLowerCase()===root.toLowerCase():real===root,'REFERENCE_BACKUP_ALIAS');return root;
}
async function fresh(value){const root=path.resolve(value);await directory(path.dirname(root));await fs.mkdir(root,{mode:0o700});return directory(root);}
const signature=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
const ordinary=s=>check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.size>=0n&&s.size<=BigInt(L.sourceBytes),'REFERENCE_BACKUP_UNSAFE_FILE');
async function open(root,file){
  name(file);await directory(root);const full=path.join(root,file);await directory(path.dirname(full));
  const before=await fs.lstat(full,{bigint:true});ordinary(before);
  const handle=await fs.open(full,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const s=await handle.stat({bigint:true});ordinary(s);check(signature(s)===signature(before),'REFERENCE_BACKUP_CHANGED');return {handle,full,before,root};}
  catch(e){await handle.close();throw e;}
}
async function unchanged(r){await directory(path.dirname(r.full));const a=await r.handle.stat({bigint:true}),b=await fs.lstat(r.full,{bigint:true});ordinary(a);ordinary(b);check(signature(a)===signature(r.before)&&signature(b)===signature(r.before),'REFERENCE_BACKUP_CHANGED');}
async function* readChunks(root,file,expected){
  const r=await open(root,file),buffer=Buffer.alloc(64*1024),h=crypto.createHash('sha256');let count=0;
  try{
    check(!expected||BigInt(expected.bytes)===r.before.size,'REFERENCE_BACKUP_CHANGED');
    while(count<Number(r.before.size)){
      const {bytesRead}=await r.handle.read(buffer,0,Math.min(buffer.length,Number(r.before.size)-count),count);
      check(bytesRead>0,'REFERENCE_BACKUP_TRUNCATED');count+=bytesRead;
      const bytes=Buffer.from(buffer.subarray(0,bytesRead));h.update(bytes);yield bytes;
    }
    check((await r.handle.read(buffer,0,1,count)).bytesRead===0,'REFERENCE_BACKUP_CHANGED');await unchanged(r);
    const digest=h.digest('hex');check(!expected||digest===expected.sha256,'REFERENCE_BACKUP_HASH');
  }finally{await r.handle.close();}
}
async function digest(root,file){
  const h=crypto.createHash('sha256');let bytes=0;for await(const b of readChunks(root,file)){bytes+=b.length;h.update(b);}return {file,bytes,sha256:h.digest('hex')};
}
async function boundedRead(root,file,limit){
  const r=await open(root,file);
  try{check(r.before.size<=BigInt(limit),'REFERENCE_BACKUP_METADATA_LIMIT');const b=Buffer.alloc(Number(r.before.size));let used=0;
    while(used<b.length){const n=await r.handle.read(b,used,Math.min(65536,b.length-used),used);check(n.bytesRead>0,'REFERENCE_BACKUP_TRUNCATED');used+=n.bytesRead;}
    check((await r.handle.read(Buffer.alloc(1),0,1,used)).bytesRead===0,'REFERENCE_BACKUP_CHANGED');await unchanged(r);return b;
  }finally{await r.handle.close();}
}
async function inventory(root,prefix=''){
  await directory(path.join(root,prefix));const rows=[];let visited=0,total=0;
  async function walk(rel){
    check(rel.split('/').length<=24,'REFERENCE_BACKUP_PATH');
    for await(const e of await fs.opendir(path.join(root,rel))){
      check(++visited<=L.files*2,'REFERENCE_BACKUP_ENTRIES');
      const file=name(rel?`${rel}/${e.name}`:e.name);check(!e.isSymbolicLink(),'REFERENCE_BACKUP_UNSAFE_FILE');
      if(e.isDirectory())await walk(file);else{check(e.isFile(),'REFERENCE_BACKUP_UNSAFE_FILE');check(rows.length<L.files,'REFERENCE_BACKUP_ENTRIES');const pin=await digest(root,file);total+=pin.bytes;check(total<=L.sourceBytes,'REFERENCE_BACKUP_SOURCE_LIMIT');rows.push(pin);}
    }
  }
  await walk(prefix);sort(rows);if(rows.length)entries(rows);return rows;
}
async function copy(root,entry,target){
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await directory(path.dirname(target));
  await pipeline(Readable.from(readChunks(root,entry.file,entry)),createWriteStream(target,{flags:'wx',mode:0o600}));
  const actual=await digest(path.dirname(target),path.basename(target));check(actual.bytes===entry.bytes&&actual.sha256===entry.sha256,'REFERENCE_BACKUP_COPY');
}
async function freeSpace(parent,needed){
  await directory(parent);const stats=await fs.statfs(parent,{bigint:true});
  check(stats.bavail*stats.bsize>=BigInt(needed)+BigInt(L.diskHeadroomBytes),'REFERENCE_BACKUP_DISK_SPACE');
}
function mediaFor(file){return /\.png$/i.test(file)?'image/png':/\.jpe?g$/i.test(file)?'image/jpeg':/\.webp$/i.test(file)?'image/webp':null;}
async function deriveGroups(root,manifest,projects){
  check(Array.isArray(projects)&&projects.length<=L.projects,'REFERENCE_BACKUP_PROJECTS');
  const db=new DatabaseSync(path.join(root,DB),{readOnly:true}),seen=new Set(),groups=[],all=new Map(manifest.files.map(e=>[e.file,e]));
  try{
    for(const project of projects){
      check(keys(project,'projectId,files')&&UUID.test(project.projectId)&&!seen.has(project.projectId),'REFERENCE_BACKUP_PROJECT');seen.add(project.projectId);
      const rows=db.prepare('SELECT * FROM projects WHERE id=?').all(project.projectId);check(rows.length===1,'REFERENCE_BACKUP_OWNER');
      const p=rows[0],w=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedRead(root,`workspaces/${p.id}/workspace.json`,L.workspaceBytes)));
      check(w.id===p.id&&w.ownerId===p.owner_id&&w.order?.id===p.order_id,'REFERENCE_BACKUP_OWNER');
      check(Array.isArray(project.files)&&project.files.length>0&&project.files.length<=ASSET_VAULT_LIMITS.files,'REFERENCE_BACKUP_PROJECT_FILES');
      const deliveryRows=db.prepare('SELECT * FROM deliveries WHERE project_id=?').all(p.id),deliveryMaps=new Map(),selected=[];
      for(const request of project.files){
        check(keys(request,'file,mediaType,role'),'REFERENCE_BACKUP_SELECTION');const pin=all.get(name(request.file));check(pin,'REFERENCE_BACKUP_SELECTION');
        const wsPrefix=`workspaces/${p.id}/`,match=request.file.startsWith(wsPrefix)?request.file.slice(wsPrefix.length).match(/^(photo|generated|logo)-([a-f0-9-]{36})\.bin$/):null;
        if(match){
          const map=match[1]==='photo'?w.assets:match[1]==='generated'?w.generatedAssets:w.brandAssets,asset=map?.[match[2]];
          check(asset?.id===match[2]&&asset.bytes===pin.bytes&&asset.sha256===pin.sha256&&asset.mime===request.mediaType,'REFERENCE_BACKUP_ASSET_BINDING');
          check(request.role===(match[1]==='photo'?'original':match[1]==='generated'?'selected':'logo'),'REFERENCE_BACKUP_ASSET_ROLE');
        }else{
          const d=request.file.match(/^deliveries\/([a-f0-9]{64})\/(.+)$/);check(d&&request.role==='delivery'&&mediaFor(d[2])===request.mediaType,'REFERENCE_BACKUP_DELIVERY');
          const matches=deliveryRows.filter(row=>row.manifest_hash===d[1]);check(matches.length===1,'REFERENCE_BACKUP_DELIVERY_OWNER');
          if(!deliveryMaps.has(d[1])){
            const raw=await boundedRead(root,`deliveries/${d[1]}/delivery-manifest.json`,L.manifestBytes);check(sha(raw)===d[1],'REFERENCE_BACKUP_DELIVERY');
            const value=JSON.parse(raw);check(value.projectId===p.id&&Array.isArray(value.files),'REFERENCE_BACKUP_DELIVERY');
            deliveryMaps.set(d[1],value.files);
          }
          const matchesFiles=deliveryMaps.get(d[1]).filter(e=>e.file===d[2]);check(matchesFiles.length===1&&matchesFiles[0].bytes===pin.bytes&&matchesFiles[0].sha256===pin.sha256,'REFERENCE_BACKUP_DELIVERY');
        }
        selected.push({...pin,mediaType:request.mediaType,role:request.role});
      }
      selected.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);entries(selected.map(({file,bytes,sha256})=>({file,bytes,sha256})));
      const binding={ownerHash:sha(json(p.owner_id)),projectId:p.id,selectionHash:sha(json({snapshotHash:sha(json(manifest)),files:selected}))};
      groups.push({projectId:p.id,binding,entries:selected.map(e=>({logicalPath:e.file,sourcePath:e.file,role:e.role,mediaType:e.mediaType,versionId:e.sha256,bytes:e.bytes,sha256:e.sha256}))});
    }
  }finally{db.close();}
  return groups.sort((a,b)=>a.projectId<b.projectId?-1:a.projectId>b.projectId?1:0);
}
function validate(m){
  check(keys(m,'schemaVersion,kind,logicalManifest,groups,opaque,files,logicalBytes,physicalBytes')&&m.schemaVersion===2&&m.kind==='molyvi_private_reference_snapshot','REFERENCE_BACKUP_MANIFEST');
  const total=logicalManifest(m.logicalManifest),physical=entries(m.files);
  check(total===m.logicalBytes&&physical===m.physicalBytes,'REFERENCE_BACKUP_TOTAL');
  check(Array.isArray(m.groups)&&m.groups.length<=L.projects&&Array.isArray(m.opaque),'REFERENCE_BACKUP_GROUPS');
  const logical=new Map(m.logicalManifest.files.map(e=>[e.file,e])),covered=new Set(),physicalMap=new Map(m.files.map(e=>[e.file,e])),expectedPhysical=new Set(),projectIds=new Set();
  const cover=e=>{const pin=logical.get(e.file);check(pin&&pin.bytes===e.bytes&&pin.sha256===e.sha256&&!covered.has(e.file),'REFERENCE_BACKUP_MAPPING');covered.add(e.file);};
  for(const group of m.groups){
    check(keys(group,'projectId,binding,manifestSha256,entries')&&UUID.test(group.projectId)&&!projectIds.has(group.projectId)&&HASH.test(group.manifestSha256),'REFERENCE_BACKUP_GROUP');
    projectIds.add(group.projectId);check(keys(group.binding,'ownerHash,projectId,selectionHash')&&group.binding.projectId===group.projectId&&HASH.test(group.binding.ownerHash)&&HASH.test(group.binding.selectionHash),'REFERENCE_BACKUP_GROUP');
    check(Array.isArray(group.entries)&&group.entries.length>0&&group.entries.length<=ASSET_VAULT_LIMITS.files,'REFERENCE_BACKUP_GROUP');
    for(const e of group.entries){
      check(keys(e,'logicalPath,role,mediaType,versionId,bytes,sha256')&&e.versionId===e.sha256,'REFERENCE_BACKUP_GROUP');
      cover({file:e.logicalPath,bytes:e.bytes,sha256:e.sha256});
      const object=`vaults/${group.projectId}/objects/${e.sha256}.bin`,pin=physicalMap.get(object);
      check(pin?.sha256===e.sha256&&pin.bytes===e.bytes,'REFERENCE_BACKUP_OBJECT');expectedPhysical.add(object);
    }
    const file=`vaults/${group.projectId}/manifest.json`,pin=physicalMap.get(file);check(pin?.sha256===group.manifestSha256&&pin.bytes<=ASSET_VAULT_LIMITS.manifestBytes,'REFERENCE_BACKUP_VAULT_MANIFEST');expectedPhysical.add(file);
  }
  for(const e of m.opaque){
    check(keys(e,'file,bytes,sha256'),'REFERENCE_BACKUP_OPAQUE');cover(e);
    const target=`files/${e.file}`,pin=physicalMap.get(target);check(pin?.bytes===e.bytes&&pin.sha256===e.sha256,'REFERENCE_BACKUP_OPAQUE');expectedPhysical.add(target);
  }
  check(covered.size===logical.size&&expectedPhysical.size===m.files.length&&m.files.every(e=>expectedPhysical.has(e.file)),'REFERENCE_BACKUP_MAPPING');
  check(m.opaque.some(e=>e.file===DB),'REFERENCE_BACKUP_DATABASE');
  check(json(m).length<=L.manifestBytes,'REFERENCE_BACKUP_METADATA_LIMIT');return m;
}
async function verifyCompact(root,m){
  validate(m);check(eq(await inventory(root),m.files),'REFERENCE_BACKUP_PHYSICAL_CHANGED');
  for(const group of m.groups){
    const vault=await openAssetVault({vaultDirectory:path.join(root,'vaults',group.projectId),binding:group.binding,expectedManifestSha256:group.manifestSha256});
    check(eq(vault.entries,group.entries),'REFERENCE_BACKUP_VAULT_MAPPING');await vault.revalidate();
  }
  // DB/workspace/delivery manifests are always opaque, so their authority can
  // be checked before materializing any selected customer image.
  const requests=m.groups.map(g=>({projectId:g.projectId,files:g.entries.map(e=>({file:e.logicalPath,mediaType:e.mediaType,role:e.role}))}));
  const derived=await deriveGroups(path.join(root,'files'),m.logicalManifest,requests);
  check(derived.length===m.groups.length&&derived.every((g,i)=>eq(g.binding,m.groups[i].binding)),'REFERENCE_BACKUP_RESTORE_BINDING');
}

export async function prepareReferenceSnapshot({root,manifest,output,projects}){
  manifest=structuredClone(manifest);projects=structuredClone(projects);const logicalBytes=logicalManifest(manifest);
  check(Array.isArray(projects)&&projects.length<=L.projects,'REFERENCE_BACKUP_PROJECTS');
  check(projects.every(p=>keys(p,'projectId,files')&&Array.isArray(p.files)&&p.files.length>0&&p.files.length<=ASSET_VAULT_LIMITS.files),'REFERENCE_BACKUP_PROJECT_FILES');
  check(json(projects).length<=L.manifestBytes,'REFERENCE_BACKUP_METADATA_LIMIT');
  root=await directory(root);output=path.resolve(output);disjoint(root,output);
  await verifyService(root,manifest);check(eq(await inventory(root),manifest.files),'REFERENCE_BACKUP_CHANGED');
  const groups=await deriveGroups(root,manifest,projects);
  await freeSpace(path.dirname(output),logicalBytes+L.manifestBytes);await fresh(output);await fs.mkdir(path.join(output,'vaults'));
  const selected=new Set(),stored=[];
  for(const group of groups){
    for(const entry of group.entries){check(!selected.has(entry.logicalPath),'REFERENCE_BACKUP_MAPPING');selected.add(entry.logicalPath);}
    const receipt=await createAssetVault({sourceDirectory:root,vaultDirectory:path.join(output,'vaults',group.projectId),binding:group.binding,entries:group.entries});
    const vault=await openAssetVault({vaultDirectory:receipt.directory,binding:group.binding,expectedManifestSha256:receipt.manifestSha256});
    stored.push({projectId:group.projectId,binding:group.binding,manifestSha256:receipt.manifestSha256,entries:[...vault.entries]});
  }
  const opaque=manifest.files.filter(e=>!selected.has(e.file));
  for(const e of opaque)await copy(root,e,path.join(output,'files',e.file));
  check(eq(await inventory(root),manifest.files),'REFERENCE_BACKUP_SOURCE_CHANGED');
  const files=await inventory(output),m={schemaVersion:2,kind:'molyvi_private_reference_snapshot',logicalManifest:manifest,groups:stored,opaque,files,logicalBytes,physicalBytes:files.reduce((n,e)=>n+e.bytes,0)};
  await verifyCompact(output,m);return m;
}

// Deterministic, snapshot-only policy. Only duplicate image bytes within a
// verified project are selected. Every other logical file remains opaque.
export async function selectReferenceBackupProjects({root,manifest}){
  manifest=structuredClone(manifest);logicalManifest(manifest);root=await directory(root);
  await verifyService(root,manifest);check(eq(await inventory(root),manifest.files),'REFERENCE_BACKUP_CHANGED');
  const db=new DatabaseSync(path.join(root,DB),{readOnly:true}),projects=[],notes=[];
  try{
    const owners=db.prepare('SELECT id,owner_id,order_id FROM projects ORDER BY id LIMIT 100001').all();
    check(owners.length<=L.files,'REFERENCE_BACKUP_PROJECTS');
    for(const owner of owners){
      if(projects.length===L.projects){notes.push({projectId:owner.id,reason:'PROJECT_LIMIT_OPAQUE'});continue;}
      if(!UUID.test(owner.id)){notes.push({projectId:String(owner.id).slice(0,100),reason:'UNSUPPORTED_ID_OPAQUE'});continue;}
      const workspace=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedRead(root,`workspaces/${owner.id}/workspace.json`,L.workspaceBytes)));
      check(workspace.id===owner.id&&workspace.ownerId===owner.owner_id&&workspace.order?.id===owner.order_id,'REFERENCE_BACKUP_OWNER');
      const deliveries=db.prepare('SELECT manifest_hash FROM deliveries WHERE project_id=?').all(owner.id);
      const deliveryHashes=new Set(deliveries.map(e=>e.manifest_hash)),deliveryMaps=new Map(),candidates=[];
      for(const pin of manifest.files){
        if(pin.bytes<=0||pin.bytes>ASSET_VAULT_LIMITS.fileBytes)continue;
        let mediaType,role;
        const prefix=`workspaces/${owner.id}/`,w=pin.file.startsWith(prefix)?pin.file.slice(prefix.length).match(/^(photo|generated|logo)-([a-f0-9-]{36})\.bin$/):null;
        if(w){
          const asset=(w[1]==='photo'?workspace.assets:w[1]==='generated'?workspace.generatedAssets:workspace.brandAssets)?.[w[2]];
          if(!asset||asset.id!==w[2]||asset.bytes!==pin.bytes||asset.sha256!==pin.sha256)continue;
          mediaType=asset.mime;role=w[1]==='photo'?'original':w[1]==='generated'?'selected':'logo';
        }else{
          const d=pin.file.match(/^deliveries\/([a-f0-9]{64})\/(.+)$/);
          if(!d||!deliveryHashes.has(d[1]))continue;
          if(!deliveryMaps.has(d[1])){
            const raw=await boundedRead(root,`deliveries/${d[1]}/delivery-manifest.json`,L.manifestBytes);
            check(sha(raw)===d[1],'REFERENCE_BACKUP_DELIVERY');
            const value=JSON.parse(raw);
            check(value.projectId===owner.id&&Array.isArray(value.files),'REFERENCE_BACKUP_DELIVERY');
            deliveryMaps.set(d[1],value.files);
          }
          const listed=deliveryMaps.get(d[1]).filter(e=>e.file===d[2]);
          // A valid legacy delivery may include ancillary, unlisted files.
          // Preserve those bytes opaquely instead of treating them as assets.
          if(listed.length!==1||listed[0].bytes!==pin.bytes||listed[0].sha256!==pin.sha256)continue;
          mediaType=mediaFor(d[2]);role='delivery';
        }
        if(['image/png','image/jpeg','image/webp'].includes(mediaType))candidates.push({...pin,mediaType,role});
      }
      const grouped=new Map();
      for(const c of candidates){const k=`${c.sha256}:${c.bytes}:${c.mediaType}`;if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(c);}
      let bytes=0;const selected=[];
      for(const group of [...grouped.values()].filter(g=>g.length>1).sort((a,b)=>a[0].sha256.localeCompare(b[0].sha256))){
        group.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
        const n=group.reduce((s,e)=>s+e.bytes,0);
        if(selected.length+group.length>ASSET_VAULT_LIMITS.files||bytes+n>ASSET_VAULT_LIMITS.logicalBytes)continue;
        selected.push(...group);bytes+=n;
      }
      if(selected.length)projects.push({projectId:owner.id,files:sort(selected).map(({file,mediaType,role})=>({file,mediaType,role}))});
      notes.push({projectId:owner.id,candidateImages:candidates.length,selectedImages:selected.length,selectedLogicalBytes:bytes,
        opaqueCandidateImages:candidates.length-selected.length});
    }
  }finally{db.close();}
  // Reuse the same ownership/material bindings as explicit selection.
  await deriveGroups(root,manifest,projects);check(eq(await inventory(root),manifest.files),'REFERENCE_BACKUP_CHANGED');
  return {policy:'duplicate-images-v1',projects,notes,unselectedFilesRemainOpaque:true};
}
async function* pack(root,m){
  const raw=json(m),size=Buffer.alloc(4);size.writeUInt32BE(raw.length);yield PACK;yield size;yield raw;
  for(const e of m.files)yield*readChunks(root,e.file,e);
}
const bound=max=>{let bytes=0;return new Transform({transform(b,encoding,cb){bytes+=b.length;cb(bytes>max?Error('REFERENCE_BACKUP_STREAM_LIMIT'):null,b);}});};
export async function encryptReferenceSnapshot({root,manifest,key,file}){
  manifest=structuredClone(manifest);validate(manifest);
  check(Buffer.isBuffer(key)&&key.length===32,'REFERENCE_BACKUP_KEY');key=Buffer.from(key);
  try{
    root=await directory(root);file=path.resolve(file);disjoint(root,file);
    await verifyCompact(root,manifest);await directory(path.dirname(file));await freeSpace(path.dirname(file),Math.min(L.objectBytes,manifest.physicalBytes+L.manifestBytes));
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
    const handle=await fs.open(file,'wx',0o600);
    try{
      await handle.writeFile(Buffer.concat([MAGIC,iv]));
      await pipeline(Readable.from(pack(root,manifest)),createGzip({level:6}),cipher,bound(L.objectBytes-MAGIC.length-12-16),createWriteStream(file,{flags:'a',mode:0o600}));
      await handle.write(cipher.getAuthTag(),0,16,(await handle.stat()).size);await handle.sync();
    }finally{await handle.close();}
    await verifyCompact(root,manifest);
    const receipt=await digest(path.dirname(file),path.basename(file));
    return {schemaVersion:2,format:'MOLYVI-BACKUP-2',encryption:'AES-256-GCM',compression:'gzip',bytes:receipt.bytes,sha256:receipt.sha256,logicalBytes:manifest.logicalBytes,physicalBytes:manifest.physicalBytes,providerCalls:0,hostedAdmission:false};
  }finally{key.fill(0);}
}
async function exact(handle,n,position){
  check(Number.isSafeInteger(n)&&n>=0&&n<=L.manifestBytes,'REFERENCE_BACKUP_READ_BOUND');const b=Buffer.alloc(n);let used=0;
  while(used<n){const r=await handle.read(b,used,n-used,position+used);check(r.bytesRead>0,'REFERENCE_BACKUP_TRUNCATED');used+=r.bytesRead;}return b;
}
export async function restoreReferenceSnapshot({file,key,output,expectedSha256}){
  check(Buffer.isBuffer(key)&&key.length===32,'REFERENCE_BACKUP_KEY');key=Buffer.from(key);
  let scratch,r;
  try{
    output=path.resolve(output);file=path.resolve(file);
    const parent=await directory(path.dirname(output));disjoint(file,output);
    // Refuse existing destinations before creating any scratch data.
    try{await fs.lstat(output);throw Error('REFERENCE_BACKUP_OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
    r=await open(path.dirname(file),path.basename(file));
    const actual=await digest(path.dirname(file),path.basename(file));check(HASH.test(expectedSha256)&&actual.sha256===expectedSha256,'REFERENCE_BACKUP_CIPHERTEXT_HASH');
    check(actual.bytes>MAGIC.length+28&&actual.bytes<=L.objectBytes,'REFERENCE_BACKUP_OBJECT_LIMIT');
    // Conservative pre-admission before the authenticated manifest is available:
    // compressed+pack+compact+logical restore, with fixed disk headroom.
    await freeSpace(parent,4*L.sourceBytes+2*L.manifestBytes+L.reservedBytes);
    scratch=await fresh(`${output}.reference-restore-${crypto.randomUUID()}`);
    const compressed=path.join(scratch,'authenticated.gz'),packed=path.join(scratch,'authenticated.pack'),compact=path.join(scratch,'compact');
    const prefix=await exact(r.handle,MAGIC.length+12,0);check(prefix.subarray(0,MAGIC.length).equals(MAGIC),'REFERENCE_BACKUP_FORMAT');
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,prefix.subarray(MAGIC.length));decipher.setAAD(MAGIC);
    decipher.setAuthTag(await exact(r.handle,16,actual.bytes-16));
    // Complete GCM authentication BEFORE decompressing or extracting paths.
    await pipeline(r.handle.createReadStream({start:MAGIC.length+12,end:actual.bytes-17,autoClose:false}),decipher,bound(L.objectBytes),createWriteStream(compressed,{flags:'wx',mode:0o600}));
    await unchanged(r);check((await digest(path.dirname(file),path.basename(file))).sha256===expectedSha256,'REFERENCE_BACKUP_CIPHERTEXT_CHANGED');
    await pipeline(createReadStream(compressed),createGunzip(),bound(L.sourceBytes+L.manifestBytes+PACK.length+4),createWriteStream(packed,{flags:'wx',mode:0o600}));
    const h=await fs.open(packed,'r');let manifest;
    try{
      check((await exact(h,PACK.length,0)).equals(PACK),'REFERENCE_BACKUP_PACK');
      const length=(await exact(h,4,PACK.length)).readUInt32BE(0);check(length>0&&length<=L.manifestBytes,'REFERENCE_BACKUP_METADATA_LIMIT');
      manifest=validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await exact(h,length,PACK.length+4))));
      let position=PACK.length+4+length;check((await h.stat()).size===position+manifest.physicalBytes,'REFERENCE_BACKUP_PACK_LENGTH');
      await fresh(compact);
      for(const e of manifest.files){
        const destination=path.join(compact,e.file);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await directory(path.dirname(destination));
        if(e.bytes)await pipeline(createReadStream(packed,{start:position,end:position+e.bytes-1}),createWriteStream(destination,{flags:'wx',mode:0o600}));
        else await fs.writeFile(destination,'',{flag:'wx',mode:0o600});position+=e.bytes;
      }
    }finally{await h.close();}
    await verifyCompact(compact,manifest);await fresh(output);
    for(const e of manifest.opaque)await copy(compact,{...e,file:`files/${e.file}`},path.join(output,e.file));
    for(const group of manifest.groups){
      const vault=await openAssetVault({vaultDirectory:path.join(compact,'vaults',group.projectId),binding:group.binding,expectedManifestSha256:group.manifestSha256});
      for(const e of group.entries)await vault.withAsset({binding:group.binding,logicalPath:e.logicalPath,versionId:e.versionId},async({bytes})=>{
        const target=path.join(output,e.logicalPath);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await directory(path.dirname(target));await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});
      });
    }
    check(eq(await inventory(output),manifest.logicalManifest.files),'REFERENCE_BACKUP_RESTORE_FILES');
    const requests=manifest.groups.map(g=>({projectId:g.projectId,files:g.entries.map(e=>({file:e.logicalPath,mediaType:e.mediaType,role:e.role}))}));
    const derived=await deriveGroups(output,manifest.logicalManifest,requests);
    check(derived.every((g,i)=>eq(g.binding,manifest.groups[i].binding))&&derived.length===manifest.groups.length,'REFERENCE_BACKUP_RESTORE_BINDING');
    const report=await verifyService(output,manifest.logicalManifest);await verifyCompact(compact,manifest);
    return {manifest,report:{...report,format:'MOLYVI-BACKUP-2',referenceProjects:manifest.groups.length,referenceImagePaths:manifest.groups.reduce((n,g)=>n+g.entries.length,0),opaqueFiles:manifest.opaque.length,logicalBytes:manifest.logicalBytes,physicalBytes:manifest.physicalBytes,providerCalls:0,hostedAdmission:false},scratchDirectory:scratch};
  }catch(e){
    // Preserve partial fresh output for investigation; never delete/overwrite
    // historical/customer directories or retry a failed operation implicitly.
    if(scratch)e.referenceScratchDirectory=scratch;throw e;
  }finally{key.fill(0);await r?.handle.close();}
}
