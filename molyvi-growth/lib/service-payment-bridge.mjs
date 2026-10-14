import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {IntakeError} from './intake-store.mjs';
import {createOrderOfferSnapshot} from './service-offer.mjs';
import {createWorkspace} from './task-workspace.mjs';
import {serviceCheckoutUrl} from './service-checkout.mjs';

const SHOP='molyvi-still-dev.myshopify.com';
const UUID=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(code,status=422)=>{throw new IntakeError(code,status);};
const id=value=>{if(typeof value==='number'&&!Number.isSafeInteger(value))fail('PAYMENT_INVALID_ID');const result=String(value??'');if(!/^[1-9]\d{0,19}$/.test(result))fail('PAYMENT_INVALID_ID');return result;};
const minor=value=>{if(typeof value!=='string'||!/^\d{1,9}(?:\.\d{1,2})?$/.test(value))fail('PAYMENT_INVALID_AMOUNT');const [whole,fraction='']=value.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));};
const keyUuid=value=>{const h=sha(value);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};

// Local, single-process pilot. This does not register webhooks, create Shopify
// products, enable sales or provide distributed transactions/authentication.
export function createServicePaymentBridge({store,secret,shopDomain=SHOP,apiVersion='2026-10',variants,
  evidenceMode='signed_fixture',checkoutEnabled=false,clock=Date.now,accessLifetimeMs=7*24*60*60*1000,onVerifiedPayment}={}) {
  if(!store||typeof secret!=='string'||secret.length<32||shopDomain!==SHOP||apiVersion!=='2026-10'||
    !['signed_fixture','shopify_test'].includes(evidenceMode)||typeof checkoutEnabled!=='boolean'||checkoutEnabled&&evidenceMode!=='shopify_test'||!Number.isSafeInteger(accessLifetimeMs)||accessLifetimeMs<1||onVerifiedPayment!==undefined&&typeof onVerifiedPayment!=='function')fail('PAYMENT_CONFIG_INVALID',500);
  const mapping=structuredClone(variants??{}),seen=new Set();
  if(!Object.keys(mapping).length)fail('PAYMENT_CONFIG_INVALID',500);
  for(const [packageId,variant]of Object.entries(mapping)){
    const offer=createOrderOfferSnapshot({packageId});
    variant.variantId=id(variant.variantId);
    if(variant.taxesIncluded===undefined)variant.taxesIncluded=false;
    if(typeof variant.taxesIncluded!=='boolean'||seen.has(variant.variantId)||!Number.isSafeInteger(variant.taxMinor)||variant.taxMinor<0||
      variant.netMinor!==offer.netPriceMinor||variant.grossMinor!==variant.netMinor+variant.taxMinor)fail('PAYMENT_CONFIG_INVALID',500);
    seen.add(variant.variantId);
  }
  const lockId=keyUuid('molyvi-service-payment:'+shopDomain);
  const header=(headers,name)=>headers[name]??Object.entries(headers).find(([key])=>key.toLowerCase()===name)?.[1];
  function verify(raw,headers){
    if(!Buffer.isBuffer(raw)||raw.length>1_048_576)fail('PAYMENT_PAYLOAD_TOO_LARGE',413);
    const signature=header(headers,'x-shopify-hmac-sha256');
    if(typeof signature!=='string'||!(/^[A-Za-z0-9+/]{43}=$/.test(signature)))fail('PAYMENT_SIGNATURE_INVALID',401);
    const expected=crypto.createHmac('sha256',secret).update(raw).digest(),supplied=Buffer.from(signature,'base64');
    if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))fail('PAYMENT_SIGNATURE_INVALID',401);
    if(header(headers,'x-shopify-shop-domain')!==shopDomain)fail('PAYMENT_STORE_NOT_ALLOWED',403);
    if(header(headers,'x-shopify-topic')!=='orders/paid')fail('PAYMENT_TOPIC_NOT_ALLOWED');
    if(header(headers,'x-shopify-api-version')!==apiVersion)fail('PAYMENT_VERSION_NOT_ALLOWED');
    const webhookId=header(headers,'x-shopify-webhook-id'),eventId=header(headers,'x-shopify-event-id');
    if(!UUID.test(webhookId??'')||eventId!==undefined&&!UUID.test(eventId))fail('PAYMENT_EVENT_ID_INVALID');
    let order;try{order=JSON.parse(raw.toString('utf8'));}catch{fail('PAYMENT_JSON_INVALID',400);}
    if(!order||typeof order!=='object'||Array.isArray(order))fail('PAYMENT_JSON_INVALID',400);
    return {order,webhookId,eventId:eventId??null,bodyHash:sha(raw)};
  }
  async function records(){
    const result=[];
    for(const entry of await fs.readdir(store.storage,{withFileTypes:true})){
      if(!UUID.test(entry.name)||!entry.isDirectory())continue;
      // Read via the store's ordinary-path checks, not unchecked customer paths.
      const directory=await store.directory(entry.name),file=`${directory}/workspace.json`;
      if((await fs.lstat(file)).isSymbolicLink())fail('UNSAFE_STORAGE',500);
      const record=JSON.parse(await fs.readFile(file,'utf8'));
      if(record.servicePurchase)result.push(record);
    }
    return result;
  }
  async function openIntent({packageId='basic'}={}){
    const expected=mapping[packageId];if(!expected)fail('PAYMENT_PACKAGE_NOT_CONFIGURED');
    const offerSnapshot=createOrderOfferSnapshot({packageId}),ownerId=crypto.randomUUID(),accessKey=crypto.randomBytes(32).toString('hex'),intentId=crypto.randomUUID();
    const order={id:`SERVICE-PENDING-${intentId}`,status:'pending',demo:true,paymentMode:'shopify_test',packageId,
      netPriceMinor:offerSnapshot.netPriceMinor,currency:'EUR',taxBasis:offerSnapshot.taxBasis,offerId:offerSnapshot.offerId,
      offerHash:offerSnapshot.offerHash,offerSnapshot,entitlements:structuredClone(offerSnapshot.entitlements)};
    const record=createWorkspace({id:intentId,ownerId,order,budgetEur:0,now:clock()});
    record.servicePurchase={schemaVersion:1,intentId,shopDomain,apiVersion,evidenceMode,checkoutEnabled,
      accessHash:sha(accessKey),accessExpiresAt:clock()+accessLifetimeMs,expected:structuredClone(expected),receipt:null};
    await store.create(record);
    return {record,session:{projectId:record.id,ownerId},accessKey,
      checkoutBinding:{attributeName:'molyvi_service_intent',value:intentId},checkoutConfigured:checkoutEnabled};
  }
  async function access(accessKey){
    if(typeof accessKey!=='string'||!/^[a-f0-9]{64}$/.test(accessKey))fail('SERVICE_ACCESS_INVALID',401);
    const hash=sha(accessKey),record=(await records()).find(r=>r.servicePurchase.accessHash===hash);
    if(!record||record.servicePurchase.accessExpiresAt<=clock())fail('SERVICE_ACCESS_INVALID',401);
    return {projectId:record.id,ownerId:record.ownerId};
  }
  async function receive(raw,headers){
    const delivery=verify(raw,headers),order=delivery.order,orderId=id(order.id);
    let context;
    const verifiedContext=record=>({projectId:record.id,ownerId:record.ownerId,receipt:structuredClone(record.servicePurchase.receipt),contact:{email:order.email??null,contactEmail:order.contact_email??null}});
    const result=await store.serial(lockId,async()=>{
      const all=await records();
      const bindings=Array.isArray(order.note_attributes)?order.note_attributes.filter(a=>a?.name==='molyvi_service_intent'):[];
      if(bindings.length!==1||!UUID.test(bindings[0]?.value??''))return {accepted:true,outcome:'ignored',reason:'service_binding_missing'};
      const record=all.find(r=>r.id===bindings[0].value);
      if(!record)return {accepted:true,outcome:'ignored',reason:'service_binding_unknown'};
      if(record.servicePurchase.evidenceMode!==evidenceMode)fail('PAYMENT_EVIDENCE_MODE_CONFLICT',409);
      const collision=all.find(r=>{const receipt=r.servicePurchase.receipt;return receipt&&(receipt.orderId===orderId||receipt.webhookId===delivery.webhookId||delivery.eventId&&receipt.eventId===delivery.eventId);});
      if(collision){
        if(collision.id!==record.id||collision.servicePurchase.receipt.orderId!==orderId||collision.servicePurchase.receipt.bodyHash!==delivery.bodyHash)fail('PAYMENT_REPLAY_CONFLICT',409);
        context=verifiedContext(collision);
        return {accepted:true,outcome:'duplicate',projectId:record.id};
      }
      if(record.servicePurchase.receipt)fail('PAYMENT_ALREADY_BOUND',409);
      if(order.test!==true||order.financial_status!=='paid'||order.cancelled_at!=null||!Array.isArray(order.refunds)||order.refunds.length)fail('PAYMENT_TEST_PAID_REQUIRED');
      if(order.currency!=='EUR'||order.presentment_currency!==undefined&&order.presentment_currency!=='EUR')fail('PAYMENT_CURRENCY_MISMATCH');
      const expected=record.servicePurchase.expected,lines=order.line_items,taxesIncluded=expected.taxesIncluded??false,subtotalMinor=taxesIncluded?expected.grossMinor:expected.netMinor;
      if(!Array.isArray(lines)||lines.length!==1||!lines[0]||typeof lines[0]!=='object'||id(lines[0].variant_id)!==expected.variantId||lines[0].quantity!==1||
        minor(lines[0].price)!==subtotalMinor)fail('PAYMENT_LINE_MISMATCH');
      if(order.taxes_included!==taxesIncluded||minor(order.subtotal_price)!==subtotalMinor||minor(order.total_tax)!==expected.taxMinor||
        minor(order.total_price)!==expected.grossMinor||minor(order.total_discounts)!==0||
        minor(order.total_shipping_price_set?.shop_money?.amount)!==0||order.total_shipping_price_set?.shop_money?.currency_code!=='EUR')fail('PAYMENT_TOTAL_MISMATCH');
      for(const [field,amount]of [['current_total_price',expected.grossMinor],['current_subtotal_price',subtotalMinor],['current_total_tax',expected.taxMinor],['total_outstanding',0]]){
        if(order[field]!==undefined&&minor(order[field])!==amount)fail('PAYMENT_TOTAL_MISMATCH');
      }
      const {record:updated}=await store.transact(record.id,record.ownerId,current=>{
        if(current.order.status!=='pending'||current.servicePurchase.receipt)fail('PAYMENT_STATE_CONFLICT',409);
        current.servicePurchase.receipt={provider:'shopify',mode:'test',evidenceMode,verifiedBy:'raw_body_hmac_sha256',
          shopDomain,orderId,webhookId:delivery.webhookId,eventId:delivery.eventId,bodyHash:delivery.bodyHash,
          netMinor:expected.netMinor,taxMinor:expected.taxMinor,grossMinor:expected.grossMinor,verifiedAt:new Date(clock()).toISOString()};
        current.order.status='verified_paid';current.order.id=`SHOPIFY-TEST-${orderId}`;
        // No credits, AI request, synthetic result or publication is created by payment.
      });
      context=verifiedContext(updated);
      return {accepted:true,outcome:'confirmed',projectId:updated.id};
    });
    // Separate durable stores: a failed follow-up leaves payment confirmed.
    // Re-delivery calls the idempotent follow-up again, including duplicates.
    if(context&&onVerifiedPayment)await onVerifiedPayment(context);
    return result;
  }
  async function checkout(session){
    const record=await store.read(session.projectId,session.ownerId);
    if(record.order.status!=='pending')fail('SERVICE_ALREADY_PAID',409);
    if(!checkoutEnabled)fail('SERVICE_CHECKOUT_UNAVAILABLE',409);
    return {url:serviceCheckoutUrl(record.servicePurchase),projectId:record.id,mode:'test'};
  }
  return {openIntent,access,receive,checkout,status:()=>({configured:true,evidenceMode,storeRestriction:'authorized_development_store',checkoutConfigured:checkoutEnabled})};
}

