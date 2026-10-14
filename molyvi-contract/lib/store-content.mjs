import OFFER from '../offer.v1.json' with {type:'json'};
import {SHIPPING_COUNTRIES,normalizeShippingPlan,inspectShippingPlan} from './shipping.mjs';
import {normalizeMerchantProfile,inspectMerchantProfile,normalizePaymentPlan,inspectPaymentPlan} from './merchant-payments.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const STORE_CONTENT_TEMPLATE_VERSION='molyvi-gr-store-content.v2';
export const STORE_CONTENT_CHOICES=freeze({
  windowMode:['statutory_only','30_days_total_from_receipt','60_days_total_from_receipt','other'],
  payer:['buyer','store','other'],returnAddressMode:['declared_store_address','different_address','other'],offersExchanges:['yes','no','other'],
  exchangeRequestWindowMode:['same_as_declared_returns','different_days_from_receipt','other'],
  exchangeProductScope:['same_product_size_or_colour','also_different_store_product','other'],
  exchangePriceDifference:['settle_difference','equal_value_only','other'],
  exchangeItemCondition:['unused_labels_and_original_packaging_where_present','unused_labels_where_present_no_original_packaging_required','other'],
  productCharacteristics:['ordinary_goods','personalised_goods','perishable_goods','sealed_hygiene_goods','digital_content','other','unknown'],
  practice:['yes','no','unknown','other'],cookieConsent:['configured','not_configured','unknown','other'],
});
const stringSchema=maxLength=>({type:'string',maxLength});
const choiceSchema=values=>({enum:[null,...values]});
const daySchema={type:['integer','null'],minimum:1,maximum:3650};
const addressSchema={type:'object',additionalProperties:false,properties:{recipient:stringSchema(200),country:choiceSchema(SHIPPING_COUNTRIES.map(item=>item.code)),line1:stringSchema(240),line2:stringSchema(240),city:stringSchema(120),postalCode:stringSchema(32)}};
// Optional operator-supplied observations. This is deliberately not part of the
// customer questionnaire or a way for an HTTP client to certify live settings.
const publicationTextLimits={legalName:300,taxNumber:100,registryNumber:100,websiteUrl:1000,pricesTaxDetails:2000,contractFormationDetails:3000,orderAcknowledgementDetails:3000,paymentAvailabilityDetails:3000,deliveryDeadlineDetails:3000,providerRoles:6000,transferSafeguards:6000,enhancedServicesDetails:4000,automatedDecisionDetails:4000,privacyPurposesAndBases:6000,dpoContact:1000};
const publicationChoices={registryStatus:['registered','not_applicable'],pricesTaxMode:['vat_included','vat_exempt','other'],contractFormation:['order_confirmation','separate_acceptance','dispatch_confirmation','other'],enhancedServices:['enabled','disabled','unknown'],automatedDecisions:['none','present','unknown']};
export const PUBLICATION_FACTS_SCHEMA=freeze({type:'object',additionalProperties:false,required:['schemaVersion'],properties:{schemaVersion:{const:1},...Object.fromEntries(Object.entries(publicationTextLimits).map(([key,max])=>[key,stringSchema(max)])),...Object.fromEntries(Object.entries(publicationChoices).map(([key,values])=>[key,choiceSchema(values)]))}});
const returnsProperties={schemaVersion:{const:1},windowMode:choiceSchema(STORE_CONTENT_CHOICES.windowMode),windowDays:daySchema,windowOther:stringSchema(2000),returnShippingPayer:choiceSchema(STORE_CONTENT_CHOICES.payer),returnShippingPayerOther:stringSchema(2000),returnAddressMode:choiceSchema(STORE_CONTENT_CHOICES.returnAddressMode),returnAddress:addressSchema,returnAddressOther:stringSchema(2000),offersExchanges:choiceSchema(STORE_CONTENT_CHOICES.offersExchanges),offersExchangesOther:stringSchema(2000),exchangeInboundShippingPayer:choiceSchema(STORE_CONTENT_CHOICES.payer),exchangeInboundShippingPayerOther:stringSchema(2000),exchangeOutboundShippingPayer:choiceSchema(STORE_CONTENT_CHOICES.payer),exchangeOutboundShippingPayerOther:stringSchema(2000),exchangeRequestWindowMode:choiceSchema(STORE_CONTENT_CHOICES.exchangeRequestWindowMode),exchangeRequestWindowDays:daySchema,exchangeRequestWindowOther:stringSchema(2000),exchangeProductScope:choiceSchema(STORE_CONTENT_CHOICES.exchangeProductScope),exchangeProductScopeOther:stringSchema(2000),exchangePriceDifference:choiceSchema(STORE_CONTENT_CHOICES.exchangePriceDifference),exchangePriceDifferenceOther:stringSchema(2000),exchangeItemCondition:choiceSchema(STORE_CONTENT_CHOICES.exchangeItemCondition),exchangeItemConditionOther:stringSchema(2000),productCharacteristics:{type:'array',maxItems:7,uniqueItems:true,items:{enum:STORE_CONTENT_CHOICES.productCharacteristics}},productCharacteristicsOther:stringSchema(2000)};
const policyProperties={schemaVersion:{const:1},analytics:choiceSchema(STORE_CONTENT_CHOICES.practice),analyticsDetails:stringSchema(3000),marketing:choiceSchema(STORE_CONTENT_CHOICES.practice),marketingDetails:stringSchema(3000),serviceProviders:stringSchema(3000),retentionCriteria:stringSchema(3000),cookieConsent:choiceSchema(STORE_CONTENT_CHOICES.cookieConsent),cookieConsentDetails:stringSchema(3000),internationalTransfers:choiceSchema(STORE_CONTENT_CHOICES.practice),internationalTransferDetails:stringSchema(3000),privacyContactEmail:stringSchema(254),additionalPractices:stringSchema(3000)};
const pageProperties={schemaVersion:{const:1},aboutStory:stringSchema(6000),contactHours:stringSchema(500),faqEntries:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,properties:{question:stringSchema(300),answer:stringSchema(2000)}}}};
export const STORE_CONTENT_SCHEMAS=freeze(Object.fromEntries(Object.entries({returnsPlan:returnsProperties,policyInputs:policyProperties,pageContent:pageProperties}).map(([key,properties])=>[key,{type:'object',additionalProperties:false,required:['schemaVersion'],properties}])));
export const STORE_CONTENT_SOURCES=freeze({
  consumerRights:'https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=celex%3A32011L0083',
  distanceSelling:'https://europa.eu/youreurope/business/selling-in-eu/selling-goods-services/ecommerce-distance-selling/index_en.htm',
  greekWithdrawal:'https://api.et.gr/apiFEK/1/2026/108/pdf',
  dataProtection:'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679',
  shopifyPrivacy:'https://help.shopify.com/en/manual/privacy-and-security/privacy/customer-privacy-settings/privacy-settings',
  shopifyWithdrawal:'https://help.shopify.com/en/manual/compliance/legal/eu-right-of-withdrawal',
});
export const STORE_PUBLICATION_SOURCES=freeze({...STORE_CONTENT_SOURCES,
  greekEcommerceCode:'https://gge.mindev.gov.gr/wp-content/uploads/2024/05/FEK-2017-Tefxos-B-00969-downloaded-23_05_2024.pdf',
  ecommerceDirective:'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32000L0031',
  saleOfGoods:'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32019L0771',
  shopifyDpa:'https://www.shopify.com/legal/dpa',
  shopifyGdpr:'https://help.shopify.com/en/manual/privacy-and-security/privacy/gdpr/comply-with-gdpr',
});
export class StoreContentError extends Error {
  constructor(code,field,details={}){super(code);this.name='StoreContentError';this.code=code;this.field=field;this.status=422;this.details={field,...details};}
}
const fail=(code,field,details)=>{throw new StoreContentError(code,field,details);};
function object(value,keys,field,prefix){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(`${prefix}_INVALID_OBJECT`,field);
  for(const key of Object.keys(value))if(!keys.includes(key))fail(`${prefix}_UNKNOWN_FIELD`,`${field}.${key}`);
}
function text(value,field,prefix,max=2000){
  if(value===undefined||value===null)return '';
  if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail(`${prefix}_INVALID_TEXT`,field);
  return value.trim();
}
function choice(value,values,field,prefix){if(value==null)return null;if(!values.includes(value))fail(`${prefix}_INVALID_CHOICE`,field);return value;}
function days(value,field){if(value==null)return null;if(!Number.isSafeInteger(value)||value<1||value>3650)fail('RETURNS_INVALID_DAYS',field);return value;}
function version(input,prefix){if(input.schemaVersion!==undefined&&input.schemaVersion!==1)fail(`${prefix}_INVALID_VERSION`,'schemaVersion');}
export function normalizePublicationFacts(input={}){
  object(input,Object.keys(PUBLICATION_FACTS_SCHEMA.properties),'publicationFacts','PUBLICATION');version(input,'PUBLICATION');const result={schemaVersion:1};
  for(const [key,max]of Object.entries(publicationTextLimits))result[key]=text(input[key],key,'PUBLICATION',max);
  for(const [key,values]of Object.entries(publicationChoices))result[key]=choice(input[key],values,key,'PUBLICATION');
  if(result.websiteUrl){let parsed;try{parsed=new URL(result.websiteUrl);}catch{fail('PUBLICATION_INVALID_URL','websiteUrl');}if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)fail('PUBLICATION_INVALID_URL','websiteUrl');}
  return result;
}
function readiness(prefix){return {valid:true,ready:false,requiresReview:false,pending:[],reviews:[],errors:[],legalCertification:false};}
const need=(state,prefix,field,code=`${prefix}_FIELD_REQUIRED`)=>state.pending.push({code,field});
const review=(state,prefix,field,code=`${prefix}_REVIEW_REQUIRED`)=>{state.requiresReview=true;state.reviews.push({code,field});};
function inspected(normalize,check,input,options){try{return check(normalize(input),options);}catch(error){if(!(error instanceof StoreContentError))throw error;return {...readiness(),errors:[{code:error.code,field:error.field}],valid:false};}}
function finish(normalize,check,input,{complete=false,...options}={}){
  const result=normalize(input);if(complete){const state=check(result,options);if(state.requiresReview)fail(state.reviews[0].code,state.reviews[0].field,{reviews:state.reviews});if(state.pending.length)fail(`${options.prefix??'CONTENT'}_INCOMPLETE`,state.pending[0].field,{pending:state.pending});}return result;
}
function normalizeReturns(input){
  object(input,Object.keys(returnsProperties),'returnsPlan','RETURNS');version(input,'RETURNS');
  const result={schemaVersion:1};
  const enums={windowMode:'windowMode',returnShippingPayer:'payer',returnAddressMode:'returnAddressMode',offersExchanges:'offersExchanges',exchangeInboundShippingPayer:'payer',exchangeOutboundShippingPayer:'payer',exchangeRequestWindowMode:'exchangeRequestWindowMode',exchangeProductScope:'exchangeProductScope',exchangePriceDifference:'exchangePriceDifference',exchangeItemCondition:'exchangeItemCondition'};
  for(const [key,enumName]of Object.entries(enums))result[key]=choice(input[key],STORE_CONTENT_CHOICES[enumName],key,'RETURNS');
  result.windowDays=days(input.windowDays,'windowDays');result.exchangeRequestWindowDays=days(input.exchangeRequestWindowDays,'exchangeRequestWindowDays');
  for(const key of Object.keys(returnsProperties).filter(key=>key.endsWith('Other')))result[key]=text(input[key],key,'RETURNS');
  const address=input.returnAddress===undefined?{}:input.returnAddress;object(address,Object.keys(addressSchema.properties),'returnAddress','RETURNS');
  result.returnAddress={};for(const [key,spec]of Object.entries(addressSchema.properties))result.returnAddress[key]=key==='country'?choice(address[key],SHIPPING_COUNTRIES.map(item=>item.code),`returnAddress.${key}`,'RETURNS'):text(address[key],`returnAddress.${key}`,'RETURNS',spec.maxLength);
  const characteristics=input.productCharacteristics===undefined?[]:input.productCharacteristics;
  if(!Array.isArray(characteristics)||characteristics.length>7||new Set(characteristics).size!==characteristics.length||characteristics.some(value=>!STORE_CONTENT_CHOICES.productCharacteristics.includes(value)))fail('RETURNS_INVALID_CHARACTERISTICS','productCharacteristics');
  if(characteristics.length>1&&characteristics.some(value=>['ordinary_goods','unknown'].includes(value)))fail('RETURNS_EXCLUSIVE_CHARACTERISTICS','productCharacteristics');
  result.productCharacteristics=[...characteristics];return result;
}
function checkReturns(plan,{merchantProfile}={}){
  const state=readiness('RETURNS');
  const requiredChoice=(key,otherKey)=>{if(plan[key]===null)need(state,'RETURNS',key);if(plan[key]==='other'){review(state,'RETURNS',key);if(!plan[otherKey])need(state,'RETURNS',otherKey);}};
  requiredChoice('windowMode','windowOther');if(plan.windowMode==='other'&&plan.windowDays===null)need(state,'RETURNS','windowDays');
  requiredChoice('returnShippingPayer','returnShippingPayerOther');requiredChoice('returnAddressMode','returnAddressOther');
  if(plan.returnAddressMode==='declared_store_address'&&!inspectMerchantProfile(merchantProfile??{}).ready)need(state,'RETURNS','merchantProfile','RETURNS_DECLARED_ADDRESS_REQUIRED');
  if(plan.returnAddressMode==='different_address')for(const key of ['recipient','country','line1','city','postalCode'])if(!plan.returnAddress[key])need(state,'RETURNS',`returnAddress.${key}`);
  requiredChoice('offersExchanges','offersExchangesOther');
  if(plan.offersExchanges==='yes'){
    for(const [key,otherKey]of [['exchangeInboundShippingPayer','exchangeInboundShippingPayerOther'],['exchangeOutboundShippingPayer','exchangeOutboundShippingPayerOther'],['exchangeRequestWindowMode','exchangeRequestWindowOther'],['exchangeProductScope','exchangeProductScopeOther'],['exchangePriceDifference','exchangePriceDifferenceOther'],['exchangeItemCondition','exchangeItemConditionOther']])requiredChoice(key,otherKey);
    if(plan.exchangeRequestWindowMode==='different_days_from_receipt'&&plan.exchangeRequestWindowDays===null)need(state,'RETURNS','exchangeRequestWindowDays');
    if(plan.exchangeRequestWindowMode==='same_as_declared_returns'&&(!plan.windowMode||plan.windowMode==='other'))need(state,'RETURNS','windowMode','RETURNS_EXCHANGE_WINDOW_UNRESOLVED');
  }
  if(!plan.productCharacteristics.length)need(state,'RETURNS','productCharacteristics');
  if(plan.productCharacteristics.some(value=>value!=='ordinary_goods'))review(state,'RETURNS','productCharacteristics','RETURNS_CHARACTERISTICS_REVIEW_REQUIRED');
  if(plan.productCharacteristics.includes('other')&&!plan.productCharacteristicsOther)need(state,'RETURNS','productCharacteristicsOther');
  state.ready=state.pending.length===0&&!state.requiresReview;return state;
}
export const normalizeReturnsPlan=(input,options={})=>finish(normalizeReturns,checkReturns,input,{...options,prefix:'RETURNS'});
export const inspectReturnsPlan=(input,options={})=>inspected(normalizeReturns,checkReturns,input,options);
function normalizePolicies(input){
  object(input,Object.keys(policyProperties),'policyInputs','POLICY');version(input,'POLICY');const result={schemaVersion:1};
  for(const key of ['analytics','marketing','internationalTransfers'])result[key]=choice(input[key],STORE_CONTENT_CHOICES.practice,key,'POLICY');
  result.cookieConsent=choice(input.cookieConsent,STORE_CONTENT_CHOICES.cookieConsent,'cookieConsent','POLICY');
  for(const [key,spec]of Object.entries(policyProperties))if(spec.type==='string')result[key]=text(input[key],key,'POLICY',spec.maxLength);
  return result;
}
function checkPolicies(plan){
  const state=readiness('POLICY');
  for(const [key,details]of [['analytics','analyticsDetails'],['marketing','marketingDetails'],['internationalTransfers','internationalTransferDetails']]){
    if(plan[key]===null)need(state,'POLICY',key);
    if(['unknown','other'].includes(plan[key]))review(state,'POLICY',key);
    if(['yes','other'].includes(plan[key])&&!plan[details])need(state,'POLICY',details);
  }
  for(const key of ['serviceProviders','retentionCriteria'])if(!plan[key])need(state,'POLICY',key);
  if(plan.cookieConsent===null)need(state,'POLICY','cookieConsent');
  if(['unknown','other'].includes(plan.cookieConsent))review(state,'POLICY','cookieConsent');
  if(['configured','other'].includes(plan.cookieConsent)&&!plan.cookieConsentDetails)need(state,'POLICY','cookieConsentDetails');
  if((plan.analytics==='yes'||plan.marketing==='yes')&&plan.cookieConsent==='not_configured')review(state,'POLICY','cookieConsent','POLICY_CONSENT_REVIEW_REQUIRED');
  if(plan.privacyContactEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.privacyContactEmail))need(state,'POLICY','privacyContactEmail','POLICY_INVALID_EMAIL');
  state.ready=state.pending.length===0&&!state.requiresReview;return state;
}
export const normalizePolicyInputs=(input,options={})=>finish(normalizePolicies,checkPolicies,input,{...options,prefix:'POLICY'});
export const inspectPolicyInputs=input=>inspected(normalizePolicies,checkPolicies,input);
function normalizePages(input){
  object(input,Object.keys(pageProperties),'pageContent','PAGES');version(input,'PAGES');
  const entries=input.faqEntries===undefined?[]:input.faqEntries;
  if(!Array.isArray(entries)||entries.length>10)fail('PAGES_INVALID_FAQ','faqEntries');
  return {schemaVersion:1,aboutStory:text(input.aboutStory,'aboutStory','PAGES',6000),contactHours:text(input.contactHours,'contactHours','PAGES',500),faqEntries:entries.map((entry,index)=>{object(entry,['question','answer'],`faqEntries[${index}]`,'PAGES');return {question:text(entry.question,`faqEntries[${index}].question`,'PAGES',300),answer:text(entry.answer,`faqEntries[${index}].answer`,'PAGES',2000)};})};
}
function checkPages(plan){const state=readiness('PAGES');plan.faqEntries.forEach((entry,index)=>{for(const key of ['question','answer'])if(!entry[key])need(state,'PAGES',`faqEntries[${index}].${key}`);});state.ready=state.pending.length===0;return state;}
export const normalizePageContent=(input,options={})=>finish(normalizePages,checkPages,input,{...options,prefix:'PAGES'});
export const inspectPageContent=input=>inspected(normalizePages,checkPages,input);

