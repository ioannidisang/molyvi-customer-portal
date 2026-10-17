import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {prepareStorage,IntakeError} from './intake-store.mjs';

const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const fail=(code,status=400)=>{throw new IntakeError(code,status);};
const email=v=>typeof v==='string'&&v.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?v.trim().toLowerCase():fail('INVALID_LOGIN',401);

// Durable local pilot metadata. Provisioning and grants have no public HTTP API.
// Existing workspace JSON remains authoritative; this database owns access and review receipts.
export class CustomerStore {
  constructor(storage,{now=()=>Date.now(),sessionMs=8*60*60*1000}={}){if(typeof now!=='function'||!Number.isInteger(sessionMs)||sessionMs<1000||sessionMs>8*60*60*1000)fail('INVALID_SESSION_CONFIG');this.storage=storage;this.now=now;this.sessionMs=sessionMs;}
  async ready(){
    this.storage=await prepareStorage(this.storage);
    for(const name of ['customers.sqlite','customers.sqlite-wal','customers.sqlite-shm']){
      try{if((await fs.lstat(path.join(this.storage,name))).isSymbolicLink())fail('UNSAFE_STORAGE',500);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    this.db=new DatabaseSync(path.join(this.storage,'customers.sqlite'));
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(![0,1,2].includes(version)){this.db.close();this.db=null;fail('CUSTOMER_SCHEMA_UNSUPPORTED',500);}
    // delivery_feedback is an additive v2-compatible extension: existing tables and
    // receipts keep their format, so the previous release can still open this DB.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),owner_id TEXT NOT NULL,label TEXT NOT NULL,order_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),project_id TEXT,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(bucket TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),manifest_hash TEXT NOT NULL,zip_hash TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(project_id,manifest_hash));
      CREATE TABLE IF NOT EXISTS reviews(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),account_id TEXT NOT NULL REFERENCES accounts(id),manifest_hash TEXT NOT NULL,accepted INTEGER NOT NULL,mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,event TEXT NOT NULL,account_id TEXT,reference TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_links(project_id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),owner_id TEXT NOT NULL,order_id TEXT NOT NULL UNIQUE,body_hash TEXT NOT NULL,email TEXT,status TEXT NOT NULL,label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_outbox(id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,expires INTEGER,code_hash TEXT,last_error TEXT,receipt TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code_requests(bucket TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_feedback(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES deliveries(id),account_id TEXT NOT NULL REFERENCES accounts(id),manifest_hash TEXT NOT NULL,request_id TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(account_id,request_id));
      CREATE INDEX IF NOT EXISTS delivery_feedback_delivery ON delivery_feedback(delivery_id,created);
      CREATE INDEX IF NOT EXISTS delivery_feedback_account ON delivery_feedback(account_id,created);
      PRAGMA user_version=2;`);
    if(!this.db.prepare('PRAGMA table_info(mail_outbox)').all().some(c=>c.name==='created'))this.db.exec('ALTER TABLE mail_outbox ADD COLUMN created INTEGER NOT NULL DEFAULT 0; UPDATE mail_outbox SET created=next_at;');
    await fs.chmod(path.join(this.storage,'customers.sqlite'),0o600);
    return this;
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(event,accountId,reference){this.db.prepare('INSERT INTO audit(event,account_id,reference,created) VALUES(?,?,?,?)').run(event,accountId??null,reference??null,this.now());}
  provision({address,name}){
    address=email(address);if(typeof name!=='string'||!name.trim()||name.length>120||/[\x00-\x1f]/.test(name))fail('INVALID_ACCOUNT');
    const current=this.db.prepare('SELECT id,email,name FROM accounts WHERE email=?').get(address);if(current)return current;
    const id=crypto.randomUUID();this.db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(id,address,name);this.audit('account_provisioned',id,null);return {id,email:address,name};
  }
  grant({accountId,projectId,ownerId,label,orderId}){
    if(![accountId,projectId,ownerId].every(uuid)||typeof label!=='string'||!label||label.length>160||typeof orderId!=='string'||!orderId||orderId.length>120)fail('INVALID_GRANT');
    const old=this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if(old){if(old.account_id!==accountId||old.owner_id!==ownerId||old.order_id!==orderId)fail('PROJECT_ALREADY_ASSIGNED',409);return;}
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(projectId,accountId,ownerId,label,orderId);this.audit('project_granted',accountId,projectId);
  }
  issueCode(accountId,{ttlMs=15*60*1000}={}){
    return this.transaction(()=>this.issueCodeWithinTransaction(accountId,{ttlMs}).code);
  }
  issueCodeWithinTransaction(accountId,{ttlMs=15*60*1000}={}){
    if(!uuid(accountId)||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>60*60*1000)fail('INVALID_CODE_REQUEST');
    const code=crypto.randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE codes SET used=1 WHERE account_id=?').run(accountId);
    this.db.prepare("UPDATE mail_outbox SET status='superseded' WHERE account_id=? AND kind='access_code' AND status IN ('queued','retry_wait')").run(accountId);
    const expires=this.now()+ttlMs;this.db.prepare('INSERT INTO codes VALUES(?,?,?,0)').run(hash(code),accountId,expires);
    return {code,expires,codeHash:hash(code)}; // Trusted code issuer; no public response.
  }
  login({address,code,client='loopback'}){
    address=email(address);const now=this.now(),buckets=[hash('email:'+address),hash('client:'+client)];
    const result=this.transaction(()=>{
      this.db.prepare('DELETE FROM attempts WHERE started<?').run(now-15*60*1000);
      for(const [index,bucket] of buckets.entries()){
        const r=this.db.prepare('SELECT count FROM attempts WHERE bucket=?').get(bucket);
        if(r&&r.count>=(index===0?5:100))return {limited:true};
      }
      for(const bucket of buckets)this.db.prepare('INSERT INTO attempts VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(bucket,now);
      const account=this.db.prepare('SELECT * FROM accounts WHERE email=?').get(address);
      const credential=typeof code==='string'&&/^[\w-]{43}$/.test(code)?this.db.prepare('SELECT * FROM codes WHERE hash=?').get(hash(code)):null;
      if(!account||!credential||credential.account_id!==account.id||credential.used||credential.expires<=now)return {};
      this.db.prepare('UPDATE codes SET used=1 WHERE hash=?').run(credential.hash);
      // The paid email is a pending claim until its one-time credential is used.
      for(const link of this.db.prepare("SELECT * FROM payment_links WHERE account_id=? AND status='pending_verification'").all(account.id)){
        this.grant({accountId:account.id,projectId:link.project_id,ownerId:link.owner_id,label:link.label,orderId:link.order_id});
        this.db.prepare("UPDATE payment_links SET status='granted' WHERE project_id=?").run(link.project_id);
      }
      const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(32).toString('hex');
      const projects=this.db.prepare('SELECT id FROM projects WHERE account_id=? ORDER BY id').all(account.id);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(token),account.id,projects[0]?.id??null,csrf,now+this.sessionMs);
      this.db.prepare('DELETE FROM attempts WHERE bucket=?').run(buckets[0]);
      this.audit('login',account.id,null);return {token,csrf,expires:now+this.sessionMs};
    });
    if(result.limited)fail('LOGIN_RATE_LIMIT',429);if(!result.token)fail('INVALID_LOGIN',401);return result;
  }
  authenticate(token){
    if(typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token))fail('SESSION_REQUIRED',401);
    const r=this.db.prepare('SELECT * FROM sessions WHERE hash=?').get(hash(token));
    if(!r||r.expires<=this.now())fail('SESSION_REQUIRED',401);
    const project=r.project_id?this.project(r.account_id,r.project_id):null;
    return {accountId:r.account_id,projectId:project?.id??null,ownerId:project?.owner_id??null,csrf:r.csrf,expires:r.expires};
  }
  assertCsrf(session,value){if(typeof value!=='string'||value.length!==session.csrf.length||!crypto.timingSafeEqual(Buffer.from(value),Buffer.from(session.csrf)))fail('CSRF_REQUIRED',403);}
  project(accountId,id){if(!uuid(id))fail('NOT_FOUND',404);const r=this.db.prepare('SELECT * FROM projects WHERE id=? AND account_id=?').get(id,accountId);if(!r)fail('NOT_FOUND',404);return r;}
  select(token,projectId){const session=this.authenticate(token);this.project(session.accountId,projectId);this.db.prepare('UPDATE sessions SET project_id=? WHERE hash=?').run(projectId,hash(token));return this.authenticate(token);}
  logout(token){const session=this.authenticate(token);this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));this.audit('logout',session.accountId,null);}
  registerDelivery({projectId,manifestHash,zipHash}){
    if(!uuid(projectId)||![manifestHash,zipHash].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)))fail('INVALID_DELIVERY');
    const existing=this.db.prepare('SELECT * FROM deliveries WHERE project_id=? AND manifest_hash=?').get(projectId,manifestHash);
    if(existing){if(existing.zip_hash!==zipHash)fail('DELIVERY_CONFLICT',409);return existing;}
    const id=crypto.randomUUID();this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?)').run(id,projectId,manifestHash,zipHash,this.now());return this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
  }
  delivery(accountId,id){if(!uuid(id))fail('NOT_FOUND',404);const r=this.db.prepare('SELECT d.* FROM deliveries d JOIN projects p ON p.id=d.project_id WHERE d.id=? AND p.account_id=?').get(id,accountId);if(!r)fail('NOT_FOUND',404);return r;}
  feedback(session,deliveryId){
    const delivery=this.delivery(session.accountId,deliveryId);
    return {deliveryId,manifestHash:delivery.manifest_hash,items:this.db.prepare('SELECT id,category,message,created FROM delivery_feedback WHERE delivery_id=? AND account_id=? ORDER BY created,rowid').all(deliveryId,session.accountId).map(r=>({id:r.id,category:r.category,message:r.message,createdAt:new Date(r.created).toISOString(),status:'received'})),customerAccepted:false,workStarted:false,creditsCharged:false};
  }
  recordFeedback(session,{deliveryId,manifestHash,requestId,category,message}){
    if(!uuid(requestId)||!['appearance','photos','text','seller','orders','policies','other'].includes(category)||typeof message!=='string'||!message.trim()||message.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message))fail('INVALID_FEEDBACK',422);
    message=message.trim();
    return this.transaction(()=>{
      const delivery=this.delivery(session.accountId,deliveryId);if(delivery.manifest_hash!==manifestHash)fail('DELIVERY_VERSION_CHANGED',409);
      const existing=this.db.prepare('SELECT * FROM delivery_feedback WHERE account_id=? AND request_id=?').get(session.accountId,requestId);
      if(existing){if(existing.delivery_id!==deliveryId||existing.manifest_hash!==manifestHash||existing.category!==category||existing.message!==message)fail('FEEDBACK_REQUEST_CONFLICT',409);return {duplicate:true,id:existing.id,feedback:this.feedback(session,deliveryId)};}
      // Abuse/storage bounds, not package allowances. No job or credit operation is performed here.
      if(this.db.prepare('SELECT count(*) n FROM delivery_feedback WHERE account_id=? AND created>?').get(session.accountId,this.now()-60*60*1000).n>=20)fail('FEEDBACK_RATE_LIMIT',429);
      if(this.db.prepare('SELECT count(*) n FROM delivery_feedback WHERE delivery_id=?').get(deliveryId).n>=100)fail('FEEDBACK_STORAGE_LIMIT',429);
      const id=crypto.randomUUID();this.db.prepare('INSERT INTO delivery_feedback VALUES(?,?,?,?,?,?,?,?)').run(id,deliveryId,session.accountId,manifestHash,requestId,category,message,this.now());this.audit('delivery_feedback_recorded',session.accountId,id);
      return {duplicate:false,id,feedback:this.feedback(session,deliveryId)};
    });
  }
  review(session,{deliveryId,manifestHash,acknowledged}){
    if(acknowledged!==true)fail('ACKNOWLEDGEMENT_REQUIRED',422);
    return this.transaction(()=>{
      const delivery=this.delivery(session.accountId,deliveryId);if(delivery.manifest_hash!==manifestHash)fail('DELIVERY_VERSION_CHANGED',409);
      const existing=this.db.prepare('SELECT * FROM reviews WHERE delivery_id=?').get(deliveryId);if(existing)return {duplicate:true,acceptedAt:new Date(existing.accepted).toISOString(),mode:existing.mode};
      this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?)').run(deliveryId,session.accountId,manifestHash,this.now(),'local_test');this.audit('technical_review_recorded',session.accountId,deliveryId);
      return {duplicate:false,acceptedAt:new Date(this.now()).toISOString(),mode:'local_test'};
    });
  }
  view(session){
    const a=this.db.prepare('SELECT name,email FROM accounts WHERE id=?').get(session.accountId);
    return {account:a,csrfToken:session.csrf,selectedProjectId:session.projectId,projects:this.db.prepare('SELECT id,label,order_id FROM projects WHERE account_id=? ORDER BY rowid').all(session.accountId).map(p=>({id:p.id,label:p.label,orderId:p.order_id,deliveries:this.db.prepare('SELECT d.id,d.manifest_hash,d.created,r.accepted FROM deliveries d LEFT JOIN reviews r ON r.delivery_id=d.id WHERE d.project_id=? ORDER BY d.created DESC').all(p.id).map(d=>({id:d.id,manifestHash:d.manifest_hash,preparedAt:new Date(d.created).toISOString(),reviewedAt:d.accepted?new Date(d.accepted).toISOString():null,reviewMode:'local_test',cloudArchiveActive:false}))})),mode:'local_test'};
  }
  close(){if(this.db){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();this.db=null;}}
}
