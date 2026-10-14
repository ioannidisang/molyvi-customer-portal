import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareStorage,IntakeError} from './intake-store.mjs';
import {ordinaryFile,sha256} from './service-handoff.mjs';
const fail=(code,status=409)=>{throw new IntakeError(code,status);};
const address=v=>typeof v==='string'&&v.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?v.toLowerCase():null;
export class CustomerNotifications {
  constructor({accounts,workspaces,storage,portalUrl,transport}){
    const u=new URL(portalUrl);if(u.username||u.password||u.search||u.hash||!((u.protocol==='http:'&&u.hostname==='127.0.0.1')||u.protocol==='https:'))fail('INVALID_PORTAL_URL');
    this.accounts=accounts;this.workspaces=workspaces;this.storage=storage;this.portalUrl=u.href;this.transport=transport;this.active=false;
  }
  async ready(){
    this.storage=await prepareStorage(this.storage);const file=path.join(this.storage,'mail-encryption-key.bin');
    try{const h=await fs.open(file,'wx',0o600);try{await h.writeFile(crypto.randomBytes(32));await h.sync();}finally{await h.close();}}catch(e){if(e.code!=='EEXIST')throw e;}
    this.key=await ordinaryFile(this.storage,'mail-encryption-key.bin');if(this.key.length!==32)fail('INVALID_MAIL_KEY',500);
    // Interrupted attempts are ambiguous; only explicit reconciliation can release them.
    this.accounts.db.prepare("UPDATE mail_outbox SET status='paused_unknown',last_error='interrupted_attempt' WHERE status='sending'").run();return this;
  }
  encrypt(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv),bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');}
  decrypt(value){const b=Buffer.from(value,'base64'),cipher=crypto.createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString());}
  insert(accountId,kind,dedupe,payload,{expires=null,codeHash=null}={}){
    const old=this.accounts.db.prepare('SELECT id FROM mail_outbox WHERE dedupe_key=?').get(dedupe);if(old)return old.id;
    const id=crypto.randomUUID();this.accounts.db.prepare('INSERT INTO mail_outbox(id,dedupe_key,account_id,kind,payload,status,next_at,expires,code_hash,created) VALUES(?,?,?,?,?,\'queued\',?,?,?,?)').run(id,dedupe,accountId,kind,this.encrypt(payload),this.accounts.now(),expires,codeHash,this.accounts.now());return id;
  }
  queueCode(account,dedupe,context='Επέστρεψε στο έργο σου.'){
    if(this.accounts.db.prepare('SELECT id FROM mail_outbox WHERE dedupe_key=?').get(dedupe))return;
    const credential=this.accounts.issueCodeWithinTransaction(account.id),payload={to:account.email,subject:'Molyvi · Ο δικός σου χώρος',kind:'access_code',code:credential.code,expiresAt:new Date(credential.expires).toISOString(),text:`${context}\n\nΟ προσωπικός κωδικός σου: ${credential.code}\n\nΙσχύει για 15 λεπτά και χρησιμοποιείται μία φορά.\n${this.portalUrl}\n\nΜην κοινοποιείς τον κωδικό σου. Αν δεν ζήτησες πρόσβαση, αγνόησε αυτό το μήνυμα.\n\nMolyvi — Το e-shop σου, βήμα βήμα.`};
    this.insert(account.id,'access_code',dedupe,payload,credential);
  }
  async captureVerifiedPayment(context){
    const record=await this.workspaces.read(context.projectId,context.ownerId),r=record.servicePurchase?.receipt;
    if(!r||record.order.status!=='verified_paid'||r.verifiedBy!=='raw_body_hmac_sha256'||r.bodyHash!==context.receipt?.bodyHash||r.orderId!==context.receipt?.orderId||r.evidenceMode!==context.receipt?.evidenceMode)fail('VERIFIED_PAYMENT_REQUIRED');
    const e1=address(context.contact?.email),e2=address(context.contact?.contactEmail),valid=(!context.contact?.email||e1)&&(!context.contact?.contactEmail||e2)&&(!e1||!e2||e1===e2),recipient=valid?(e2??e1):null;
    return this.accounts.transaction(()=>{
      const old=this.accounts.db.prepare('SELECT * FROM payment_links WHERE project_id=? OR order_id=?').get(record.id,record.order.id);
      if(old){if(old.project_id!==record.id||old.body_hash!==r.bodyHash||old.email!==recipient)fail('PAYMENT_ACCOUNT_CONFLICT');return {status:old.status,duplicate:true};}
      const assigned=this.accounts.db.prepare('SELECT * FROM projects WHERE id=?').get(record.id);
      if(recipient&&assigned){const owner=this.accounts.db.prepare('SELECT email FROM accounts WHERE id=?').get(assigned.account_id);if(owner?.email!==recipient||assigned.owner_id!==record.ownerId||assigned.order_id!==record.order.id)fail('PAYMENT_ACCOUNT_ALREADY_ASSIGNED');}
      const account=recipient?this.accounts.provision({address:recipient,name:'Molyvi'}):null,status=account?'pending_verification':'contact_required';
      this.accounts.db.prepare('INSERT INTO payment_links VALUES(?,?,?,?,?,?,?,?)').run(record.id,account?.id??null,record.ownerId,record.order.id,r.bodyHash,recipient,status,'Το κατάστημά σου');
      this.accounts.audit('paid_account_claim_prepared',account?.id,record.id);
      if(account)this.queueCode(account,'payment:'+record.id+':'+r.bodyHash,'Η δοκιμαστική παραγγελία σου επιβεβαιώθηκε. Το έργο σου σε περιμένει.');
      return {status,duplicate:false};
    });
  }
  requestCode({address:input,client='loopback'}){
    const recipient=address(typeof input==='string'?input.trim():null),now=this.accounts.now();
    // Generic response regardless of account existence or throttling.
    return this.accounts.transaction(()=>{
      this.accounts.db.prepare('DELETE FROM code_requests WHERE started<?').run(now-15*60*1000);
      const buckets=[sha256('address:'+String(recipient)),sha256('client:'+client)];
      for(const [i,bucket]of buckets.entries()){const old=this.accounts.db.prepare('SELECT * FROM code_requests WHERE bucket=?').get(bucket);if(old&&old.count>=(i===0?3:30))return {accepted:true};}
      const account=recipient?this.accounts.db.prepare('SELECT * FROM accounts WHERE email=?').get(recipient):null;
      if(account){const latest=this.accounts.db.prepare("SELECT created FROM mail_outbox WHERE account_id=? AND kind='access_code' ORDER BY rowid DESC LIMIT 1").get(account.id);if(latest&&now-latest.created<60_000)return {accepted:true};}
      for(const bucket of buckets)this.accounts.db.prepare('INSERT INTO code_requests VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(bucket,now);
      if(account)this.queueCode(account,'return:'+account.id+':'+crypto.randomUUID());
      return {accepted:true};
    });
  }
  deliveryPrepared({accountId,deliveryId}){
    const d=this.accounts.delivery(accountId,deliveryId),account=this.accounts.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
    return this.accounts.transaction(()=>({id:this.insert(accountId,'delivery_ready','delivery:'+d.id+':'+d.manifest_hash,{to:account.email,kind:'delivery_ready',subject:'Molyvi · Ο φάκελος του καταστήματός σου είναι έτοιμος',text:`Οι φωτογραφίες, τα κείμενα και οι οδηγίες σου βρίσκονται στον ιδιωτικό χώρο σου.\n\nΣυνδέσου για να ελέγξεις τη συγκεκριμένη έκδοση.\n${this.portalUrl}\n\nΤο μήνυμα αφορά τη δοκιμαστική παράδοση και δεν καταγράφει αποδοχή ή δημοσίευση.\n\nMolyvi — Το e-shop σου, βήμα βήμα.`})}));
  }
  eligible(row){
    if(row.expires&&row.expires<=this.accounts.now())return false;
    if(row.code_hash){const c=this.accounts.db.prepare('SELECT used,expires FROM codes WHERE hash=?').get(row.code_hash);if(!c||c.used||c.expires<=this.accounts.now())return false;}
    return true;
  }
  async tick(){
    if(!this.transport||this.active)return {processed:false,reason:'transport_disabled_or_busy'};this.active=true;
    let row;
    try{
      row=this.accounts.transaction(()=>{const r=this.accounts.db.prepare("SELECT * FROM mail_outbox WHERE status IN ('queued','retry_wait') AND next_at<=? ORDER BY rowid LIMIT 1").get(this.accounts.now());if(!r)return null;
        if(!this.eligible(r)){this.accounts.db.prepare("UPDATE mail_outbox SET status='expired' WHERE id=?").run(r.id);return {...r,expired:true};}
        this.accounts.db.prepare("UPDATE mail_outbox SET status='sending',attempts=attempts+1 WHERE id=?").run(r.id);return r;});
      if(!row)return {processed:false};
      if(row.expired)return {processed:true,id:row.id,status:'expired'};
      const payload=this.decrypt(row.payload),receipt=await this.transport.send({messageId:row.id,payload});
      if(!receipt||receipt.messageId!==row.id||!['local_sink','provider_accepted'].includes(receipt.mode))fail('INVALID_MAIL_RECEIPT');
      this.accounts.db.prepare("UPDATE mail_outbox SET status='sent',receipt=?,last_error=NULL WHERE id=? AND status='sending'").run(JSON.stringify(receipt),row.id);return {processed:true,id:row.id,status:'sent',mode:receipt.mode};
    }catch(e){
      if(row){const retry=e.deliveryKnown==='not_sent'&&e.retryable===true&&row.attempts+1<3;
        const status=retry?'retry_wait':e.deliveryKnown==='not_sent'?'failed':'paused_unknown';
        this.accounts.db.prepare('UPDATE mail_outbox SET status=?,next_at=?,last_error=? WHERE id=?').run(status,this.accounts.now()+30_000*2**row.attempts,retry?'known_not_sent':'delivery_uncertain',row.id);
        return {processed:true,id:row.id,status};}
      throw e;
    }finally{this.active=false;}
  }
  async reconcile(id){
    const row=this.accounts.db.prepare("SELECT * FROM mail_outbox WHERE id=? AND status='paused_unknown'").get(id);if(!row||!this.transport?.lookup)fail('MAIL_RECONCILIATION_REQUIRED');
    const result=await this.transport.lookup(id);
    if(result?.receipt){if(result.receipt.messageId!==id||!['local_sink','provider_accepted'].includes(result.receipt.mode))fail('INVALID_MAIL_RECEIPT');this.accounts.db.prepare("UPDATE mail_outbox SET status='sent',receipt=?,last_error=NULL WHERE id=?").run(JSON.stringify(result.receipt),id);return {status:'sent'};}
    if(result?.deliveryKnown==='not_sent'){const status=this.eligible(row)&&row.attempts<3?'retry_wait':'failed';this.accounts.db.prepare('UPDATE mail_outbox SET status=?,next_at=? WHERE id=?').run(status,this.accounts.now(),id);return {status};}
    return {status:'paused_unknown'};
  }
  status(){return {mode:'local_test',transportConfigured:Boolean(this.transport),counts:this.accounts.db.prepare('SELECT status,count(*) n FROM mail_outbox GROUP BY status').all()};}
}