const amount=value=>`${(value/100).toFixed(2).replace('.',',')} €`;
const kilos=value=>`${String(value/1000).replace('.',',')} κιλά`;
const countryNames=new Map(SHIPPING_COUNTRIES.map(item=>[item.code,item.name]));
const addressText=value=>[value.recipient,value.line1,value.line2,value.city,value.postalCode,countryNames.get(value.country)].filter(Boolean).join(', ');
const payerText=value=>value==='buyer'?'ο αγοραστής':value==='store'?'το κατάστημα':null;
const windowText=value=>value==='statutory_only'?'τη νόμιμη προθεσμία, χωρίς πρόσθετη εμπορική παράταση':value==='30_days_total_from_receipt'?'30 συνολικά ημέρες από την παραλαβή':value==='60_days_total_from_receipt'?'60 συνολικά ημέρες από την παραλαβή':null;
function paymentText(plan){
  const methods=plan.manualMethods.map(method=>method==='bank_deposit'?'τραπεζική κατάθεση':'αντικαταβολή');
  if(plan.online==='shopify_payments')methods.unshift('online πληρωμές μέσω Shopify Payments');
  if(plan.additionalMethods.includes('klarna'))methods.push('Klarna, υπό τις προϋποθέσεις και την έγκριση του παρόχου');
  return methods.length?`Δηλωμένες επιλογές πληρωμής: ${methods.join(', ')}. Η πραγματική διαθεσιμότητα θα επιβεβαιωθεί μετά την ενεργοποίηση στο Shopify.`:'[Προς συμπλήρωση: επιλεγμένες μέθοδοι πληρωμής.]';
}
function shippingText(plan){
  if(!plan?.zones?.length)return '[Προς συμπλήρωση: περιοχές και κανόνες αποστολής.]';
  const lines=[];
  for(const zone of plan.zones){
    if(!zone.countries.length&&!zone.mode)continue;
    const destination=zone.countries.map(code=>countryNames.get(code)??code).join(', ')||'[περιοχή προς συμπλήρωση]';
    let rule='[χρέωση προς συμπλήρωση]';
    if(zone.mode==='always_free')rule='δωρεάν αποστολή';
    if(['flat','free_from_amount','weight_increment'].includes(zone.mode)&&zone.basePriceMinor!==null)rule=`βασική χρέωση ${amount(zone.basePriceMinor)}`;
    if(zone.mode==='weight_increment'){
      if([zone.initialWeightGrams,zone.incrementWeightGrams,zone.incrementPriceMinor,zone.incrementMode].some(value=>value===null))rule+='· [κλιμάκωση βάρους προς συμπλήρωση]';
      else rule+=` έως ${kilos(zone.initialWeightGrams)}. Πάνω από αυτό το βάρος προστίθενται ${amount(zone.incrementPriceMinor)} ανά ${zone.incrementMode==='complete_interval'?'πλήρες':'αρχόμενο'} διάστημα ${kilos(zone.incrementWeightGrams)}`;
    }
    if(['free_from_amount','weight_increment'].includes(zone.mode)&&zone.freeFromAmountMinor!==null){rule+=`· δωρεάν από αξία παραγγελίας ${amount(zone.freeFromAmountMinor)}`;if(zone.freeMaxWeightGrams!==null)rule+=`, για συνολικό βάρος έως ${kilos(zone.freeMaxWeightGrams)}. Πάνω από αυτό το βάρος εφαρμόζεται η κανονική χρέωση`;} 
    if(zone.mode==='other')rule=`[Αίτημα προς έλεγχο: ${zone.other||'να συμπληρωθεί ο κανόνας'}]`;
    lines.push(`${zone.label?`${zone.label} — `:''}${destination}: ${rule}.`);
  }
  for(const [key,label]of [['preparationTime','Προετοιμασία'],['transitTime','Μεταφορά']])if(plan[key]&&Object.values(plan[key]).every(value=>value!==null)){const timing=plan[key];lines.push(`${label}: ${timing.minDays}–${timing.maxDays} ${timing.dayType==='business'?'εργάσιμες':'ημερολογιακές'} ημέρες.`);}
  if(plan.pickupRequested===true)lines.push('Έχει ζητηθεί παραλαβή από σημείο. Η πραγματική διαθεσιμότητα και οι οδηγίες θα επιβεβαιωθούν μετά τη ρύθμιση στο Shopify.');
  if(plan.zones.some(zone=>zone.mode==='weight_increment'||zone.freeMaxWeightGrams!==null))lines.push('Για τους κανόνες βάρους υπολογίζονται τα δηλωμένα βάρη των προϊόντων και της συσκευασίας.');
  return lines.join('\n');
}
export function escapeStoreContentHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
export function storeContentTextToHtml(value){
  if(typeof value!=='string')fail('PUBLICATION_INVALID_TEXT','text');
  return value.split(/\n\s*\n/).filter(Boolean).map(part=>{const safe=escapeStoreContentHtml(part.trim()).replace(/\n/g,'<br>');return /^\d+\. [^\n]+$/.test(part.trim())?`<h2>${safe}</h2>`:`<p>${safe}</p>`;}).join('\n');
}
function preparePublicDocuments({merchant,returns,policies,pages,shipping,payments,business,publicationFacts,documents,inputPending,returnLines}){
  const blockers=inputPending.map(item=>({...item,source:'onboarding'}));
  let facts;try{facts=normalizePublicationFacts(publicationFacts??{});}catch(error){blockers.push({code:error.code??'PUBLICATION_INVALID_FACTS',field:`publicationFacts.${error.field??''}`});facts=normalizePublicationFacts({});}
  const missing=(field,label,code='PUBLICATION_FACT_REQUIRED')=>{blockers.push({code,field:`publicationFacts.${field}`});return `[${label}]`;};
  const fact=(key,label)=>facts[key]||missing(key,label);
  const name=typeof business?.name==='string'&&business.name.trim()?business.name.trim():'[Όνομα καταστήματος]';
  const legalName=fact('legalName','Πλήρης νομική επωνυμία πωλητή'),email=merchant.contactEmail||'[Email πωλητή]';
  const identity=[`Το ηλεκτρονικό κατάστημα ${name} λειτουργεί από τον πωλητή ${legalName}.`,`Ιστότοπος: ${fact('websiteUrl','Διεύθυνση του ιστοτόπου')}.`,`Έδρα / ταχυδρομική διεύθυνση: ${addressText({country:merchant.country,...merchant.address})||'[Πλήρης διεύθυνση πωλητή]'}.`,`ΑΦΜ: ${fact('taxNumber','Πραγματικός ΑΦΜ πωλητή')}.`];
  if(facts.registryStatus==='registered')identity.push(`Αριθμός ΓΕΜΗ: ${fact('registryNumber','Πραγματικός αριθμός ΓΕΜΗ')}.`);
  else if(facts.registryStatus!=='not_applicable')identity.push(missing('registryStatus','Στοιχεία υποχρεωτικής εγγραφής σε μητρώο, όπου εφαρμόζονται'));
  if(!merchant.contactPhone)blockers.push({code:'PUBLICATION_CONTACT_PHONE_REQUIRED',field:'merchantProfile.contactPhone'});
  identity.push(`Επικοινωνία: ${email}${merchant.contactPhone?`, τηλέφωνο ${merchant.contactPhone}`:', [Τηλέφωνο επικοινωνίας]'}.`);
  const formation={order_confirmation:'Η σύμβαση συνάπτεται όταν λαμβάνετε την επιβεβαίωση αποδοχής της παραγγελίας από το κατάστημα.',separate_acceptance:'Η υποβολή της παραγγελίας αποτελεί αίτημα αγοράς. Η σύμβαση συνάπτεται όταν το κατάστημα σας αποστείλει χωριστή επιβεβαίωση αποδοχής.',dispatch_confirmation:'Η σύμβαση συνάπτεται όταν το κατάστημα σας αποστείλει την επιβεβαίωση αποστολής που περιλαμβάνει την αποδοχή της παραγγελίας.'};
  const formationText=facts.contractFormation==='other'?fact('contractFormationDetails','Ακριβής διαδικασία σύναψης της σύμβασης'):formation[facts.contractFormation]??missing('contractFormation','Επιβεβαιωμένο στάδιο σύναψης της σύμβασης');
  let taxText;
  if(facts.pricesTaxMode==='vat_included')taxText='Οι αναγραφόμενες τιμές για καταναλωτές είναι σε ευρώ και περιλαμβάνουν τον εφαρμοστέο ΦΠΑ.';
  else if(facts.pricesTaxMode==='vat_exempt')taxText=`Στις τιμές δεν προστίθεται ΦΠΑ για τον ακόλουθο δηλωμένο λόγο απαλλαγής: ${fact('pricesTaxDetails','Εφαρμοζόμενη απαλλαγή ΦΠΑ')}.`;
  else if(facts.pricesTaxMode==='other')taxText=fact('pricesTaxDetails','Επιβεβαιωμένη παρουσίαση τιμών και εφαρμοζόμενων φόρων');
  else taxText=missing('pricesTaxMode','Επιβεβαιωμένη πληροφορία για ΦΠΑ / φορολογική μεταχείριση τιμών');
  const acknowledgement=fact('orderAcknowledgementDetails','Πραγματική διαδικασία ηλεκτρονικής επιβεβαίωσης παραλαβής της παραγγελίας');
  const paymentAvailability=fact('paymentAvailabilityDetails','Μέθοδοι πληρωμής που έχουν πράγματι ενεργοποιηθεί και οι εφαρμοζόμενοι περιορισμοί');
  const deliveryDetails=fact('deliveryDeadlineDetails','Επιβεβαιωμένοι χρόνοι και διαδικασία παράδοσης / ενημέρωσης καθυστέρησης');
  const shippingBody=shippingText(shipping).split('\n').filter(line=>!line.startsWith('Έχει ζητηθεί παραλαβή από σημείο.')).join('\n');
  const parts=(...values)=>values.filter(Boolean).join('\n\n');
  const terms=parts(
    '1. Πωλητής και επικοινωνία',identity.join('\n'),
    '2. Πεδίο εφαρμογής και πληροφορίες προϊόντων',
    'Οι παρόντες όροι αφορούν αγορές των φυσικών αγαθών που διατίθενται μέσω του ιστοτόπου. Τα χαρακτηριστικά, οι διαθέσιμες παραλλαγές, οι τιμές και οι πληροφορίες κάθε προϊόντος αναγράφονται στην αντίστοιχη σελίδα. Οι πληροφορίες που είναι ουσιώδεις για την αγορά αποτελούν μέρος της σύμβασης. Οι φωτογραφίες δεν περιορίζουν τα δικαιώματά σας αν το παραδοθέν προϊόν δεν ανταποκρίνεται στην περιγραφή ή στα συμφωνημένα χαρακτηριστικά.',
    '3. Υποβολή παραγγελίας και διόρθωση στοιχείων',
    'Επιλέγετε προϊόντα και ποσότητες, τα προσθέτετε στο καλάθι και συμπληρώνετε τα στοιχεία που απαιτούνται για επικοινωνία, παράδοση και πληρωμή. Πριν από την τελική υποβολή ελέγχετε το περιεχόμενο της παραγγελίας, διορθώνετε τυχόν σφάλματα και βλέπετε το συνολικό ποσό. Η ενέργεια που ολοκληρώνει παραγγελία με υποχρέωση πληρωμής πρέπει να το δηλώνει ευκρινώς. Μπορείτε να αποχωρήσετε πριν από την οριστική υποβολή. Αν διαπιστώσετε λάθος αφού υποβάλετε την παραγγελία, επικοινωνήστε άμεσα μαζί μας· η δυνατότητα διόρθωσης εξετάζεται ανάλογα με το στάδιο εκτέλεσης, χωρίς περιορισμό των νόμιμων δικαιωμάτων σας.',
    '4. Επιβεβαίωση και σύναψη σύμβασης',
    acknowledgement,formationText,
    'Η επιβεβαίωση παραλαβής ενός αιτήματος και η αποδοχή του είναι διαφορετικά γεγονότα, όταν η παραπάνω διαδικασία προβλέπει χωριστή αποδοχή. Οι όροι και οι πληροφορίες της συγκεκριμένης αγοράς παρέχονται σε μορφή που μπορείτε να αποθηκεύσετε. Διατηρήστε την επιβεβαίωση και το παραστατικό σας. Η γλώσσα του παρόντος κειμένου και της περιγραφόμενης διαδικασίας είναι η ελληνική.',
    '5. Τιμές, φόροι και συνολικό κόστος',taxText,
    'Τα έξοδα αποστολής και κάθε πρόσθετη επιβάρυνση που εφαρμόζεται εμφανίζονται πριν από την οριστική παραγγελία. Πρόσθετες υπηρεσίες δεν χρεώνονται χωρίς τη ρητή επιλογή σας. Για την αγορά ισχύει η τιμή που συμφωνήθηκε κατά τη σύναψη της σύμβασης. Αν εντοπιστεί πραγματικό σφάλμα τιμής ή στοιχείων, θα ενημερωθείτε για τη συγκεκριμένη περίπτωση· δεν επιβάλλεται διαφορετική τιμή χωρίς συμφωνία ούτε προβλέπεται γενική μονομερής ακύρωση που παρακάμπτει τον νόμο.',
    '6. Πληρωμές',paymentAvailability,
    'Επιλέγετε ανάμεσα στις μεθόδους που εμφανίζονται ως διαθέσιμες για τη συγκεκριμένη παραγγελία. Τυχόν ειδικοί όροι παρόχου πληρωμών ή χρηματοδότησης εμφανίζονται πριν από τη χρήση του. Η επιτυχής καταχώριση παραγγελίας με τραπεζική κατάθεση ή αντικαταβολή δεν σημαίνει από μόνη της ότι το ποσό έχει εισπραχθεί. Δεν ζητούμε να μας στείλετε κωδικούς τραπεζικών λογαριασμών ή στοιχεία πρόσβασης σε υπηρεσίες πληρωμής μέσω απλού email.',
    '7. Περιοχές αποστολής, χρεώσεις και παράδοση',shippingBody,deliveryDetails,
    'Αν δεν έχει συμφωνηθεί άλλος χρόνος παράδοσης, για τις καλυπτόμενες καταναλωτικές αγορές εφαρμόζεται η νόμιμη υποχρέωση παράδοσης χωρίς αδικαιολόγητη καθυστέρηση και το αργότερο μέσα σε 30 ημέρες από τη σύναψη της σύμβασης. Σε καθυστέρηση διατηρείτε τα δικαιώματα πρόσθετης εύλογης προθεσμίας ή λύσης της σύμβασης όπου συντρέχουν οι νόμιμες προϋποθέσεις.',
    'Ο κίνδυνος απώλειας ή ζημίας μεταβαίνει όταν εσείς ή τρίτος που έχετε ορίσει, διαφορετικός από τον μεταφορέα, παραλάβετε φυσικά τα αγαθά. Ισχύει η ειδική νόμιμη εξαίρεση αν αναθέσετε τη μεταφορά σε μεταφορέα που δεν προσφέρθηκε από το κατάστημα.',
    '8. Υπαναχώρηση, επιστροφές και προαιρετικές αλλαγές',
    `Για δήλωση υπαναχώρησης και αιτήματα επιστροφής μπορείτε να επικοινωνείτε στο ${email}. Οι χωριστές προθεσμίες δήλωσης, αποστολής πίσω και επιστροφής χρημάτων, ο προορισμός επιστροφής και οι δηλωμένες εμπορικές παροχές περιγράφονται στην πολιτική «Επιστροφές και αλλαγές».`,
    'Η νόμιμη υπαναχώρηση και τα δικαιώματα λόγω μη συμμόρφωσης δεν συγχέονται με προαιρετικές εμπορικές αλλαγές. Απαίτηση αχρησιμοποίητου προϊόντος ή αρχικής συσκευασίας για προαιρετική αλλαγή δεν αποτελεί γενικό όρο άσκησης νόμιμης υπαναχώρησης. Τυχόν ευθύνη για μείωση αξίας εξετάζεται μόνο υπό τις νόμιμες προϋποθέσεις. Εξαίρεση από την υπαναχώρηση δεν θεμελιώνεται μόνο από την κατηγορία προϊόντος.',
    '9. Νόμιμη ευθύνη για προϊόν που δεν ανταποκρίνεται στη σύμβαση',
    'Αν το προϊόν είναι ελαττωματικό, διαφορετικό από το συμφωνημένο ή δεν ανταποκρίνεται στις απαιτήσεις της σύμβασης, επικοινωνήστε μαζί μας περιγράφοντας το πρόβλημα και την παραγγελία. Ο πωλητής ευθύνεται σύμφωνα με την εφαρμοστέα νομοθεσία. Μπορείτε να ασκήσετε τα νόμιμα δικαιώματα διόρθωσης ή αντικατάστασης και, όταν πληρούνται οι αντίστοιχες προϋποθέσεις, μείωσης τιμήματος ή λύσης της σύμβασης. Η νόμιμη αποκατάσταση παρέχεται χωρίς επιβάρυνση, μέσα σε εύλογο χρόνο και χωρίς σημαντική ενόχληση, όπως προβλέπει ο νόμος.',
    'Η επιλογή επισκευής ή αντικατάστασης και οι περιπτώσεις αδυναμίας ή δυσανάλογου κόστους αξιολογούνται σύμφωνα με τον νόμο. Ισχύουν οι νόμιμες προθεσμίες και τυχόν παρατάσεις τους, συμπεριλαμβανομένων όσων συνδέονται με επιλογή διόρθωσης. Μια πρόσθετη εμπορική εγγύηση, αν παρέχεται και περιγράφεται για το προϊόν, δεν αντικαθιστά ούτε περιορίζει τη νόμιμη ευθύνη του πωλητή.',
    '10. Παράπονα και αιτήματα υποστήριξης',
    `Για παράπονο ή αίτημα σχετικά με τη συναλλαγή στείλτε στο ${email} τον αριθμό παραγγελίας, σύντομη περιγραφή και τα στοιχεία επικοινωνίας σας. Ζητούμε μόνο όσα στοιχεία είναι αναγκαία για την εξέταση. Η επικοινωνία υποστήριξης δεν αποτελεί προϋπόθεση παραίτησης από άλλα δικαιώματα ή προσφυγής στις αρμόδιες αρχές και στα δικαστήρια.`,
    '11. Προσωπικά δεδομένα και cookies',
    'Η επεξεργασία προσωπικών δεδομένων περιγράφεται στην Πολιτική απορρήτου. Η αποδοχή όρων αγοράς δεν ισοδυναμεί με συγκατάθεση για κάθε χρήση προσωπικών δεδομένων, διαφημιστική επικοινωνία ή μη αναγκαία cookies. Όπου απαιτείται συγκατάθεση, παρέχεται χωριστά και μπορεί να ανακληθεί.',
    '12. Υποχρεωτικά δικαιώματα, εφαρμοστέοι κανόνες και αλλαγές όρων',
    'Κανένας όρος δεν αποκλείει υποχρεωτικά δικαιώματα του καταναλωτή. Η εφαρμογή ελληνικού δικαίου δεν στερεί την προστασία που παρέχουν υποχρεωτικοί κανόνες οι οποίοι εφαρμόζονται νόμιμα στη συγκεκριμένη συναλλαγή. Η αρμοδιότητα δικαστηρίων καθορίζεται από τους εφαρμοστέους κανόνες και δεν περιορίζεται εδώ αποκλειστικά στην έδρα του πωλητή. Μεταγενέστερη τροποποίηση των όρων αφορά μελλοντικές συμβάσεις και δεν αλλάζει μονομερώς ήδη συμφωνημένη αγορά.'
  );
  const providers=fact('providerRoles','Πραγματικοί αποδέκτες / πάροχοι και ο ρόλος τους στην επεξεργασία');
  const bases=fact('privacyPurposesAndBases','Επιβεβαιωμένοι σκοποί και νομικές βάσεις των συγκεκριμένων λειτουργιών του καταστήματος');
  const transfers=fact('transferSafeguards','Πραγματικές διεθνείς διαβιβάσεις και εφαρμοζόμενες εγγυήσεις / τρόπος λήψης πληροφοριών');
  let enhanced;
  if(facts.enhancedServices==='enabled')enhanced=parts('Σύμφωνα με την εφαρμοζόμενη ρύθμιση, χρησιμοποιούνται ενισχυμένες υπηρεσίες του Shopify. Για συγκεκριμένες χρήσεις το Shopify ενεργεί και ως ανεξάρτητος υπεύθυνος επεξεργασίας, όπως περιγράφεται στη δική του ενημέρωση. Η χρήση αλληλεπιδράσεων μεταξύ εμπόρων και οι διαθέσιμες επιλογές απορρήτου περιγράφονται παρακάτω.',fact('enhancedServicesDetails','Πραγματικά ενεργές ενισχυμένες υπηρεσίες, δεδομένα, σκοποί και επιλογές χρήστη'),'Πληροφορίες του Shopify για καταναλωτές: https://www.shopify.com/legal/privacy/consumers .');
  else if(facts.enhancedServices==='disabled')enhanced='Σύμφωνα με τη δηλωμένη ρύθμιση του καταστήματος δεν έχουν ενεργοποιηθεί ενισχυμένες υπηρεσίες με Shopify Network Intelligence. Τυχόν μεταβολή των λειτουργιών χρειάζεται αντίστοιχη ενημέρωση της πολιτικής και των επιλογών απορρήτου.';
  else enhanced=missing('enhancedServices','Πραγματική κατάσταση Shopify Network Intelligence / Enhanced Services και τυχόν σχετική ενημέρωση');
  let automation;
  if(facts.automatedDecisions==='none')automation='Σύμφωνα με τις δηλωμένες λειτουργίες του καταστήματος δεν λαμβάνονται αποφάσεις που βασίζονται αποκλειστικά σε αυτοματοποιημένη επεξεργασία και παράγουν έννομα ή αντίστοιχα σημαντικά αποτελέσματα για εσάς.';
  else if(facts.automatedDecisions==='present')automation=fact('automatedDecisionDetails','Συγκεκριμένες αυτοματοποιημένες αποφάσεις, λογική, σημασία, συνέπειες και διαθέσιμα δικαιώματα');
  else automation=missing('automatedDecisions','Έλεγχος ύπαρξης αυτοματοποιημένων αποφάσεων με έννομα ή σημαντικά αποτελέσματα');
  const privacyEmail=policies.privacyContactEmail||email;
  const analytics=policies.analytics==='yes'?parts('Για στατιστική ανάλυση έχει δηλωθεί η ακόλουθη λειτουργία:',policies.analyticsDetails,'Όπου η λειτουργία χρησιμοποιεί μη αναγκαίες τεχνολογίες ή απαιτεί συγκατάθεση, ενεργοποιείται μόνο με την απαιτούμενη επιλογή. Η άρνηση τέτοιας επιλογής δεν μετατρέπεται σε αποδοχή μέσω της συνέχισης περιήγησης.'):policies.analytics==='no'?'Δεν έχει δηλωθεί πρόσθετη λειτουργία analytics από τον πωλητή. Αυτό δεν αποτελεί δήλωση ότι η πλατφόρμα δεν επεξεργάζεται τεχνικά δεδομένα αναγκαία για τις υπηρεσίες που πράγματι χρησιμοποιούνται.':'[Πραγματικές λειτουργίες analytics και απαιτούμενες επιλογές χρήστη]';
  const marketing=policies.marketing==='yes'?parts('Έχουν δηλωθεί οι ακόλουθες λειτουργίες εμπορικής επικοινωνίας ή διαφήμισης:',policies.marketingDetails,'Η συγκεκριμένη νομική βάση, οι αποδέκτες και ο τρόπος άσκησης των επιλογών σας προσδιορίζονται στα στοιχεία των πραγματικών λειτουργιών. Όταν η επικοινωνία βασίζεται σε συγκατάθεση, η αγορά δεν εξαρτάται από τη συγκατάθεσή σας και μπορείτε να την ανακαλέσετε. Μπορείτε να αντιταχθείτε στην επεξεργασία για απευθείας εμπορική προώθηση.'):policies.marketing==='no'?'Δεν έχει δηλωθεί χρήση πρόσθετων λειτουργιών marketing ή διαφήμισης από το κατάστημα. Τα μηνύματα που είναι αναγκαία για συγκεκριμένη παραγγελία εξετάζονται χωριστά από διαφημιστική επικοινωνία.':'[Πραγματικές λειτουργίες marketing, νομική βάση και επιλογές χρήστη]';
  if(policies.cookieConsent!=='configured')blockers.push({code:'PUBLICATION_COOKIE_CONFIGURATION_REVIEW_REQUIRED',field:'policyInputs.cookieConsent'});
  const privacy=parts(
    '1. Ποιος είναι υπεύθυνος και πώς επικοινωνείτε',
    `Υπεύθυνος επεξεργασίας για τις λειτουργίες του καταστήματος ${name} είναι ${legalName}, με διεύθυνση ${addressText({country:merchant.country,...merchant.address})||'[Διεύθυνση υπευθύνου επεξεργασίας]'}. Για ερωτήσεις ή άσκηση δικαιωμάτων μπορείτε να επικοινωνείτε στο ${privacyEmail}.`,facts.dpoContact?`Ειδική επαφή προστασίας δεδομένων που έχει οριστεί: ${facts.dpoContact}.`:null,
    '2. Ποια στοιχεία αφορούν οι λειτουργίες του καταστήματος',
    'Για μια παραγγελία απαιτούνται τα στοιχεία που δηλώνετε για την ταυτοποίηση της συναλλαγής, την επικοινωνία, την τιμολόγηση και την παράδοση, καθώς και προϊόντα, ποσότητες, ποσά και κατάσταση της παραγγελίας. Για την επικοινωνία υποστήριξης χρησιμοποιούνται τα στοιχεία και το περιεχόμενο που μας αποστέλλετε. Τεχνικά δεδομένα συσκευής, σύνδεσης και χρήσης επεξεργάζονται μόνο στο πλαίσιο των πραγματικών λειτουργιών που περιγράφονται παρακάτω.',
    'Οι πάροχοι πληρωμών διαχειρίζονται τα στοιχεία που είναι απαραίτητα για τη δική τους υπηρεσία σύμφωνα με τους εφαρμοστέους όρους. Δεν πρέπει να αποστέλλετε κωδικούς πρόσβασης ή πλήρη στοιχεία κάρτας με μήνυμα υποστήριξης. Αν λειτουργία συλλέγει πρόσθετες κατηγορίες δεδομένων, αυτές πρέπει να αναφέρονται στη συγκεκριμένη περιγραφή της.',
    '3. Σκοποί και νομικές βάσεις',bases,
    'Για ενέργειες που είναι αντικειμενικά αναγκαίες ώστε να ζητήσετε προσφορά, να πραγματοποιήσετε αγορά ή να εκτελεστεί η σύμβαση, η σχετική βάση είναι τα προσυμβατικά μέτρα ή η εκτέλεση σύμβασης. Η συμμόρφωση με συγκεκριμένες φορολογικές ή άλλες νόμιμες υποχρεώσεις στηρίζεται στη σχετική νομική υποχρέωση. Οι συγκεκριμένες υποχρεώσεις, τυχόν χρήση εννόμου συμφέροντος και τα συμφέροντα που επιδιώκονται πρέπει να προσδιορίζονται στην παραπάνω περιγραφή, εφόσον πράγματι εφαρμόζονται. Δεν θεωρείται ότι η περιήγηση ή η αποδοχή όρων αποτελεί γενική συγκατάθεση.',
    '4. Από πού προέρχονται τα δεδομένα και ποια είναι αναγκαία',
    'Τα στοιχεία της παραγγελίας και της επικοινωνίας προέρχονται κυρίως από εσάς. Ενημερώσεις κατάστασης συναλλαγής ή παράδοσης μπορεί να προκύπτουν από τον αντίστοιχο πάροχο που χρησιμοποιείται για την υπηρεσία. Τα υποχρεωτικά πεδία επισημαίνονται κατά τη συλλογή. Αν δεν δοθούν στοιχεία αναγκαία για την αγορά ή την παράδοση, δεν είναι δυνατή η ολοκλήρωση της συγκεκριμένης υπηρεσίας· αυτό δεν καθιστά υποχρεωτικές προαιρετικές επιλογές marketing.',
    '5. Πάροχοι και αποδέκτες',
    `Δηλωμένες υπηρεσίες του καταστήματος: ${policies.serviceProviders||'[Πάροχοι και υπηρεσίες]'}`,providers,
    'Η ιδιότητα κάθε παρόχου ως εκτελούντος την επεξεργασία ή ανεξάρτητου υπευθύνου εξετάζεται ανά υπηρεσία. Για τη βασική πλατφόρμα το Shopify αναλαμβάνει καθήκοντα επεξεργασίας βάσει της σχετικής σύμβασης· δεν περιγράφεται αυτόματα ως μόνο εκτελών για όλες τις πρόσθετες λειτουργίες.',enhanced,
    '6. Διεθνείς διαβιβάσεις',transfers,
    'Η χρήση Shopify ή άλλου παρόχου μπορεί να περιλαμβάνει επεξεργασία εκτός ΕΟΧ. Μια γενική δήλωση ότι δεν γίνονται διαβιβάσεις δεν αρκεί για να αποκλείσει τις πραγματικές ροές του παρόχου. Όπου γίνονται διαβιβάσεις, πρέπει να προσδιορίζονται ο εφαρμοζόμενος νόμιμος μηχανισμός και ο τρόπος λήψης πληροφοριών για τις εγγυήσεις.',
    '7. Cookies και παρόμοιες τεχνολογίες',
    policies.cookieConsent==='configured'?policies.cookieConsentDetails:'[Πραγματικές τεχνολογίες cookies, σκοποί, διάρκεια και μηχανισμός διαχείρισης επιλογών]',
    'Οι τεχνολογίες που είναι απαραίτητες για λειτουργία που ζητάτε διακρίνονται από μη αναγκαίες τεχνολογίες analytics ή διαφήμισης. Όπου απαιτείται συγκατάθεση, πρέπει να παρέχεται πριν από την αντίστοιχη ενεργοποίηση και να μπορείτε να μεταβάλετε την επιλογή σας. Η ακριβής πρόσβαση στις ρυθμίσεις και οι χρησιμοποιούμενες τεχνολογίες περιγράφονται παραπάνω.',
    '8. Στατιστικά και εμπορική επικοινωνία',analytics,marketing,
    '9. Διατήρηση δεδομένων',policies.retentionCriteria||'[Πραγματικοί χρόνοι ή κριτήρια διατήρησης ανά σκοπό]',
    'Η διατήρηση συνδέεται με τον εκάστοτε σκοπό και τις υποχρεώσεις που εφαρμόζονται στα συγκεκριμένα στοιχεία. Διαφορετικές κατηγορίες μπορεί να έχουν διαφορετικούς χρόνους. Μετά τη λήξη του εφαρμοζόμενου χρόνου ακολουθείται η προβλεπόμενη διαδικασία διαγραφής ή ανωνυμοποίησης, εκτός αν υπάρχει νόμιμος λόγος περαιτέρω διατήρησης.',
    '10. Τα δικαιώματά σας',
    `Μπορείτε να ζητήσετε πρόσβαση στα δεδομένα σας, διόρθωση ανακριβειών και, όπου συντρέχουν οι νόμιμες προϋποθέσεις, διαγραφή, περιορισμό ή φορητότητα. Μπορείτε να αντιταχθείτε σε επεξεργασία που στηρίζεται σε έννομο συμφέρον και πάντοτε στην επεξεργασία για απευθείας εμπορική προώθηση. Αν η επεξεργασία βασίζεται σε συγκατάθεση, μπορείτε να την ανακαλέσετε χωρίς να επηρεάζεται η νομιμότητα της προηγούμενης επεξεργασίας. Στείλτε το αίτημά σας στο ${privacyEmail}.`,
    'Ενδέχεται να χρειαστούν αναλογικά στοιχεία για επιβεβαίωση ταυτότητας. Τα αιτήματα εξετάζονται χωρίς αδικαιολόγητη καθυστέρηση, κατά κανόνα μέσα σε έναν μήνα. Αν επιτρέπεται παράταση λόγω πολυπλοκότητας ή πλήθους αιτημάτων, μπορεί να φτάσει έως δύο επιπλέον μήνες, με ενημέρωση και αιτιολόγηση μέσα στον πρώτο μήνα. Οι νόμιμες εξαιρέσεις, όπως υποχρεωτική διατήρηση συγκεκριμένων στοιχείων, εξετάζονται ανά αίτημα.',
    '11. Αυτοματοποιημένες αποφάσεις',automation,
    '12. Εποπτική αρχή και ενημερώσεις',
    'Έχετε δικαίωμα υποβολής καταγγελίας στην Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα (www.dpa.gr) ή σε άλλη αρμόδια εποπτική αρχή, σύμφωνα με τον GDPR. Η προηγούμενη επικοινωνία μαζί μας δεν περιορίζει αυτό το δικαίωμα. Η ενημέρωση πρέπει να επικαιροποιείται όταν αλλάζουν οι πραγματικές λειτουργίες ή οι σχετικές υποχρεώσεις, με την απαιτούμενη ενημέρωση των προσώπων που επηρεάζονται.',
    policies.additionalPractices?`Πρόσθετες πραγματικές πρακτικές: ${policies.additionalPractices}`:null
  );
  // Public bodies do not inherit editor headings, approval instructions or
  // internal native-setup assertions. Missing facts remain explicit slots.
  const returnBody=returnLines.filter(line=>!line.startsWith('Η ηλεκτρονική λειτουργία υπαναχώρησης χρειάζεται')).map(line=>line.replace('Δηλωμένη εμπορική επιλογή για την προθεσμία αιτήματος:','Προθεσμία αιτήματος επιστροφής:').replace('Δηλωμένος προορισμός επιστροφής:','Προορισμός επιστροφής:')).join('\n\n');
  const contact=parts(legalName,`Email: ${email}`,merchant.contactPhone?`Τηλέφωνο: ${merchant.contactPhone}`:null,pages.contactHours?`Ωράριο επικοινωνίας: ${pages.contactHours}`:null);
  const faq=parts('Πώς μπορώ να επικοινωνήσω;',`Στο ${email}${merchant.contactPhone?` ή στο ${merchant.contactPhone}`:''}.`,'Πώς μπορώ να πληρώσω;',paymentAvailability,'Ποιες είναι οι χρεώσεις αποστολής;',shippingBody,'Πώς υποβάλλω αίτημα επιστροφής;',`Μπορείτε να επικοινωνείτε στο ${email}. Δείτε την πολιτική «Επιστροφές και αλλαγές» για τις χωριστές προθεσμίες, τον προορισμό επιστροφής και τα δικαιώματά σας.`,...pages.faqEntries.filter(item=>item.question||item.answer).map(item=>`${item.question||'[Ερώτηση]'}\n${item.answer||'[Απάντηση]'}`));
  const bodies={terms,privacy,returns:returnBody,shipping:parts(shippingBody,deliveryDetails),about:parts(name,pages.aboutStory||(typeof business?.activity==='string'?business.activity:'[Ιστορία ή δραστηριότητα καταστήματος]')),contact,faq};
  const seen=new Set(),publicationBlockers=blockers.filter(item=>{const key=`${item.code}:${item.field}`;if(seen.has(key))return false;seen.add(key);return true;});
  const enhancedDocuments=documents.map(document=>({id:document.id,title:document.title,text:document.text,...(['terms','privacy'].includes(document.id)?{text:`${document.text}\n\nΠΛΗΡΕΣ ΚΕΙΜΕΝΟ ΠΡΟΣ ΕΛΕΓΧΟ\n\n${bodies[document.id]}`} : {}),publicText:bodies[document.id],publicHtml:storeContentTextToHtml(bodies[document.id]),reviewNotes:[{code:'NOT_LEGAL_CERTIFICATION',text:'Το καθαρό κείμενο παραμένει προς έλεγχο στην ακριβή εκδοχή του. Οι πραγματικές ρυθμίσεις και τα στοιχεία πωλητή δεν πιστοποιούνται από τον renderer.'}]}));
  return {documents:enhancedDocuments,publicationBlockers,publicContentComplete:publicationBlockers.length===0,publicationFactsAuthority:'operator_declarations_not_verification'};
}

