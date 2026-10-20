// Private, bucket-scoped transport; deletion is restricted to catalogued backups.
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {R2_LIMITS} from './r2-budget.mjs';
import {retentionKey} from './retention.mjs';
const BUCKET='molyvi-private-backups',MAX_ENCRYPTED=512_000_000;
const FORMATS=Object.freeze({'MOLYVI-BACKUP-1':'1','MOLYVI-BACKUP-2':'2'}),MAGIC_BYTES=16;
const assert=(v,code)=>{if(!v)throw Error(code);};
export function r2Options(c){
  assert(c&&Object.keys(c).sort().join(',')==='accessKeyId,accountId,bucket,jurisdiction,secretAccessKey','R2_CONFIG_FIELDS');
  assert(c.bucket===BUCKET&&c.jurisdiction==='eu'&&/^[a-f0-9]{32}$/.test(c.accountId)&&/^[a-f0-9]{32}$/i.test(c.accessKeyId)&&/^[a-f0-9]{64}$/i.test(c.secretAccessKey),'R2_SCOPE_REQUIRED');
  return {region:'auto',endpoint:'https://'+c.accountId+'.eu.r2.cloudflarestorage.com',forcePathStyle:true,maxAttempts:1,
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey}};
}
function objectKey(key){assert(typeof key==='string'&&/^snapshots\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]{8,100}\/service-backup\.mlvb$/.test(key),'R2_OBJECT_KEY_SCOPE');return key;}
function expected(e){
  assert(e&&Number.isSafeInteger(e.bytes)&&e.bytes>43&&e.bytes<=MAX_ENCRYPTED&&/^[a-f0-9]{64}$/.test(e.sha256),'R2_RECEIPT_REQUIRED');
  const hasFormat=Object.hasOwn(e,'format');if(hasFormat)assert(Object.hasOwn(FORMATS,e.format),'R2_RECEIPT_FORMAT');
  return Object.freeze({bytes:e.bytes,sha256:e.sha256,...(hasFormat?{format:e.format}:{})});
}
function archiveFormat(prefix){
  for(const format of Object.keys(FORMATS))if(prefix.equals(Buffer.from(format+'\n')))return format;
  throw Error('R2_ENCRYPTED_ARCHIVE_ONLY');
}
function matchFormat(format,receipt,remoteFormat){
  if(receipt.format)assert(format===receipt.format,'R2_ARCHIVE_FORMAT_MISMATCH');
  if(remoteFormat!==undefined)assert(FORMATS[format]===remoteFormat,'R2_REMOTE_FORMAT_MISMATCH');
  else if(format==='MOLYVI-BACKUP-2')throw Error('R2_REMOTE_FORMAT_MISMATCH');
}
async function safeLocal(file,{mustExist=true}={}){
  file=path.resolve(file);const p=path.parse(file);let current=p.root;
  for(const bit of file.slice(p.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,bit);try{assert(!(await fs.lstat(current)).isSymbolicLink(),'R2_LOCAL_SYMLINK');}catch(e){if(e.code==='ENOENT'&&!mustExist&&current===file)break;throw e;}
  }return file;
}
async function checksum(file){const sha=crypto.createHash('sha256'),md5=crypto.createHash('md5');let bytes=0;for await(const b of createReadStream(file)){bytes+=b.length;assert(bytes<=MAX_ENCRYPTED,'R2_BACKUP_TOO_LARGE');sha.update(b);md5.update(b);}return {bytes,sha256:sha.digest('hex'),md5:md5.digest('base64')};}
export async function createR2Transport(config,{sdk,budget}={}){
  assert(budget?.reserve&&budget?.checkStorage,'R2_DURABLE_BUDGET_REQUIRED');
  const options=r2Options(config);sdk??=await import('@aws-sdk/client-s3');const client=new sdk.S3Client(options);
  async function send(kind,input){budget.reserve({requests:1});try{return await client.send(new sdk[kind+'Command'](input),{abortSignal:AbortSignal.timeout(300_000)});}catch(e){const code=Number(e?.$metadata?.httpStatusCode)||0;const safe=Error('R2_'+kind.toUpperCase()+'_FAILED_HTTP_'+code);safe.httpStatus=code;throw safe;}}
  function verifiedMetadata(result,e){
    assert(result.ContentLength===e.bytes&&result.Metadata?.['molyvi-sha256']===e.sha256,'R2_REMOTE_BYTES_MISMATCH');
    const format=result.Metadata?.['molyvi-format'];
    assert(format===undefined||format==='1'||format==='2','R2_REMOTE_FORMAT_MISMATCH');
    // Older V1 objects can lack format metadata. Their exact length/hash still
    // must match; V2 has no such legacy exception.
    if(e.format)assert(format===FORMATS[e.format]||(format===undefined&&e.format==='MOLYVI-BACKUP-1'),'R2_REMOTE_FORMAT_MISMATCH');
  }
  async function head(key,e){objectKey(key);e=expected(e);const result=await send('HeadObject',{Bucket:BUCKET,Key:key});verifiedMetadata(result,e);return result;}
  return {
    async verify(key,receipt){return head(key,receipt);},
    async list(){
      const r=await send('ListObjectsV2',{Bucket:BUCKET,MaxKeys:21}),rows=r.Contents??[];
      assert(!r.IsTruncated&&rows.length<=R2_LIMITS.objects&&rows.every(x=>typeof x.Key==='string'&&Number.isSafeInteger(x.Size)&&x.Size>=0)&&rows.reduce((n,x)=>n+x.Size,0)<=R2_LIMITS.storedBytes,'R2_BUDGET_STOP_STORAGE');
      return rows.map(x=>({Key:x.Key,Size:x.Size,ETag:x.ETag}));
    },
    requireDeleteBudget(count){assert(Number.isSafeInteger(count)&&count>=0&&count<=20,'R2_DELETE_COUNT_INVALID');assert(budget.summary().requests+count*3+(count?1:0)<=R2_LIMITS.requests,'R2_BUDGET_STOP_REQUESTS');},
    async deleteVerified(r){
      retentionKey(r.key);expected(r);assert(typeof r.etag==='string'&&r.etag.length>0,'R2_DELETE_ETAG_REQUIRED');
      const before=await head(r.key,r);assert(before.ETag===r.etag,'R2_DELETE_OBJECT_CHANGED');
      await send('DeleteObject',{Bucket:BUCKET,Key:r.key});
      let absent=false;try{await send('HeadObject',{Bucket:BUCKET,Key:r.key});}catch(e){if(e.httpStatus!==404)throw e;absent=true;}
      assert(absent,'R2_DELETE_NOT_CONFIRMED');return {status:'PASS',key:r.key,confirmedAbsent:true};
    },
    async upload({file,key,receipt}){
      objectKey(key);receipt=expected(receipt);file=await safeLocal(file);assert((await fs.stat(file)).isFile(),'R2_LOCAL_NOT_FILE');
      let format;const h=await fs.open(file,'r');try{const prefix=Buffer.alloc(MAGIC_BYTES),read=await h.read(prefix,0,MAGIC_BYTES,0);format=archiveFormat(prefix.subarray(0,read.bytesRead));}finally{await h.close();}
      if(receipt.format)assert(format===receipt.format,'R2_ARCHIVE_FORMAT_MISMATCH');receipt=Object.freeze({...receipt,format});
      const actual=await checksum(file);assert(actual.bytes===receipt.bytes&&actual.sha256===receipt.sha256,'R2_SOURCE_HASH_MISMATCH');
      try{const existing=await head(key,receipt);return {status:'PASS',duplicate:true,key,format,bytes:actual.bytes,sha256:actual.sha256,etag:existing.ETag};}catch(e){if(e.httpStatus!==404)throw e;}
      const list=await send('ListObjectsV2',{Bucket:BUCKET,MaxKeys:21});assert(!list.IsTruncated,'R2_BUDGET_STOP_STORAGE');budget.checkStorage(list.Contents??[],actual.bytes);
      budget.reserve({uploadBytes:actual.bytes});
      const body=createReadStream(file);
      let put;try{put=await send('PutObject',{Bucket:BUCKET,Key:key,Body:body,ContentLength:actual.bytes,ContentType:'application/octet-stream',ContentMD5:actual.md5,
        CacheControl:'private, no-store',StorageClass:'STANDARD',IfNoneMatch:'*',Metadata:{'molyvi-sha256':actual.sha256,'molyvi-format':FORMATS[format]}});}finally{body.destroy();}
      const readback=await head(key,receipt);
      return {status:'PASS',duplicate:false,key,format,bytes:actual.bytes,sha256:actual.sha256,etag:readback.ETag??put.ETag??null,requestId:put.$metadata?.requestId??null};
    },
    async download({file,key,receipt}){
      objectKey(key);receipt=expected(receipt);file=await safeLocal(file,{mustExist:false});
      try{await fs.lstat(file);throw Error('R2_DOWNLOAD_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
      budget.reserve({downloadBytes:receipt.bytes});
      const result=await send('GetObject',{Bucket:BUCKET,Key:key});
      try{verifiedMetadata(result,receipt);}catch(e){result.Body?.destroy?.();throw e;}
      const tmp=file+'.partial-'+crypto.randomUUID(),sha=crypto.createHash('sha256'),prefix=Buffer.alloc(MAGIC_BYTES);let bytes=0,prefixBytes=0;
      const guard=new Transform({transform(b,enc,cb){bytes+=b.length;if(bytes>receipt.bytes){cb(Error('R2_DOWNLOAD_LENGTH_EXCEEDED'));return;}const copied=Math.min(b.length,MAGIC_BYTES-prefixBytes);if(copied){b.copy(prefix,prefixBytes,0,copied);prefixBytes+=copied;}sha.update(b);cb(null,b);}});
      try{
        await pipeline(result.Body,guard,createWriteStream(tmp,{flags:'wx',mode:0o600}));
        assert(bytes===receipt.bytes&&sha.digest('hex')===receipt.sha256,'R2_DOWNLOAD_HASH_MISMATCH');
        const format=archiveFormat(prefix.subarray(0,prefixBytes));matchFormat(format,receipt,result.Metadata?.['molyvi-format']);
        // COPYFILE_EXCL also refuses an output created while the transfer ran.
        await fs.copyFile(tmp,file,1);await fs.chmod(file,0o600);return {status:'PASS',key,format,bytes,sha256:receipt.sha256,downloadedFromR2:true};
      }finally{await fs.rm(tmp,{force:true});}
    },
    async anonymousReadStatus(key){
      objectKey(key);const url=options.endpoint+'/'+BUCKET+'/'+key;
      budget.reserve({requests:1});
      const response=await fetch(url,{method:'GET',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15_000)});await response.body?.cancel();
      assert([400,401,403,404].includes(response.status),'R2_ANONYMOUS_ACCESS_NOT_REFUSED');return {status:'PASS',httpStatus:response.status,anonymousDataReturned:false};
    },
    close(){client.destroy();}
  };
}
