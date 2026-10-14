// Private, merchant-authored onboarding. Readiness means the local brief is
// complete; it never verifies identity, legal status or Shopify activation.
const MERCHANT_KEYS=['schemaVersion','country','countryOther','businessType','businessTypeOther','sellerName','contactEmail','contactPhone','address'];
const PAYMENT_KEYS=['schemaVersion','online','manualMethods','additionalMethods','other','activationAcknowledged'];
const COUNTRIES=new Set(['GR','other']);
const BUSINESS_TYPES=new Set(['individual_or_sole_proprietor','company','partnership','other']);
const ONLINE=new Set(['shopify_payments','manual_only','other']);
const MANUAL=new Set(['bank_deposit','cash_on_delivery']);
const ADDITIONAL=new Set(['klarna','other']);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

export class MerchantPaymentsError extends Error {
  constructor(code,field,details={}) {super(code);this.name='MerchantPaymentsError';this.code=code;this.field=field;this.status=422;this.details={field,...details};}
}
const fail=(code,field,details)=>{throw new MerchantPaymentsError(code,field,details);};
function object(value,keys,field,prefix) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(`${prefix}_INVALID_OBJECT`,field);
  for(const key of Object.keys(value))if(!keys.includes(key))fail(`${prefix}_UNKNOWN_FIELD`,`${field}.${key}`);
}
function text(value,field,prefix,max=240,{multiline=false}={}) {
  if(value==null)return '';
  if(typeof value!=='string'||value.length>max||(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/:/[\x00-\x1f\x7f]/).test(value))fail(`${prefix}_INVALID_TEXT`,field);
  return value.trim();
}
function choice(value,options,field,prefix) {
  if(value==null)return null;
  if(!options.has(value))fail(`${prefix}_INVALID_CHOICE`,field);
  return value;
}
function methods(value,allowed,field) {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>allowed.size||value.some(id=>!allowed.has(id))||new Set(value).size!==value.length)fail('PAYMENT_INVALID_METHODS',field);
  return [...value];
}
function normalizeMerchant(input) {
  object(input,MERCHANT_KEYS,'merchantProfile','MERCHANT');
  if(input.schemaVersion!==undefined&&input.schemaVersion!==1)fail('MERCHANT_INVALID_VERSION','schemaVersion');
  const address=input.address===undefined?{}:input.address;
  object(address,['line1','line2','city','postalCode'],'address','MERCHANT');
  const result={schemaVersion:1,country:choice(input.country,COUNTRIES,'country','MERCHANT'),countryOther:text(input.countryOther,'countryOther','MERCHANT',120),
    businessType:choice(input.businessType,BUSINESS_TYPES,'businessType','MERCHANT'),businessTypeOther:text(input.businessTypeOther,'businessTypeOther','MERCHANT'),
    sellerName:text(input.sellerName,'sellerName','MERCHANT',200),contactEmail:text(input.contactEmail,'contactEmail','MERCHANT',254),contactPhone:text(input.contactPhone,'contactPhone','MERCHANT',60),
    address:{line1:text(address.line1,'address.line1','MERCHANT'),line2:text(address.line2,'address.line2','MERCHANT'),city:text(address.city,'address.city','MERCHANT',120),postalCode:text(address.postalCode,'address.postalCode','MERCHANT',32)}};
  return result;
}
function merchantReadiness(profile) {
  const pending=[];const need=field=>pending.push({code:'MERCHANT_FIELD_REQUIRED',field});
  for(const field of ['country','businessType','sellerName','contactEmail'])if(!profile[field])need(field);
  // Save can preserve an unfinished email. Only final submission requires a
  // usable address, while structural/type/length checks remain unconditional.
  if(profile.contactEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contactEmail))pending.push({code:'MERCHANT_INVALID_EMAIL',field:'contactEmail'});
  for(const field of ['line1','city','postalCode'])if(!profile.address[field])need(`address.${field}`);
  if(profile.country==='other'&&!profile.countryOther)need('countryOther');
  if(profile.businessType==='other'&&!profile.businessTypeOther)need('businessTypeOther');
  const requiresReview=profile.country==='other'||profile.businessType==='other';
  return {valid:true,ready:pending.length===0&&!requiresReview,requiresReview,pending,errors:[],nativeSetupStatus:'pending',merchantEligibility:'not_verified'};
}
export function normalizeMerchantProfile(input,{complete=false}={}) {
  const result=normalizeMerchant(input);
  if(complete){const state=merchantReadiness(result);if(state.requiresReview)fail('MERCHANT_REVIEW_REQUIRED',result.country==='other'?'country':'businessType');if(state.pending.length)fail('MERCHANT_INCOMPLETE',state.pending[0].field,{pending:state.pending});}
  return result;
}
export function inspectMerchantProfile(input) {
  try{return merchantReadiness(normalizeMerchant(input));}catch(error){if(!(error instanceof MerchantPaymentsError))throw error;return {valid:false,ready:false,requiresReview:false,pending:[],errors:[{code:error.code,field:error.field}],nativeSetupStatus:'pending',merchantEligibility:'not_verified'};}
}
function normalizePayment(input) {
  object(input,PAYMENT_KEYS,'paymentPlan','PAYMENT');
  if(input.schemaVersion!==undefined&&input.schemaVersion!==1)fail('PAYMENT_INVALID_VERSION','schemaVersion');
  if(input.activationAcknowledged!==undefined&&typeof input.activationAcknowledged!=='boolean')fail('PAYMENT_INVALID_CHOICE','activationAcknowledged');
  const result={schemaVersion:1,online:choice(input.online,ONLINE,'online','PAYMENT'),manualMethods:methods(input.manualMethods,MANUAL,'manualMethods'),additionalMethods:methods(input.additionalMethods,ADDITIONAL,'additionalMethods'),other:text(input.other,'other','PAYMENT',4000,{multiline:true}),activationAcknowledged:input.activationAcknowledged??false};
  // Inactive preferences are not silently promoted into the effective plan.
  if(result.additionalMethods.length&&result.online!=='shopify_payments')fail('PAYMENT_INVALID_COMBINATION','additionalMethods');
  return result;
}
function paymentReadiness(plan,merchantProfile) {
  const pending=[];const need=(field,code='PAYMENT_FIELD_REQUIRED')=>pending.push({code,field});
  if(plan.online===null)need('online');
  if(plan.online==='manual_only'&&!plan.manualMethods.length)need('manualMethods','PAYMENT_MANUAL_METHOD_REQUIRED');
  const other=plan.online==='other'||plan.additionalMethods.includes('other');
  if(other&&!plan.other)need('other');
  if(!plan.activationAcknowledged)need('activationAcknowledged','PAYMENT_ACKNOWLEDGEMENT_REQUIRED');
  const merchant=merchantProfile==null?null:inspectMerchantProfile(merchantProfile);
  if(!merchant?.ready)need('merchantProfile',merchant?.requiresReview?'MERCHANT_REVIEW_REQUIRED':'PAYMENT_MERCHANT_PROFILE_REQUIRED');
  const requiresReview=other||merchant?.requiresReview===true;
  return {valid:true,ready:pending.length===0&&!requiresReview,requiresReview,pending,errors:[],nativeSetupStatus:'pending',merchantEligibility:'not_verified',activationStatus:'owner_setup_pending'};
}
export function normalizePaymentPlan(input,{complete=false,merchantProfile}={}) {
  const result=normalizePayment(input);
  if(complete){const state=paymentReadiness(result,merchantProfile);if(state.requiresReview)fail('PAYMENT_REVIEW_REQUIRED',result.online==='other'?'online':result.additionalMethods.includes('other')?'additionalMethods':'merchantProfile');if(state.pending.length)fail('PAYMENT_INCOMPLETE',state.pending[0].field,{pending:state.pending});}
  return result;
}
export function inspectPaymentPlan(input,{merchantProfile}={}) {
  try{return paymentReadiness(normalizePayment(input),merchantProfile);}catch(error){if(!(error instanceof MerchantPaymentsError))throw error;return {valid:false,ready:false,requiresReview:false,pending:[],errors:[{code:error.code,field:error.field}],nativeSetupStatus:'pending',merchantEligibility:'not_verified',activationStatus:'owner_setup_pending'};}
}

