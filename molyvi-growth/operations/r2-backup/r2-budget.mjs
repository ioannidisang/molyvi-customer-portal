import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
export const R2_LIMITS=Object.freeze({windowDays:31,requests:200,uploadBytes:2_000_000_000,downloadBytes:2_000_000_000,storedBytes:2_000_000_000,objects:20});
const assert=(v,m)=>{if(!v)throw Error(m);};
// Conservative persistent reservation: failures/unknown results keep their usage.
// This limits this operator, not Cloudflare billing or other account projects.
export class R2Budget{
  constructor(file,{now=()=>Date.now()}={}){this.file=path.resolve(file);this.now=now;}
  async ready(){
    const p=path.parse(this.file);let current=p.root;
    for(const bit of this.file.slice(p.root.length).split(path.sep).filter(Boolean)){
      current=path.join(current,bit);try{assert(!(await fs.lstat(current)).isSymbolicLink(),'R2_BUDGET_SYMLINK');}catch(e){if(e.code==='ENOENT')break;throw e;}
    }
    await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});this.db=new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS reservations(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,requests INTEGER NOT NULL,upload_bytes INTEGER NOT NULL,download_bytes INTEGER NOT NULL);');
    await fs.chmod(this.file,0o600);return this;
  }
  summary(){return this.db.prepare('SELECT COALESCE(sum(requests),0) requests,COALESCE(sum(upload_bytes),0) uploadBytes,COALESCE(sum(download_bytes),0) downloadBytes FROM reservations WHERE at>?').get(this.now()-R2_LIMITS.windowDays*86_400_000);}
  reserve({requests=0,uploadBytes=0,downloadBytes=0}={}){
    for(const value of [requests,uploadBytes,downloadBytes])assert(Number.isSafeInteger(value)&&value>=0,'R2_BUDGET_INPUT');assert(requests+uploadBytes+downloadBytes>0,'R2_BUDGET_INPUT');
    this.db.exec('BEGIN IMMEDIATE');try{
      const u=this.summary();for(const [k,v]of Object.entries({requests,uploadBytes,downloadBytes}))assert(u[k]+v<=R2_LIMITS[k],'R2_BUDGET_STOP_'+k.toUpperCase());
      this.db.prepare('INSERT INTO reservations(at,requests,upload_bytes,download_bytes) VALUES(?,?,?,?)').run(this.now(),requests,uploadBytes,downloadBytes);this.db.exec('COMMIT');return this.summary();
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  checkStorage(contents,additionalBytes){
    assert(Array.isArray(contents)&&contents.every(x=>Number.isSafeInteger(x.Size)&&x.Size>=0),'R2_INVENTORY_REQUIRED');
    assert(contents.length+1<=R2_LIMITS.objects&&contents.reduce((n,x)=>n+x.Size,0)+additionalBytes<=R2_LIMITS.storedBytes,'R2_BUDGET_STOP_STORAGE');
  }
  close(){this.db?.close();this.db=null;}
}