// Test transport only. Never claims an SMTP send or delivery to a mailbox.
export class LocalMailSink {
  constructor(storage){this.storage=storage;}
  async ready(){this.storage=await prepareStorage(this.storage);return this;}
  async send({messageId,payload}){
    if(!/^[a-f0-9-]{36}$/.test(messageId))fail('INVALID_MAIL_ID');const file=path.join(this.storage,messageId+'.json'),receipt={messageId,mode:'local_sink',payloadHash:sha256(JSON.stringify(payload))};
    try{await fs.writeFile(file,JSON.stringify({payload,receipt}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const old=JSON.parse(await ordinaryFile(this.storage,messageId+'.json'));if(old.receipt.payloadHash!==receipt.payloadHash)fail('MAIL_REPLAY_CONFLICT');return old.receipt;}
    return receipt;
  }
  async lookup(id){if(!/^[a-f0-9-]{36}$/.test(id))fail('INVALID_MAIL_ID');try{const value=JSON.parse(await ordinaryFile(this.storage,id+'.json'));if(value.receipt.messageId!==id||value.receipt.payloadHash!==sha256(JSON.stringify(value.payload)))fail('MAIL_SINK_CHANGED');return {receipt:value.receipt};}catch(e){if(e.code==='ENOENT')return {deliveryKnown:'not_sent'};throw e;}}
}