// Guidance is not a store-specific registry or a marketing-country allowlist.
// Preferences remain conditional on Shopify, the buyer and enabled markets.
export const PAYMENT_GUIDANCE=freeze({
  schemaVersion:1,checkedOn:'2026-10-12',scope:'merchant_preferences_only',initialMerchantCountry:'GR',merchantEligibility:'not_verified',activationStatus:'owner_setup_pending',
  merchantCountryChoices:[{id:'GR',label:'Ελλάδα'},{id:'other',label:'Άλλη χώρα'}],
  businessTypeChoices:[{id:'individual_or_sole_proprietor',label:'Ιδιώτης ή ατομική επιχείρηση'},{id:'company',label:'Εταιρεία'},{id:'partnership',label:'ΟΕ / ΕΕ'},{id:'other',label:'Άλλο'}],
  onlineChoices:[{id:'shopify_payments',label:'Online πληρωμές με Shopify Payments'},{id:'manual_only',label:'Μόνο χειροκίνητες πληρωμές'},{id:'other',label:'Άλλο'}],
  manualMethods:[{id:'bank_deposit',label:'Τραπεζική κατάθεση'},{id:'cash_on_delivery',label:'Αντικαταβολή'}],
  additionalMethods:[{id:'klarna',label:'Klarna',conditional:true,ownerActionAfterHandoff:'Shopify approval and merchant tax identification displayed on storefront, contact and policy pages as required by the provider; no tax identifier is collected in this brief.'},{id:'other',label:'Άλλο',requiresReview:true}],
  greece:{cardBrands:['Visa','Mastercard','American Express','UnionPay'],acceleratedCheckouts:['Apple Pay','Google Pay','Shop Pay'],conditionalMethods:[
    {name:'Bancontact',buyerCountries:['BE']},{name:'iDEAL | Wero',buyerCountries:['NL'],minimumProcessedShopifyPaymentsOrders:100},
    {name:'BLIK',buyerCountries:['PL']},{name:'Przelewy24',buyerCountries:['PL']},{name:'Klarna',buyerCountriesInclude:['GR'],eligibility:'conditional'},
    {name:'MB WAY',buyerCountries:['PT']},{name:'MobilePay',buyerCountries:['DK','FI']},{name:'Satispay',buyerCountries:['IT']},{name:'TWINT',buyerCountries:['CH']}],actualStoreStatus:'not_verified'},
  sources:{requirements:'https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries/greece/requirements',
    methods:'https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries/greece/payment-methods',
    manual:'https://help.shopify.com/en/manual/payments/manual-payments',
    activation:'https://help.shopify.com/en/manual/payments/shopify-payments/onboarding/account-setup',
    storeDetails:'https://help.shopify.com/en/manual/your-account/manage-orgs-and-stores/manage-store-details'},
});
