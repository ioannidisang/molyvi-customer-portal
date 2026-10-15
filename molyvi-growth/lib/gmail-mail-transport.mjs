import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareStorage,canonicalJson} from './intake-store.mjs';
import {ordinaryFile,sha256} from './service-handoff.mjs';
import {GOOGLE_MAIL_SENDER} from './google-mail-token-provider.mjs';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const address=v=>typeof v==='string'&&v.length<=254&&/^[\x21-\x7e]+$/.test(v)&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v);
function error(code,known='not_sent',retryable=false){const e=new Error(code);e.deliveryKnown=known;e.retryable=retryable;return e;}
function encodedSubject(text){const chunks=[];let chunk='';for(const char of text){if(Buffer.byteLength(chunk+char)>42){chunks.push(chunk);chunk='';}chunk+=char;}if(chunk)chunks.push(chunk);return chunks.map(x=>'=?UTF-8?B?'+Buffer.from(x).toString('base64')+'?=').join('\r\n ');}
export function gmailMime({messageId,payload,createdAt}){
  const body=Buffer.from(payload.text,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
  return [`From: Molyvi <${GOOGLE_MAIL_SENDER}>`,'To: '+payload.to,'Reply-To: '+GOOGLE_MAIL_SENDER,'Subject: '+encodedSubject(payload.subject),
    'Date: '+new Date(createdAt).toUTCString(),`Message-ID: <molyvi.${messageId}@molyvi.com>`,'X-Molyvi-Message-Id: '+messageId,
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''+body,''].join('\r\n');
}
// Staging pilot: exact approved recipients and one selected Workspace account.
// Gmail has no send idempotency key. An ambiguous attempt is NEVER resent.
export class GmailMailTransport {
  constructor({storage,enabled=false,accountVerified=false,approvedRecipients=[],getAccessToken,fetchImpl=globalThis.fetch,now=Date.now,dailyLimit=30,monthlyLimit=500}={}){
    if(typeof enabled!=='boolean'||typeof accountVerified!=='boolean'||!Array.isArray(approvedRecipients)||approvedRecipients.some(v=>!address(v))||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>80||!Number.isInteger(monthlyLimit)||monthlyLimit<1||monthlyLimit>2500)throw error('INVALID_GMAIL_CONFIGURATION');
    if(enabled&&(!accountVerified||!approvedRecipients.length||typeof getAccessToken!=='function'))throw error('GMAIL_ACTIVATION_INCOMPLETE');
    Object.assign(this,{storage,enabled,getAccessToken,fetchImpl,now,dailyLimit,monthlyLimit});this.approvedRecipients=new Set(approvedRecipients.map(v=>v.toLowerCase()));this.active=false;
  }
  async ready(){this.storage=await prepareStorage(this.storage);return this;}
  async read(id){try{return JSON.parse(await ordinaryFile(this.storage,id+'.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async save(id,value){const temp=path.join(this.storage,id+'.'+crypto.randomUUID()+'.tmp'),h=await fs.open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}try{await fs.rename(temp,path.join(this.storage,id+'.json'));}catch(e){await fs.unlink(temp);throw e;}}
  async quota(){let day=0,month=0;const now=this.now(),key=new Date(now).toISOString().slice(0,7);for(const file of await fs.readdir(this.storage)){if(!file.endsWith('.json')||!uuid.test(file.slice(0,-5)))continue;const row=await this.read(file.slice(0,-5));if(!Number.isFinite(row.firstAttemptAt))throw error('INVALID_GMAIL_JOURNAL','unknown');if(row.firstAttemptAt>now-86400000)day++;if(new Date(row.firstAttemptAt).toISOString().slice(0,7)===key)month++;}return day<this.dailyLimit&&month<this.monthlyLimit;}
  async send({messageId,payload}){
    if(!this.enabled)throw error('REAL_EMAIL_DISABLED');
    if(!uuid.test(messageId)||!payload||!address(payload.to)||!this.approvedRecipients.has(payload.to.toLowerCase())||!['access_code','delivery_ready','backup_alert'].includes(payload.kind)||
      (payload.kind==='backup_alert'&&payload.to!=='aioannidis@kooqie.com')||
      typeof payload.subject!=='string'||!payload.subject||payload.subject.length>200||/[\r\n\x00]/.test(payload.subject)||typeof payload.text!=='string'||!payload.text||Buffer.byteLength(payload.text)>32768)throw error('GMAIL_PILOT_SCOPE_REQUIRED');
    if(this.active)throw error('GMAIL_TRANSPORT_BUSY','unknown');this.active=true;
    try{
      const requestHash=sha256(canonicalJson({from:GOOGLE_MAIL_SENDER,to:payload.to,subject:payload.subject,text:payload.text,kind:payload.kind}));let row=await this.read(messageId);
      if(row&&row.requestHash!==requestHash)throw error('GMAIL_REQUEST_CHANGED','unknown');
      if(row?.receipt){const found=await this.lookup(messageId);return found.receipt;}
      if(row&&row.status!=='known_not_sent')throw error('GMAIL_RECONCILIATION_REQUIRED','unknown');
      if(!row&&!await this.quota())throw error('GMAIL_LOCAL_QUOTA_REACHED');
      let token;try{token=await this.getAccessToken();}catch{throw error('GMAIL_AUTH_UNAVAILABLE');}
      if(token?.email!==GOOGLE_MAIL_SENDER||token.emailVerified!==true||typeof token.accessToken!=='string'||!token.accessToken||/[\x00-\x1f]/.test(token.accessToken))throw error('GMAIL_IDENTITY_MISMATCH');
      row={...row,messageId,requestHash,firstAttemptAt:row?.firstAttemptAt??this.now(),status:'attempting'};await this.save(messageId,row);
      let response,data;try{response=await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':'application/json'},body:JSON.stringify({raw:Buffer.from(gmailMime({messageId,payload,createdAt:row.firstAttemptAt})).toString('base64url')})});data=await response.json();}catch{throw error('GMAIL_DELIVERY_UNCERTAIN','unknown');}
      if(!response.ok){const known=[400,401,403,429].includes(response.status)&&data?.error?.code===response.status;
        if(known)await this.save(messageId,{...row,status:'known_not_sent'});
        const reasons=data?.error?.errors?.map(x=>x.reason)??[];
        throw error(known?'GMAIL_PROVIDER_REJECTED':'GMAIL_DELIVERY_UNCERTAIN',known?'not_sent':'unknown',known&&[403,429].includes(response.status)&&reasons.some(x=>['rateLimitExceeded','userRateLimitExceeded'].includes(x)));
      }
      if(typeof data?.id!=='string'||!data.id||!/^[a-zA-Z0-9_-]{1,200}$/.test(data.id))throw error('GMAIL_RECEIPT_INVALID','unknown');
      const receipt={messageId,mode:'provider_accepted',provider:'gmail',providerId:data.id,requestHash,acceptedAt:new Date(this.now()).toISOString(),mailboxDeliveryConfirmed:false};
      await this.save(messageId,{...row,status:'accepted',receipt});return receipt;
    }finally{this.active=false;}
  }
  async lookup(id){if(!uuid.test(id))throw error('INVALID_MAIL_ID');const row=await this.read(id),r=row?.receipt;
    if(r){if(r.messageId!==id||r.mode!=='provider_accepted'||r.provider!=='gmail'||r.requestHash!==row.requestHash)throw error('INVALID_GMAIL_JOURNAL','unknown');return {receipt:r};}
    return {deliveryKnown:'unknown'};
  }
}
