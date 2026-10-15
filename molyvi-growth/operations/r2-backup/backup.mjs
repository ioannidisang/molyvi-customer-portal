// Operator-only encrypted backups. No web route, scheduler, email or provider activation.
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {DatabaseSync,backup} from 'node:sqlite';

const MAGIC=Buffer.from('MOLYVI-BACKUP-1\n');
const PACK=Buffer.from('MOLYVI-PACK-1\n');
const MAX_MANIFEST=16*1024*1024,MAX_BYTES=5_000_000_000,MAX_FILES=100_000;
const DATABASE='accounts/customers.sqlite';
const ROOT_NAMES=new Set(['accounts','deliveries','gmail-journal','hosted-scope.json','mail','workspaces']);
const assert=(v,code)=>{if(!v)throw Error(code);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function safeName(value){
  assert(typeof value==='string'&&value.length<=1024&&!/[\\:\x00-\x1f?#]/.test(value)&&!path.isAbsolute(value)&&value.split('/').every(s=>s&&s!=='.'&&s!=='..'),'UNSAFE_BACKUP_PATH');
  return value;
}
async function ordinary(root,rel=''){
  let target=path.resolve(root);const parts=rel?safeName(rel).split('/'):[];
  // Refuse symlinks in every existing ancestor, including the supplied root.
  const parsed=path.parse(target);let ancestor=parsed.root;
  for(const bit of target.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    ancestor=path.join(ancestor,bit);assert(!(await fs.lstat(ancestor)).isSymbolicLink(),'BACKUP_SYMLINK');
  }
  for(const bit of parts){target=path.join(target,bit);assert(!(await fs.lstat(target)).isSymbolicLink(),'BACKUP_SYMLINK');}
  return target;
}
async function digest(file){const h=crypto.createHash('sha256');let bytes=0;for await(const b of createReadStream(file)){h.update(b);bytes+=b.length;}return {bytes,sha256:h.digest('hex')};}
export async function inventory(root,{skipSqliteSidecars=false}={}){
  await ordinary(root);const files=[];let total=0;
  async function walk(prefix=''){
    for(const e of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){
      const rel=safeName(prefix?prefix+'/'+e.name:e.name);assert(!e.isSymbolicLink(),'BACKUP_SYMLINK');
      if(skipSqliteSidecars&&['accounts/customers.sqlite-wal','accounts/customers.sqlite-shm'].includes(rel))continue;
      if(e.isDirectory())await walk(rel);
      else{
        assert(e.isFile(),'BACKUP_NOT_FILE');const d=await digest(await ordinary(root,rel));total+=d.bytes;
        assert(total<=MAX_BYTES&&files.length<MAX_FILES,'BACKUP_LIMIT');files.push({file:rel,...d});
      }
    }
  }
  await walk();return files.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
}
async function freshDirectory(target){
  await ordinary(path.dirname(path.resolve(target)));
  await fs.mkdir(target,{mode:0o700});return target;
}
function disjoint(a,b){
  a=path.resolve(a);b=path.resolve(b);
  for(const [x,y]of [[a,b],[b,a]]){
    const r=path.relative(x,y);assert(Boolean(r)&&(r.startsWith('..'+path.sep)||r==='..'||path.isAbsolute(r)),'BACKUP_PATHS_OVERLAP');
  }
}
function validateManifest(m){
  assert(m?.schemaVersion===1&&m.kind==='molyvi_private_service_snapshot'&&Array.isArray(m.files)&&m.files.length>0&&m.files.length<=MAX_FILES,'INVALID_BACKUP_MANIFEST');
  const names=new Set();let bytes=0;
  for(const e of m.files){safeName(e.file);assert(!names.has(e.file)&&Number.isSafeInteger(e.bytes)&&e.bytes>=0&&/^[0-9a-f]{64}$/.test(e.sha256),'INVALID_BACKUP_ENTRY');names.add(e.file);bytes+=e.bytes;assert(bytes<=MAX_BYTES,'BACKUP_LIMIT');}
  assert(names.has(DATABASE),'BACKUP_DATABASE_MISSING');return bytes;
}
function databaseSummary(db){
  assert(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','BACKUP_DATABASE_INVALID');
  assert(db.prepare('PRAGMA foreign_key_check').all().length===0,'BACKUP_FOREIGN_KEYS_INVALID');
  const counts={};for(const table of ['accounts','projects','deliveries','reviews','sessions','mail_outbox'])counts[table]=db.prepare('SELECT count(*) n FROM '+table).get().n;
  return {integrity:'ok',userVersion:db.prepare('PRAGMA user_version').get().user_version,counts};
}
export async function snapshot({source,output,release}){
  source=path.resolve(source);output=path.resolve(output);disjoint(source,output);
  assert(/^[0-9a-f]{40}$/.test(release),'BACKUP_RELEASE_REQUIRED');
  await ordinary(source);
  for(const name of await fs.readdir(source))assert(ROOT_NAMES.has(name),'UNEXPECTED_SERVICE_ROOT');
  const db=new DatabaseSync(await ordinary(source,DATABASE),{readOnly:true});
  let made=false;
  try{
    const version=db.prepare('PRAGMA data_version').get().data_version;
    const sourceFiles=(await inventory(source,{skipSqliteSidecars:true})).filter(e=>e.file!==DATABASE);
    await freshDirectory(output);made=true;
    await fs.mkdir(path.join(output,'accounts'),{mode:0o700});
    await backup(db,path.join(output,DATABASE));
    // A self-contained snapshot must not depend on WAL/SHM sidecars. Change only
    // the copied database's journal mode, never the running source database.
    const copiedDb=new DatabaseSync(path.join(output,DATABASE));try{copiedDb.exec('PRAGMA journal_mode=DELETE;');}finally{copiedDb.close();}
    await fs.chmod(path.join(output,DATABASE),0o600);
    for(const e of sourceFiles){
      const target=path.join(output,e.file);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      await fs.copyFile(await ordinary(source,e.file),target,1);await fs.chmod(target,0o600);
    }
    const after=(await inventory(source,{skipSqliteSidecars:true})).filter(e=>e.file!==DATABASE);
    assert(JSON.stringify(after)===JSON.stringify(sourceFiles)&&db.prepare('PRAGMA data_version').get().data_version===version,'SOURCE_CHANGED_DURING_BACKUP_RETRY_WHEN_IDLE');
    const files=await inventory(output),copy=dbSnapshot(output);
    for(const e of sourceFiles){const actual=files.find(f=>f.file===e.file);assert(actual?.sha256===e.sha256&&actual.bytes===e.bytes,'SNAPSHOT_COPY_CHANGED');}
    const m={schemaVersion:1,kind:'molyvi_private_service_snapshot',createdAt:new Date().toISOString(),release,consistency:'native_sqlite_and_unchanged_files_and_database_during_copy',database:copy,files};
    validateManifest(m);await verifyService(output,m);return m;
  }catch(e){if(made)await fs.rm(output,{recursive:true});throw e;}
  finally{db.close();}
}
function dbSnapshot(root){const db=new DatabaseSync(path.join(root,DATABASE),{readOnly:true});try{return databaseSummary(db);}finally{db.close();}}
export async function verifyService(root,m){
  validateManifest(m);assert(JSON.stringify(await inventory(root))===JSON.stringify(m.files),'RESTORE_FILES_MISMATCH');
  assert(JSON.stringify(dbSnapshot(root))===JSON.stringify(m.database),'RESTORE_DATABASE_MISMATCH');
  const db=new DatabaseSync(await ordinary(root,DATABASE),{readOnly:true});let images=0,deliveries=0,mailPayloads=0;
  try{
    for(const p of db.prepare('SELECT * FROM projects').all()){
      assert(/^[a-f0-9-]{36}$/.test(p.id),'RESTORE_PROJECT_ID');
      const w=JSON.parse(await fs.readFile(await ordinary(root,'workspaces/'+p.id+'/workspace.json'),'utf8'));
      assert(w.id===p.id&&w.ownerId===p.owner_id&&w.order.id===p.order_id,'RESTORE_PROJECT_MISMATCH');
    }
    for(const d of db.prepare('SELECT * FROM deliveries').all()){
      assert(/^[a-f0-9]{64}$/.test(d.manifest_hash)&&/^[a-f0-9]{64}$/.test(d.zip_hash),'RESTORE_DELIVERY_HASH');
      const rel='deliveries/'+d.manifest_hash,raw=await fs.readFile(await ordinary(root,rel+'/delivery-manifest.json'));
      assert(hash(raw)===d.manifest_hash,'RESTORE_DELIVERY_MANIFEST');const delivery=JSON.parse(raw);
      assert(delivery.projectId===d.project_id,'RESTORE_DELIVERY_PROJECT');
      for(const e of delivery.files){const a=await digest(await ordinary(root,rel+'/'+safeName(e.file)));assert(a.sha256===e.sha256&&a.bytes===e.bytes,'RESTORE_DELIVERY_FILE');if(/\.(png|jpe?g|webp)$/i.test(e.file))images++;}
      assert((await digest(await ordinary(root,rel+'/Molyvi-Service-Delivery.zip'))).sha256===d.zip_hash,'RESTORE_DELIVERY_ZIP');deliveries++;
    }
    const rows=db.prepare('SELECT payload FROM mail_outbox').all();
    if(rows.length){
      const key=await fs.readFile(await ordinary(root,'mail/mail-encryption-key.bin'));assert(key.length===32,'RESTORE_MAIL_KEY');
      for(const row of rows){const b=Buffer.from(row.payload,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8'));mailPayloads++;}key.fill(0);
    }
    return {status:'PASS',files:m.files.length,bytes:m.files.reduce((n,e)=>n+e.bytes,0),database:m.database,deliveries,deliveredImageFiles:images,mailPayloadsVerified:mailPayloads,mailSent:false,liveStorageOverwritten:false};
  }finally{db.close();}
}
async function* pack(root,m){
  const json=Buffer.from(JSON.stringify(m)),size=Buffer.alloc(4);assert(json.length<=MAX_MANIFEST,'BACKUP_MANIFEST_LIMIT');size.writeUInt32BE(json.length);
  yield PACK;yield size;yield json;
  for(const e of m.files){const h=crypto.createHash('sha256');let count=0;for await(const b of createReadStream(await ordinary(root,e.file))){count+=b.length;h.update(b);yield b;}assert(count===e.bytes&&h.digest('hex')===e.sha256,'SNAPSHOT_CHANGED_DURING_ENCRYPTION');}
}
export async function encryptSnapshot({root,manifest,key,file}){
  validateManifest(manifest);assert(Buffer.isBuffer(key)&&key.length===32,'BACKUP_KEY_REQUIRED');await ordinary(path.dirname(path.resolve(file)));
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
  const h=await fs.open(file,'wx',0o600);try{await h.writeFile(Buffer.concat([MAGIC,iv]));await h.close();
    await pipeline(Readable.from(pack(root,manifest)),createGzip({level:6}),cipher,createWriteStream(file,{flags:'a',mode:0o600}));
    const append=await fs.open(file,'a');try{await append.writeFile(cipher.getAuthTag());await append.sync();}finally{await append.close();}
    return {schemaVersion:1,format:'MOLYVI-BACKUP-1',encryption:'AES-256-GCM',compression:'gzip',...await digest(file)};
  }catch(e){await h.close().catch(()=>{});await fs.rm(file,{force:true});throw e;}
}
async function exact(h,n,position){const b=Buffer.alloc(n);let used=0;while(used<n){const r=await h.read(b,used,n-used,position+used);assert(r.bytesRead,'BACKUP_TRUNCATED');used+=r.bytesRead;}return b;}
export async function restoreSnapshot({file,key,output,expectedSha256}){
  assert(Buffer.isBuffer(key)&&key.length===32,'BACKUP_KEY_REQUIRED');
  file=await ordinary(path.dirname(path.resolve(file)),path.basename(file));output=path.resolve(output);disjoint(file,output);
  const actual=await digest(file);assert(/^[a-f0-9]{64}$/.test(expectedSha256)&&actual.sha256===expectedSha256,'ENCRYPTED_BACKUP_HASH_MISMATCH');
  const input=await fs.open(file,'r');let made=false;const temp=output+'.authenticated-pack-'+crypto.randomUUID();
  try{
    assert(actual.bytes>MAGIC.length+12+16,'BACKUP_TRUNCATED');
    const prefix=await exact(input,MAGIC.length+12,0);assert(prefix.subarray(0,MAGIC.length).equals(MAGIC),'BACKUP_FORMAT_UNSUPPORTED');
    const c=crypto.createDecipheriv('aes-256-gcm',key,prefix.subarray(MAGIC.length));c.setAAD(MAGIC);c.setAuthTag(await exact(input,16,actual.bytes-16));
    let expanded=0;const bound=new Transform({transform(b,enc,cb){expanded+=b.length;cb(expanded>MAX_BYTES+MAX_MANIFEST+PACK.length+4?Error('BACKUP_EXPANSION_LIMIT'):null,b);}});
    // Authenticate fully before extracting any customer file.
    await ordinary(path.dirname(output));await pipeline(createReadStream(file,{start:MAGIC.length+12,end:actual.bytes-17}),c,createGunzip(),bound,createWriteStream(temp,{flags:'wx',mode:0o600}));
    const h=await fs.open(temp,'r');let manifest;
    try{
      assert((await exact(h,PACK.length,0)).equals(PACK),'BACKUP_PACK_FORMAT');const n=(await exact(h,4,PACK.length)).readUInt32BE(0);assert(n>0&&n<=MAX_MANIFEST,'BACKUP_MANIFEST_LIMIT');
      manifest=JSON.parse((await exact(h,n,PACK.length+4)).toString('utf8'));const bytes=validateManifest(manifest);let position=PACK.length+4+n;
      assert((await h.stat()).size===position+bytes,'BACKUP_PACK_LENGTH');
      await freshDirectory(output);made=true;
      for(const e of manifest.files){
        const target=path.join(output,e.file);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
        if(e.bytes)await pipeline(createReadStream(temp,{start:position,end:position+e.bytes-1}),createWriteStream(target,{flags:'wx',mode:0o600}));else await fs.writeFile(target,'',{flag:'wx',mode:0o600});position+=e.bytes;
      }
    }finally{await h.close();}
    return {manifest,report:await verifyService(output,manifest)};
  }catch(e){if(made)await fs.rm(output,{recursive:true});throw e;}
  finally{await input.close();await fs.rm(temp,{force:true});}
}
