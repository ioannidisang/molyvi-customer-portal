import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareStorage,canonicalJson} from './intake-store.mjs';
import {ordinaryFile,sha256} from './service-handoff.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const address=value=>typeof value==='string'&&value.length<=254&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)&&!/[\x00-\x1f\x7f]/.test(value);
function failure(code,{known='not_sent',retryable=false}={}){const e=new Error(code);e.deliveryKnown=known;e.retryable=retryable;return e;}

// Prepared pilot adapter, deliberately not wired into any running server.
// Metadata journal contains hashes/receipts, never API keys, recipients or codes.
export class ResendMailTransport {
  #apiKey;
  constructor({storage,apiKey='',enabled=false,domainVerified=false,from='Molyvi <updates@notify.molyvi.com>',replyTo,
    approvedRecipients=[],fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10_000,dailyLimit=80,monthlyLimit=2500}={}){
    if(typeof enabled!=='boolean'||typeof domainVerified!=='boolean'||typeof apiKey!=='string'||apiKey.length>512||/[\x00-\x1f\x7f]/.test(apiKey)||!Array.isArray(approvedRecipients)||approvedRecipients.some(x=>!address(x)))throw failure('INVALID_MAIL_CONFIGURATION');
    if(!/^Molyvi <[^\s<>@]+@notify\.molyvi\.com>$/.test(from)||/[\x00-\x1f\x7f]/.test(from)||replyTo&&!address(replyTo))throw failure('INVALID_MAIL_SENDER');
    if(!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>80||!Number.isInteger(monthlyLimit)||monthlyLimit<1||monthlyLimit>2500||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw failure('INVALID_MAIL_LIMITS');
    if(enabled&&(!domainVerified||!apiKey||!approvedRecipients.length||!replyTo))throw failure('MAIL_ACTIVATION_INCOMPLETE');
    this.#apiKey=apiKey;Object.assign(this,{storage,enabled,from,replyTo,fetchImpl,now,timeoutMs,dailyLimit,monthlyLimit});
    this.approvedRecipients=new Set(approvedRecipients.map(x=>x.toLowerCase()));this.active=false;
  }
  async ready(){this.storage=await prepareStorage(this.storage);return this;}
  async read(id){try{return JSON.parse(await ordinaryFile(this.storage,id+'.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async save(id,value){
    const temp=id+'.'+crypto.randomUUID()+'.tmp',file=path.join(this.storage,temp);
    const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}
    try{await fs.rename(file,path.join(this.storage,id+'.json'));}catch(e){await fs.unlink(file);throw e;}
  }
  async withinQuota(){
    const now=this.now(),month=new Date(now).toISOString().slice(0,7);let daily=0,monthly=0;
    for(const file of await fs.readdir(this.storage)){
      if(!uuid.test(file.slice(0,-5))||!file.endsWith('.json'))continue;
      const row=JSON.parse(await ordinaryFile(this.storage,file));
      if(!Number.isFinite(row.firstAttemptAt))throw failure('INVALID_MAIL_JOURNAL',{known:'unknown'});
      if(row.firstAttemptAt>now-86_400_000)daily++;
      if(new Date(row.firstAttemptAt).toISOString().slice(0,7)===month)monthly++;
    }
    return daily<this.dailyLimit&&monthly<this.monthlyLimit;
  }
  async send({messageId,payload}){
    if(!this.enabled)throw failure('REAL_EMAIL_DISABLED');
    if(!uuid.test(messageId)||!payload||!address(payload.to)||!this.approvedRecipients.has(payload.to.toLowerCase())||
      typeof payload.subject!=='string'||!payload.subject||payload.subject.length>200||/[\r\n\x00]/.test(payload.subject)||
      typeof payload.text!=='string'||!payload.text||Buffer.byteLength(payload.text)>32_768||!['access_code','delivery_ready'].includes(payload.kind))throw failure('MAIL_PILOT_SCOPE_REQUIRED');
    // One process/one instance only. A concurrent send is not known to have failed.
    if(this.active)throw failure('MAIL_TRANSPORT_BUSY',{known:'unknown'});this.active=true;
    try{
      const request={from:this.from,to:[payload.to],reply_to:this.replyTo,subject:payload.subject,text:payload.text,
        tags:[{name:'molyvi_message_id',value:messageId},{name:'kind',value:payload.kind}]};
      const bytes=canonicalJson(request),requestHash=sha256(bytes);let row=await this.read(messageId);
      if(row&&row.requestHash!==requestHash)throw failure('MAIL_REQUEST_CHANGED',{known:'unknown'});
      if(row?.receipt)return row.receipt;
      // Resend's idempotency window is 24h. Leave an hour of margin and never
      // reuse an ambiguous identifier beyond that window, even after restart.
      if(row&&(!Number.isFinite(row.firstAttemptAt)||this.now()-row.firstAttemptAt>=23*60*60*1000||this.now()<row.firstAttemptAt))throw failure('MAIL_IDEMPOTENCY_WINDOW_CLOSED',{known:'unknown'});
      if(!row){
        if(!await this.withinQuota())throw failure('MAIL_LOCAL_QUOTA_REACHED');
        row={messageId,requestHash,firstAttemptAt:this.now(),status:'attempting'};await this.save(messageId,row);
      }
      let response,data;
      try{
        response=await this.fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'error',
          headers:{Authorization:'Bearer '+this.#apiKey,'Content-Type':'application/json','Idempotency-Key':'molyvi-'+messageId},
          body:bytes,signal:AbortSignal.timeout(this.timeoutMs)});
        data=await response.json();
      }catch{throw failure('MAIL_DELIVERY_UNCERTAIN',{known:'unknown'});}
      if(!response.ok){
        const definite={400:['validation_error','invalid_idempotency_key','invalid_parameter','missing_required_field'],
          401:['missing_api_key','restricted_api_key'],403:['invalid_permission','restricted_api_key','suspended_api_key','validation_error'],
          422:['validation_error'],429:['rate_limit_exceeded','daily_quota_exceeded','monthly_quota_exceeded']};
        const known=definite[response.status]?.includes(data?.name);
        throw failure(known?'MAIL_PROVIDER_REJECTED':'MAIL_DELIVERY_UNCERTAIN',{known:known?'not_sent':'unknown',retryable:known&&data.name==='rate_limit_exceeded'});
      }
      if(!uuid.test(data?.id))throw failure('MAIL_PROVIDER_RECEIPT_INVALID',{known:'unknown'});
      const receipt={messageId,mode:'provider_accepted',provider:'resend',providerId:data.id,requestHash,acceptedAt:new Date(this.now()).toISOString(),mailboxDeliveryConfirmed:false};
      // Persist the acknowledgment before returning it to the outbox.
      await this.save(messageId,{...row,status:'accepted',receipt});return receipt;
    }finally{this.active=false;}
  }
  async lookup(messageId){
    if(!uuid.test(messageId))throw failure('INVALID_MAIL_ID');
    const row=await this.read(messageId);
    if(row?.receipt){const r=row.receipt;if(r.messageId!==messageId||r.provider!=='resend'||r.mode!=='provider_accepted'||!uuid.test(r.providerId)||r.requestHash!==row.requestHash)throw failure('INVALID_MAIL_JOURNAL',{known:'unknown'});return {receipt:r};}
    // A missing local acknowledgment proves nothing about provider delivery.
    // Signed provider-event reconciliation remains a separate production gate.
    return {deliveryKnown:'unknown'};
  }
}
