import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {IntakeError,prepareStorage} from './intake-store.mjs';
import {withBasicSourceMutation} from './basic-source-retention.mjs';

const validId = id => typeof id==='string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id);

// Single-process local prototype. Production needs database transactions / distributed leases.
export class TaskStore {
  constructor(storage) {this.storage=storage;this.locks=new Map();}
  async ready() {this.storage=await prepareStorage(this.storage);return this;}
  async serial(id,operation) {
    if(!validId(id)) throw new IntakeError('INVALID_PROJECT_ID',400);
    const previous=this.locks.get(id)??Promise.resolve();
    const next=previous.catch(()=>{}).then(operation);
    this.locks.set(id,next);
    try {return await next;} finally {if(this.locks.get(id)===next)this.locks.delete(id);}
  }
  async directory(id,create=false) {
    const directory=path.join(this.storage,id);
    if(create) await fs.mkdir(directory,{mode:0o700});
    const info=await fs.lstat(directory);
    if(info.isSymbolicLink() || !info.isDirectory()) throw new IntakeError('UNSAFE_STORAGE',500);
    return directory;
  }
  async write(directory,record) {
    return withBasicSourceMutation(directory,()=>this.#writeUnlocked(directory,record));
  }
  async #writeUnlocked(directory,record) {
    const temporary=path.join(directory,`pending-${crypto.randomUUID()}.json`);
    const file=await fs.open(temporary,'wx',0o600);
    try {await file.writeFile(JSON.stringify(record)+'\n');await file.sync();} finally {await file.close();}
    // Windows readers / sync clients can briefly hold the destination. Preserve
    // atomic rename, with a bounded retry; never fall back to truncating it.
    for(let attempt=0;;attempt++){
      try{await fs.rename(temporary,path.join(directory,'workspace.json'));break;}
      catch(error){if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=4)throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
    }
    if(process.platform!=='win32') {const handle=await fs.open(directory,'r');try {await handle.sync();}finally {await handle.close();}}
  }
  async create(record) {
    return this.serial(record.id,async()=>{
      const directory=await this.directory(record.id,true);await this.write(directory,record);return structuredClone(record);
    });
  }
  async load(id,ownerId) {
    let directory;
    try {directory=await this.directory(id);} catch(error) {if(error.code==='ENOENT')throw new IntakeError('PROJECT_NOT_FOUND',404);throw error;}
    const file=path.join(directory,'workspace.json');
    if((await fs.lstat(file)).isSymbolicLink()) throw new IntakeError('UNSAFE_STORAGE',500);
    const record=JSON.parse(await fs.readFile(file,'utf8'));
    if(record.ownerId!==ownerId) throw new IntakeError('NOT_OWNER',403);
    return {directory,record};
  }
  async transact(id,ownerId,operation) {
    return this.serial(id,async()=>{
      let sourceDirectory;
      try{sourceDirectory=await this.directory(id);}catch(error){if(error.code==='ENOENT')throw new IntakeError('PROJECT_NOT_FOUND',404);throw error;}
      return withBasicSourceMutation(sourceDirectory,async()=>{
      const {directory,record}=await this.load(id,ownerId);
      const before=JSON.stringify(record);
      const result=await operation(record);
      if(JSON.stringify(record)!==before) await this.#writeUnlocked(directory,record);
      return {record:structuredClone(record),result};
      });
    });
  }
  async read(id,ownerId) {return this.serial(id,async()=>structuredClone((await this.load(id,ownerId)).record));}
}
