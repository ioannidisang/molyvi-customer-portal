import fs from 'node:fs/promises';
import path from 'node:path';
import {IntakeError,PRIVATE_ROOT} from './intake-store.mjs';
import {ordinaryFile} from './service-handoff.mjs';
import {createServicePaymentBridge} from './service-payment-bridge.mjs';

export const HOSTED_TEST_PAYMENT_SCOPE='molyvi_hosted_test_v1';
export const HOSTED_TEST_RECIPIENT='aioannidis@kooqie.com';
const LIMIT=4,LOCK='873d173e-c27e-4d59-9fcb-d41e38f80f86';
const fail=code=>{throw new IntakeError(code,409);};

// Opt-in pilot only. Secrets stay outside the customer snapshot/backup root.
export async function loadHostedTestPaymentConfig({enabled=false,directory=path.join(PRIVATE_ROOT,'molyvi-test-payments')}={}){
  if(!enabled)return null;
  const target=path.resolve(directory),relative=path.relative(PRIVATE_ROOT,target);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))fail('TEST_PAYMENT_PRIVATE_CONFIG_REQUIRED');
  const stat=await fs.lstat(target);if(stat.isSymbolicLink()||!stat.isDirectory())fail('TEST_PAYMENT_PRIVATE_CONFIG_REQUIRED');
  const realRoot=await fs.realpath(PRIVATE_ROOT),realTarget=await fs.realpath(target),realRelative=path.relative(realRoot,realTarget);
  if(!realRelative||realRelative.startsWith('..')||path.isAbsolute(realRelative))fail('TEST_PAYMENT_PRIVATE_CONFIG_REQUIRED');
  const file=path.join(target,'config.json'),info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>16_384||process.platform!=='win32'&&(info.mode&0o077))fail('TEST_PAYMENT_PRIVATE_CONFIG_REQUIRED');
  try{return JSON.parse(await ordinaryFile(target,'config.json'));}catch{fail('TEST_PAYMENT_CONFIG_UNREADABLE');}
}

export function createHostedTestPayments({store,notifications,config}={}){
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['scope','shopDomain','apiVersion','secret','variants','approvedRecipient'].includes(k))||
    config.scope!==HOSTED_TEST_PAYMENT_SCOPE||config.shopDomain!=='molyvi-still-dev.myshopify.com'||config.apiVersion!=='2026-10'||
    config.approvedRecipient!==HOSTED_TEST_RECIPIENT||Object.keys(config.variants??{}).join(',')!=='basic')fail('HOSTED_TEST_PAYMENT_CONFIG_INVALID');
  const bridge=createServicePaymentBridge({store,secret:config.secret,variants:config.variants,shopDomain:config.shopDomain,apiVersion:config.apiVersion,
    evidenceMode:'shopify_test',checkoutEnabled:true,intentScope:HOSTED_TEST_PAYMENT_SCOPE,onVerifiedPayment:async context=>{
      const contacts=[context.contact.email,context.contact.contactEmail].filter(v=>v!=null&&v!=='');
      if(!contacts.length||contacts.some(v=>typeof v!=='string'||v.toLowerCase()!==HOSTED_TEST_RECIPIENT))fail('TEST_PAYMENT_CONTACT_NOT_APPROVED');
      return notifications.captureVerifiedPayment(context);
    }});
  async function openIntent(){
    // No public HTTP entry point. Single-instance operator preparation only.
    return store.serial(LOCK,async()=>{
      let count=0;
      for(const entry of await fs.readdir(store.storage,{withFileTypes:true})){
        if(!/^[a-f0-9-]{36}$/i.test(entry.name))continue;
        const directory=await store.directory(entry.name),record=JSON.parse(await ordinaryFile(directory,'workspace.json'));
        if(record.servicePurchase?.intentScope===HOSTED_TEST_PAYMENT_SCOPE)count++;
      }
      if(count>=LIMIT)fail('HOSTED_TEST_INTENT_LIMIT');
      const opened=await bridge.openIntent({packageId:'basic'}),checkout=await bridge.checkout(opened.session);
      // The legacy return key is deliberately discarded. Mailbox proof owns access.
      return {projectId:opened.record.id,packageId:'basic',checkoutUrl:checkout.url,mode:'test',remainingIntents:LIMIT-count-1};
    });
  }
  return {receive:bridge.receive,openIntent,status:()=>({mode:'shopify_test',scope:HOSTED_TEST_PAYMENT_SCOPE,intentLimit:LIMIT,publicIntentCreation:false,realPaymentsEnabled:false})};
}
