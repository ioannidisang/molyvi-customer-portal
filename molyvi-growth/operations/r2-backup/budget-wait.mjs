import crypto from 'node:crypto';
import {R2_LIMITS} from './r2-budget.mjs';
const fields=['requests','uploadBytes','downloadBytes'];
const check=(v,c)=>{if(!v)throw Error(c);};
const windowMs=R2_LIMITS.windowDays*86400000;
export function planBudgetWait({entries,demand,now}){
  check(Number.isSafeInteger(now)&&now>0&&Array.isArray(entries)&&entries.length<=10000,'BACKUP_WAIT_INPUT');
  check(fields.every(k=>Number.isSafeInteger(demand?.[k])&&demand[k]>=0&&demand[k]<=R2_LIMITS[k]),'BACKUP_WAIT_DEMAND');
  const ids=new Set();
  for(const r of entries){
    check(Number.isSafeInteger(r.id)&&r.id>0&&!ids.has(r.id)&&Number.isSafeInteger(r.at)&&r.at>0&&r.at<=now
      &&fields.every(k=>Number.isSafeInteger(r[k])&&r[k]>=0),'BACKUP_WAIT_LEDGER');ids.add(r.id);
  }
  const usage=at=>Object.fromEntries(fields.map(k=>{const n=entries.filter(r=>r.at>at-windowMs).reduce((n,r)=>n+r[k],0);check(Number.isSafeInteger(n),'BACKUP_WAIT_OVERFLOW');return [k,n];}));
  const blocked=u=>fields.filter(k=>u[k]+demand[k]>R2_LIMITS[k]);
  const consumed=usage(now),blockedBy=blocked(consumed);if(!blockedBy.length)return null;
  const expires=[...new Set(entries.map(r=>r.at+windowMs).filter(at=>at>now))].sort((a,b)=>a-b);
  const first=expires.find(at=>blocked(usage(at)).length===0);check(first!==undefined,'BACKUP_WAIT_NO_EXPIRY');
  return {schemaVersion:1,status:'WAIT_BUDGET',code:'BACKUP_TRANSFER_BUDGET_WAIT',checkedAt:now,notBefore:first+60000,
    consumed,demand:{...demand},blockedBy,ledgerSha256:crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    providerCalls:0,reservationsCreated:0};
}
export function validateBudgetWait(result,now){
  check(result?.schemaVersion===1&&result.status==='WAIT_BUDGET'&&result.code==='BACKUP_TRANSFER_BUDGET_WAIT'
    &&Number.isSafeInteger(result.checkedAt)&&result.checkedAt<=now&&result.checkedAt>0
    &&Number.isSafeInteger(result.notBefore)&&result.notBefore>now&&result.notBefore<=result.checkedAt+windowMs+60000
    &&result.providerCalls===0&&result.reservationsCreated===0&&result.catalogUnchanged===true&&result.scratchCleaned===true
    &&/^[a-f0-9]{64}$/.test(result.ledgerSha256??'')&&Buffer.byteLength(JSON.stringify(result))<=16384,'BACKUP_WAIT_INVALID');
  return result;
}