export function renderStoreContent({business={},merchantProfile,shippingPlan,paymentPlan,returnsPlan,policyInputs,pageContent,packageId,publicationFacts}={}){
  const pending=[];
  const add=(prefix,state)=>{for(const issue of [...(state.errors??[]),...(state.pending??[]),...(state.reviews??[])])pending.push({code:issue.code,field:prefix?`${prefix}.${issue.field}`:issue.field});if(state.requiresReview&&!state.reviews?.length)pending.push({code:{merchantProfile:'MERCHANT_REVIEW_REQUIRED',paymentPlan:'PAYMENT_REVIEW_REQUIRED',shippingPlan:'SHIPPING_REVIEW_REQUIRED'}[prefix]??'CONTENT_REVIEW_REQUIRED',field:prefix});};
  const safe=(normalize,input,key)=>{try{return normalize(input??{});}catch(error){if(!error?.code)throw error;pending.push({code:error.code,field:`${key}.${error.field??error.details?.field??''}`});return normalize({});}};
  const merchant=safe(normalizeMerchantProfile,merchantProfile,'merchantProfile');add('merchantProfile',inspectMerchantProfile(merchant));
  const returns=safe(normalizeReturnsPlan,returnsPlan,'returnsPlan');add('returnsPlan',inspectReturnsPlan(returns,{merchantProfile:merchant}));
  const policies=safe(normalizePolicyInputs,policyInputs,'policyInputs');add('policyInputs',inspectPolicyInputs(policies));
  const pages=safe(normalizePageContent,pageContent,'pageContent');add('pageContent',inspectPageContent(pages));
  const payments=safe(normalizePaymentPlan,paymentPlan,'paymentPlan');add('paymentPlan',inspectPaymentPlan(payments,{merchantProfile:merchant}));
  let shipping=null;const pack=OFFER.packages[packageId];
  if(!pack)pending.push({code:'CONTENT_PACKAGE_REVIEW_REQUIRED',field:'packageId'});
  else {try{shipping=normalizeShippingPlan(pack.shipping,shippingPlan??{});add('shippingPlan',inspectShippingPlan(pack.shipping,shipping));}catch(error){pending.push({code:error.code??'SHIPPING_INVALID_OBJECT',field:`shippingPlan.${error.field??''}`});}}
  if(merchant.country!=='GR')pending.push({code:'CONTENT_COUNTRY_REVIEW_REQUIRED',field:'merchantProfile.country'});
  const declared=(value,label)=>typeof value==='string'&&value.trim()?value.trim():`[Προς συμπλήρωση: ${label}.]`;
  const name=declared(business?.name,'όνομα καταστήματος'),seller=declared(merchant.sellerName,'στοιχεία πωλητή'),email=declared(merchant.contactEmail,'email επικοινωνίας');
  if(typeof business?.name!=='string'||!business.name.trim())pending.push({code:'CONTENT_BUSINESS_NAME_REQUIRED',field:'business.name'});
  const story=pages.aboutStory||(typeof business?.activity==='string'?business.activity:'');
  if(!story.trim())pending.push({code:'CONTENT_ABOUT_REQUIRED',field:'pageContent.aboutStory'});
  const header='ΠΡΟΣΧΕΔΙΟ — Απαιτεί έλεγχο καταλληλότητας και νομικής εγκυρότητας από τον ιδιοκτήτη πριν από οποιαδήποτε δημοσίευση. Δεν αποτελεί νομική πιστοποίηση. Οι ρυθμίσεις του καταστήματος πρέπει να συμφωνούν με το τελικό κείμενο.';
  const contact=[`Πωλητής: ${seller}.`,`Email επικοινωνίας: ${email}.`,...(merchant.contactPhone?[`Τηλέφωνο: ${merchant.contactPhone}.`]:[]),...(pages.contactHours?[`Ωράριο επικοινωνίας: ${pages.contactHours}`]:[])].join('\n');
  const returnAddress=returns.returnAddressMode==='declared_store_address'?addressText({recipient:merchant.sellerName,country:merchant.country,...merchant.address}):returns.returnAddressMode==='different_address'?addressText(returns.returnAddress):'';
  const returnLines=[`Για δήλωση υπαναχώρησης ή επικοινωνία σχετικά με επιστροφή: ${email}.`,
    'Για καλυπτόμενες αγορές φυσικών αγαθών από καταναλωτές, η νόμιμη προθεσμία δήλωσης υπαναχώρησης είναι 14 ημέρες από την παραλαβή. Ο ακριβής χρόνος έναρξης σε τμηματικές παραδόσεις και οι ειδικές περιπτώσεις χρειάζονται έλεγχο.',
    `Δηλωμένη εμπορική επιλογή για την προθεσμία αιτήματος: ${windowText(returns.windowMode)??'[προς διευκρίνιση]'}.`,
    'Η αποστολή των αγαθών πίσω γίνεται, στη νόμιμη υπαναχώρηση, μέσα σε 14 ημέρες από τη δήλωση. Αυτή είναι χωριστή προθεσμία από την προθεσμία δήλωσης.',
    payerText(returns.returnShippingPayer)?`Το άμεσο κόστος επιστροφής λόγω αλλαγής γνώμης καλύπτει ${payerText(returns.returnShippingPayer)}. Επιβάρυνση του αγοραστή προϋποθέτει την απαιτούμενη ενημέρωσή του πριν από τη σύμβαση.`:'[Προς διευκρίνιση: ποιος καλύπτει τα μεταφορικά επιστροφής.]',
    returnAddress?`Δηλωμένος προορισμός επιστροφής: ${returnAddress}.`:'[Προς συμπλήρωση και επιβεβαίωση: προορισμός επιστροφής.]',
    'Για τη νόμιμη υπαναχώρηση, η επιστροφή χρημάτων γίνεται χωρίς αδικαιολόγητη καθυστέρηση, το αργότερο μέσα σε 14 ημέρες από την ενημέρωση του πωλητή. Για αγαθά μπορεί να αναμείνει μέχρι να τα παραλάβει ή να λάβει απόδειξη αποστολής τους, όποιο συμβεί πρώτο, όπου αυτό επιτρέπεται.',
    'Η επιστροφή γίνεται με το ίδιο μέσο πληρωμής, εκτός αν συμφωνηθεί ρητά διαφορετικό μέσο χωρίς έξοδα για τον καταναλωτή. Περιλαμβάνει τα συνήθη αρχικά έξοδα παράδοσης· τυχόν διαφορά για ακριβότερη επιλογή παράδοσης αντιμετωπίζεται χωριστά.',
    'Τα δικαιώματα για ελαττωματικό, λανθασμένο ή μη σύμφωνο προϊόν αντιμετωπίζονται χωριστά. Οι εμπορικές επιλογές μεταφορικών, αλλαγών και κατάστασης προϊόντος δεν περιορίζουν αυτά τα δικαιώματα.',
    'Ειδικά χαρακτηριστικά, όπως εξατομίκευση, αλλοίωση, σφράγιση για λόγους υγιεινής ή ψηφιακή παροχή, χρειάζονται ειδικό έλεγχο. Η κατηγορία προϊόντος από μόνη της δεν αποκλείει το δικαίωμα υπαναχώρησης.'
  ];
  if(returns.productCharacteristics.some(value=>value!=='ordinary_goods')){
    const labels={personalised_goods:'εξατομίκευση',perishable_goods:'προϊόντα που αλλοιώνονται',sealed_hygiene_goods:'σφραγισμένα προϊόντα για λόγους υγιεινής',digital_content:'ψηφιακό περιεχόμενο',other:'άλλα χαρακτηριστικά',unknown:'χαρακτηριστικά προς επιβεβαίωση'};
    returnLines.push(`Δηλωμένα χαρακτηριστικά προς αξιολόγηση: ${returns.productCharacteristics.map(value=>labels[value]??value).join(', ')}${returns.productCharacteristics.includes('other')&&returns.productCharacteristicsOther?` — ${returns.productCharacteristicsOther}`:''}. Δεν έχει επιβεβαιωθεί εξαίρεση. Για ψηφιακό περιεχόμενο δεν αρκεί μια αναφορά στους όρους για απώλεια δικαιώματος· πρέπει να συντρέχουν και να τεκμηριώνονται οι νόμιμες προϋποθέσεις.`);
  }
  for(const [field,other,label]of [['windowMode','windowOther','Προθεσμία επιστροφών'],['returnShippingPayer','returnShippingPayerOther','Κόστος επιστροφής'],['returnAddressMode','returnAddressOther','Προορισμός επιστροφής'],['offersExchanges','offersExchangesOther','Εμπορικές αλλαγές']])if(returns[field]==='other')returnLines.push(`Αίτημα προς διευκρίνιση — ${label}: ${field==='windowMode'&&returns.windowDays!==null?`${returns.windowDays} ημέρες, `:''}${returns[other]||'[να συμπληρωθεί η διευκρίνιση]'}. Δεν αποτελεί εγκεκριμένο κανόνα.`);
  if(returns.offersExchanges==='no')returnLines.push('Δεν προσφέρονται πρόσθετες προαιρετικές εμπορικές αλλαγές. Αυτό δεν περιορίζει τη νόμιμη υπαναχώρηση ή τα δικαιώματα σε περίπτωση προβλήματος του προϊόντος.');
  else if(returns.offersExchanges==='yes'){
    let exchangeWindow=returns.exchangeRequestWindowMode==='same_as_declared_returns'?windowText(returns.windowMode):returns.exchangeRequestWindowMode==='different_days_from_receipt'&&returns.exchangeRequestWindowDays!==null?`${returns.exchangeRequestWindowDays} ημέρες από την παραλαβή`:null;
    returnLines.push('Προαιρετικές εμπορικές αλλαγές',`Προθεσμία υποβολής αιτήματος αλλαγής: ${exchangeWindow??'[προς διευκρίνιση]'}.`,
      `Μεταφορικά επιστροφής προς το κατάστημα: ${payerText(returns.exchangeInboundShippingPayer)??'[προς διευκρίνιση]'}. Μεταφορικά νέου προϊόντος προς τον αγοραστή: ${payerText(returns.exchangeOutboundShippingPayer)??'[προς διευκρίνιση]'}.`,
      returns.exchangeProductScope==='same_product_size_or_colour'?'Η αλλαγή αφορά το ίδιο προϊόν σε άλλο διαθέσιμο μέγεθος ή χρώμα.':returns.exchangeProductScope==='also_different_store_product'?'Η αλλαγή μπορεί να αφορά και διαφορετικό διαθέσιμο προϊόν του καταστήματος.':'[Προς διευκρίνιση: προϊόντα που καλύπτει η προαιρετική αλλαγή.]',
      returns.exchangePriceDifference==='settle_difference'?'Για ακριβότερο νέο προϊόν καταβάλλεται η διαφορά, για φθηνότερο επιστρέφεται η διαφορά και για ίση αξία δεν προκύπτει διαφορά τιμής. Τα μεταφορικά υπολογίζονται χωριστά.':returns.exchangePriceDifference==='equal_value_only'?'Η προαιρετική αλλαγή γίνεται μόνο με προϊόν ίσης αξίας.':'[Προς διευκρίνιση: διαφορά τιμής κατά την προαιρετική αλλαγή.]',
      returns.exchangeItemCondition==='unused_labels_and_original_packaging_where_present'?'Για την προαιρετική αλλαγή το προϊόν πρέπει να είναι αχρησιμοποίητο, με τις ετικέτες και την αρχική συσκευασία όπου υπάρχουν.':returns.exchangeItemCondition==='unused_labels_where_present_no_original_packaging_required'?'Για την προαιρετική αλλαγή το προϊόν πρέπει να είναι αχρησιμοποίητο με τις ετικέτες όπου υπάρχουν, χωρίς απαίτηση αρχικής συσκευασίας.':'[Προς διευκρίνιση: κατάσταση προϊόντος μόνο για προαιρετική αλλαγή.]',
      'Το νέο προϊόν αποστέλλεται αφού το κατάστημα παραλάβει το αρχικό. Δεν καθορίζεται εδώ πρόσθετη προθεσμία αποστολής.');
    for(const [field,other,label]of [['exchangeInboundShippingPayer','exchangeInboundShippingPayerOther','κόστος επιστροφής για αλλαγή'],['exchangeOutboundShippingPayer','exchangeOutboundShippingPayerOther','κόστος νέας αποστολής'],['exchangeRequestWindowMode','exchangeRequestWindowOther','προθεσμία αιτήματος αλλαγής'],['exchangeProductScope','exchangeProductScopeOther','επιλέξιμα προϊόντα αλλαγής'],['exchangePriceDifference','exchangePriceDifferenceOther','διαφορά τιμής'],['exchangeItemCondition','exchangeItemConditionOther','κατάσταση προϊόντος']])if(returns[field]==='other')returnLines.push(`Αίτημα προς διευκρίνιση — ${label}: ${returns[other]||'[να συμπληρωθεί η διευκρίνιση]'}. Δεν αποτελεί εγκεκριμένο κανόνα.`);
  }else returnLines.push('[Προς διευκρίνιση: αν προσφέρονται προαιρετικές εμπορικές αλλαγές.]');
  returnLines.push('Η ηλεκτρονική λειτουργία υπαναχώρησης χρειάζεται χωριστή ρύθμιση και επαλήθευση πριν από καλυπτόμενες πωλήσεις. Το παρόν κείμενο και το email επικοινωνίας δεν αποδεικνύουν ότι η λειτουργία έχει υλοποιηθεί.');
  const practice=(key,label,detail)=>`${label}: ${policies[key]==='yes'?`δηλώθηκε χρήση. ${policies[detail]}`:policies[key]==='no'?'δηλώθηκε ότι δεν χρησιμοποιείται.':`[Προς επιβεβαίωση${policies[detail]?`: ${policies[detail]}`:''}.]`}`;
  const privacyContact=policies.privacyContactEmail||email;
  const privacy=[`Υπεύθυνος επεξεργασίας για το κατάστημα: ${seller}.`,`Επικοινωνία για προσωπικά δεδομένα: ${privacyContact}.`,
    'Το προσχέδιο καλύπτει τα στοιχεία που απαιτούνται για παραγγελίες, επικοινωνία και τις πραγματικές λειτουργίες που δηλώθηκαν παρακάτω. Πριν από δημοσίευση πρέπει να προσδιοριστούν για κάθε επεξεργασία τα συγκεκριμένα δεδομένα, ο σκοπός και η εφαρμοστέα νομική βάση.',
    `Δηλωμένοι πάροχοι και σχετικές υπηρεσίες: ${declared(policies.serviceProviders,'πάροχοι που λαμβάνουν ή επεξεργάζονται δεδομένα')}`,
    practice('analytics','Στατιστικά / analytics','analyticsDetails'),practice('marketing','Marketing / διαφημιστικές λειτουργίες','marketingDetails'),
    `Χρόνοι ή κριτήρια διατήρησης: ${declared(policies.retentionCriteria,'πραγματικοί χρόνοι ή κριτήρια διατήρησης')}`,
    `Cookies και συγκατάθεση — δήλωση πωλητή: ${policies.cookieConsent==='configured'?`υπάρχει ρύθμιση προς τεχνική επαλήθευση. ${policies.cookieConsentDetails}`:policies.cookieConsent==='not_configured'?'δεν έχει γίνει ρύθμιση.':'[προς επιβεβαίωση]'}. Η πολιτική δεν ενεργοποιεί μηχανισμό συγκατάθεσης ούτε αποδεικνύει αποκλεισμό μη αναγκαίων cookies ή pixels.`,
    practice('internationalTransfers','Διαβιβάσεις εκτός ΕΟΧ','internationalTransferDetails'),
    'Οι αναγκαίες εγγυήσεις διαβίβασης, οι ρόλοι των παρόχων και οι πραγματικές ροές δεδομένων του Shopify πρέπει να αντιστοιχιστούν στις ρυθμίσεις και συμβάσεις. Η δήλωση του πωλητή ότι δεν υπάρχουν διαβιβάσεις δεν βεβαιώνει ότι οι πάροχοι δεν επεξεργάζονται δεδομένα εκτός ΕΟΧ.',
    'Μπορείτε να ζητήσετε ενημέρωση και πρόσβαση, διόρθωση, διαγραφή, περιορισμό, εναντίωση ή φορητότητα, όπου προβλέπονται από τον GDPR. Όταν η επεξεργασία βασίζεται σε συγκατάθεση, μπορείτε να την ανακαλέσετε χωρίς να επηρεάζεται η προηγούμενη νόμιμη επεξεργασία. Έχετε δικαίωμα καταγγελίας στην Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα.',
    ...(policies.additionalPractices?[`Πρόσθετες δηλωμένες πρακτικές: ${policies.additionalPractices}`]:[])
  ];
  const shippingBody=shippingText(shipping),paymentBody=paymentText(payments);
  const faq=[{question:'Πώς μπορώ να επικοινωνήσω;',answer:`Στο ${email}${merchant.contactPhone?` ή στο ${merchant.contactPhone}`:''}.`},{question:'Πώς σχεδιάζεται να μπορώ να πληρώσω;',answer:paymentBody},{question:'Ποιες είναι οι χρεώσεις αποστολής;',answer:shippingBody},{question:'Πώς υποβάλλω αίτημα επιστροφής;',answer:`Επικοινώνησε στο ${email}. Δες την πολιτική επιστροφών για τις χωριστές προθεσμίες, τα μεταφορικά και τα δικαιώματά σου. Η ηλεκτρονική λειτουργία υπαναχώρησης χρειάζεται ακόμη επιβεβαίωση υλοποίησης.`},...pages.faqEntries.filter(item=>item.question||item.answer)];
  const documents=[
    {id:'terms',title:'Όροι χρήσης και αγορών',text:[header,`Κατάστημα: ${name}.`,contact,`Δηλωμένη διεύθυνση του πωλητή προς έλεγχο πριν δημοσίευση: ${addressText({country:merchant.country,...merchant.address})||'[προς συμπλήρωση]'}.`,
      'Το παρόν αποτελεί αρχικό προσχέδιο για αγορές φυσικών αγαθών. Η ολοκλήρωση σύμβασης, η επιβεβαίωση παραγγελίας, η παρουσίαση τιμών/φόρων και οι πραγματικές ρυθμίσεις checkout πρέπει να ελεγχθούν στο συγκεκριμένο κατάστημα πριν προστεθούν οι τελικοί όροι.',paymentBody,
      'Οι κανόνες αποστολής και επιστροφών περιγράφονται στα αντίστοιχα προσχέδια. Υποχρεωτικά δικαιώματα του καταναλωτή δεν περιορίζονται από εμπορικές επιλογές του καταστήματος.',
      'Δεν έχει επιβεβαιωθεί από αυτό το έγγραφο η ενεργοποίηση πληρωμών, η νόμιμη λειτουργία του εμπόρου ή η υλοποίηση της ηλεκτρονικής υπαναχώρησης.'].join('\n\n')},
    {id:'privacy',title:'Πολιτική απορρήτου',text:[header,...privacy].join('\n\n')},
    {id:'returns',title:'Επιστροφές και αλλαγές',text:[header,...returnLines].join('\n\n')},
    {id:'shipping',title:'Αποστολές και παράδοση',text:[header,shippingBody,'Οι παραπάνω κανόνες αποτυπώνουν δηλωμένες επιλογές. Η εμφάνισή τους στο πραγματικό checkout, οι χρόνοι, τα βάρη και οι διαθέσιμες περιοχές πρέπει να επαληθευτούν πριν δημοσίευση.'].join('\n\n')},
    {id:'about',title:'Σχετικά με εμάς',text:[header,name,declared(story,'περιγραφή δραστηριότητας ή ιστορία καταστήματος')].join('\n\n')},
    {id:'contact',title:'Επικοινωνία',text:[header,contact].join('\n\n')},
    {id:'faq',title:'Συχνές ερωτήσεις',text:[header,...faq.map(item=>`${item.question||'[ερώτηση προς συμπλήρωση]'}\n${item.answer||'[απάντηση προς συμπλήρωση]'}`)].join('\n\n')}
  ];
  const seen=new Set(),uniquePending=pending.filter(item=>{const key=`${item.code}:${item.field}`;if(seen.has(key))return false;seen.add(key);return true;});
  const publicVersion=preparePublicDocuments({merchant,returns,policies,pages,shipping,payments,business,publicationFacts,documents,inputPending:uniquePending,returnLines});
  return {templateVersion:STORE_CONTENT_TEMPLATE_VERSION,country:'GR',...publicVersion,pending:uniquePending,status:'draft_requires_merchant_review',legalCertification:false,publishable:false,
    warnings:[{code:'DRAFT_LEGAL_REVIEW_REQUIRED',text:'Η έγκριση αφορά το συγκεκριμένο προσχέδιο και τις δηλώσεις σου. Ο τελικός έλεγχος καταλληλότητας και νομικής εγκυρότητας παραμένει ευθύνη του ιδιοκτήτη.'},{code:'LEGAL_TEMPLATE_COMPLETENESS_REVIEW_REQUIRED',text:'Όροι και απόρρητο διαθέτουν αναλυτική βάση για φυσικά αγαθά. Απαιτείται επιβεβαίωση πραγματικών στοιχείων πωλητή, συμβατικής διαδικασίας, νομικών βάσεων και ρυθμίσεων. Τα στοιχεία που χρειάζονται επιβεβαίωση καταγράφονται χωριστά.'},{code:'NATIVE_SETTINGS_VERIFICATION_PENDING',text:'Πληρωμές, αποστολές, cookies και ηλεκτρονική υπαναχώρηση χρειάζονται πραγματική ρύθμιση και έλεγχο στο Shopify.'},{code:'WITHDRAWAL_SETUP_PENDING',text:pack?.withdrawalSetupIncluded?'Το πακέτο περιλαμβάνει τη μελλοντική ρύθμιση και τον έλεγχο ηλεκτρονικής υπαναχώρησης. Η λειτουργία δεν έχει ακόμη υλοποιηθεί.':'Η ρύθμιση ηλεκτρονικής υπαναχώρησης δεν περιλαμβάνεται στο Basic. Η ανάγκη συμμόρφωσης του καταστήματος παραμένει.'}],sources:STORE_PUBLICATION_SOURCES};
}

// A separate export for an authorized native adapter. It does not grant store
// ownership, deployment permission, payment activation or legal certification.
export function renderPublicStoreContent(input){
  const bundle=renderStoreContent(input);
  return {templateVersion:bundle.templateVersion,country:bundle.country,documents:bundle.documents.map(({id,title,publicText,publicHtml})=>({id,title,text:publicText,html:publicHtml})),publicationBlockers:bundle.publicationBlockers,publicContentComplete:bundle.publicContentComplete,
    status:'customer_copy_requires_store_verification',legalCertification:false,publishable:false,publicationAuthorized:false,sources:bundle.sources};
}
