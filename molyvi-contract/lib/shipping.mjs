// Local merchant-authored shipping rules. This module neither configures Shopify
// nor establishes which destinations a merchant's live checkout supports.
const CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';
const regionNames = new Intl.DisplayNames(['el'], {type:'region'});
export const SHIPPING_COUNTRIES = Object.freeze([...new Set(CODES.split(' '))].sort().map(code => Object.freeze({code,name:regionNames.of(code) ?? code})));
const COUNTRIES = new Set(SHIPPING_COUNTRIES.map(({code}) => code));
const MODES = new Set(['flat','free_from_amount','always_free','weight_increment','other']);
const INCREMENTS = new Set(['complete_interval','started_interval']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const PLAN_KEYS = ['schemaVersion','currency','packageWeightGrams','zones','preparationTime','transitTime','pickupRequested'];
const ZONE_KEYS = ['id','label','countries','mode','basePriceMinor','initialWeightGrams','incrementWeightGrams','incrementPriceMinor','incrementMode','freeFromAmountMinor','freeMaxWeightGrams','other'];
const NUMERIC_ZONE_KEYS = ['basePriceMinor','initialWeightGrams','incrementWeightGrams','incrementPriceMinor','freeFromAmountMinor','freeMaxWeightGrams'];
const WEIGHT_KEYS = ['initialWeightGrams','incrementWeightGrams','incrementPriceMinor','incrementMode'];

export class ShippingPlanError extends Error {
  constructor(code,field,details={}) { super(code);this.name='ShippingPlanError';this.code=code;this.field=field;this.status=422;this.details={field,...details}; }
}
const fail = (code,field,details) => {throw new ShippingPlanError(code,field,details);};
function object(value,keys,field) {
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('SHIPPING_INVALID_OBJECT',field);
  for(const key of Object.keys(value))if(!keys.includes(key))fail('SHIPPING_UNKNOWN_FIELD',`${field}.${key}`);
}
function integer(value,field,{positive=false}={}) {
  if(value==null)return null;
  if(!Number.isSafeInteger(value)||value<(positive?1:0))fail('SHIPPING_INVALID_INTEGER',field);
  return value;
}
function string(value,field,max=120) {
  if(value==null)return '';
  if(typeof value!=='string'||value.length>max)fail('SHIPPING_INVALID_TEXT',field);
  return value.trim();
}
function choice(value,values,field) {
  if(value==null)return null;
  if(!values.has(value))fail('SHIPPING_INVALID_CHOICE',field);
  return value;
}
function country(value,field) {
  if(typeof value!=='string'||!COUNTRIES.has(value))fail('SHIPPING_INVALID_COUNTRY',field);
  return value;
}
function checkedPolicy(policy) {
  if(!policy||!Number.isSafeInteger(policy.destinationZoneCountMax)||policy.destinationZoneCountMax<1||policy.destinationZoneCountMax>3||
    !(policy.destinationCountryCount===null||Number.isSafeInteger(policy.destinationCountryCount)&&policy.destinationCountryCount>0)||
    !Array.isArray(policy.modes)||policy.modes.some(mode=>!MODES.has(mode)||mode==='other')||
    typeof policy.weightIncrementIncluded!=='boolean'||typeof policy.freeShippingWeightCapIncluded!=='boolean')fail('SHIPPING_OFFER_REVIEW_REQUIRED','policy');
  return policy;
}
function timing(input,field) {
  if(input==null)return null;
  object(input,['minDays','maxDays','dayType'],field);
  const result={minDays:integer(input.minDays,`${field}.minDays`),maxDays:integer(input.maxDays,`${field}.maxDays`),dayType:choice(input.dayType,new Set(['business','calendar']),`${field}.dayType`)};
  if(result.minDays!==null&&result.maxDays!==null&&result.minDays>result.maxDays)fail('SHIPPING_INVALID_TIME_RANGE',field);
  return result;
}
const activeZone = zone => zone.label!==''||zone.countries.length>0||zone.mode!==null||zone.other!==''||NUMERIC_ZONE_KEYS.some(key=>zone[key]!==null)||zone.incrementMode!==null;
function normalize(policy,input) {
  checkedPolicy(policy);object(input,PLAN_KEYS,'shippingPlan');
  if(input.schemaVersion!==undefined&&input.schemaVersion!==1)fail('SHIPPING_INVALID_VERSION','schemaVersion');
  if(input.currency!==undefined&&input.currency!=='EUR')fail('SHIPPING_UNSUPPORTED_CURRENCY','currency');
  if(input.pickupRequested!=null&&typeof input.pickupRequested!=='boolean')fail('SHIPPING_INVALID_CHOICE','pickupRequested');
  const zones=input.zones??[];
  // Technical payload cap only; package limits count nonempty zones below.
  if(!Array.isArray(zones)||zones.length>20)fail('SHIPPING_INVALID_ZONES','zones');
  const ids=new Set(),destinations=new Set();
  const result={schemaVersion:1,currency:'EUR',packageWeightGrams:integer(input.packageWeightGrams,'packageWeightGrams'),zones:zones.map((zone,index)=>{
    const field=`zones[${index}]`;object(zone,ZONE_KEYS,field);
    if(typeof zone.id!=='string'||!UUID.test(zone.id)||ids.has(zone.id))fail('SHIPPING_INVALID_ZONE_ID',`${field}.id`);
    ids.add(zone.id);
    if(!Array.isArray(zone.countries??[])||(zone.countries??[]).length>SHIPPING_COUNTRIES.length)fail('SHIPPING_INVALID_COUNTRIES',`${field}.countries`);
    const out={id:zone.id,label:string(zone.label,`${field}.label`),countries:(zone.countries??[]).map((code,n)=>{
      country(code,`${field}.countries[${n}]`);
      if(destinations.has(code))fail('SHIPPING_COUNTRY_OVERLAP',`${field}.countries`,{country:code});
      destinations.add(code);return code;
    }),mode:choice(zone.mode,MODES,`${field}.mode`)};
    for(const key of NUMERIC_ZONE_KEYS)out[key]=integer(zone[key],`${field}.${key}`,{positive:key==='incrementWeightGrams'});
    out.incrementMode=choice(zone.incrementMode,INCREMENTS,`${field}.incrementMode`);
    out.other=string(zone.other,`${field}.other`,4000);
    if(out.mode!==null&&out.mode!=='other'&&!policy.modes.includes(out.mode))fail('SHIPPING_ENTITLEMENT_REQUIRED',`${field}.mode`);
    if(!policy.weightIncrementIncluded&&WEIGHT_KEYS.some(key=>out[key]!==null))fail('SHIPPING_ENTITLEMENT_REQUIRED',field,{feature:'weight_increment'});
    if(!policy.freeShippingWeightCapIncluded&&out.freeMaxWeightGrams!==null)fail('SHIPPING_ENTITLEMENT_REQUIRED',`${field}.freeMaxWeightGrams`);
    return out;
  }),preparationTime:timing(input.preparationTime,'preparationTime'),transitTime:timing(input.transitTime,'transitTime'),pickupRequested:input.pickupRequested??null};
  if(result.zones.filter(activeZone).length>policy.destinationZoneCountMax)fail('SHIPPING_ZONE_LIMIT','zones');
  if(policy.destinationCountryCount!==null&&destinations.size>policy.destinationCountryCount)fail('SHIPPING_COUNTRY_LIMIT','zones');
  return result;
}
function readiness(plan) {
  const pending=[];let requiresReview=false;
  const need=(field,code='SHIPPING_FIELD_REQUIRED')=>pending.push({code,field});
  if(!plan.zones.some(activeZone))need('zones','SHIPPING_DESTINATION_REQUIRED');
  plan.zones.forEach((zone,index)=>{
    if(!activeZone(zone))return;
    const path=`zones[${index}]`;
    if(!zone.countries.length)need(`${path}.countries`,'SHIPPING_DESTINATION_REQUIRED');
    if(zone.mode===null)need(`${path}.mode`);
    if(zone.mode==='other') {requiresReview=true;if(!zone.other)need(`${path}.other`);return;}
    if(['flat','free_from_amount','weight_increment'].includes(zone.mode)&&zone.basePriceMinor===null)need(`${path}.basePriceMinor`);
    if(zone.mode==='free_from_amount'&&zone.freeFromAmountMinor===null)need(`${path}.freeFromAmountMinor`);
    if(zone.mode==='weight_increment')for(const key of WEIGHT_KEYS)if(zone[key]===null)need(`${path}.${key}`);
    // A cap is meaningful only for a threshold offer; never a hidden limit on
    // an always-free or flat rule. Preserve draft values, require correction.
    if(zone.freeMaxWeightGrams!==null&&(!['free_from_amount','weight_increment'].includes(zone.mode)||zone.freeFromAmountMinor===null))need(`${path}.freeMaxWeightGrams`,'SHIPPING_CAP_REQUIRES_THRESHOLD');
    if((zone.mode==='weight_increment'||zone.freeMaxWeightGrams!==null)&&plan.packageWeightGrams===null)need('packageWeightGrams');
  });
  for(const key of ['preparationTime','transitTime'])if(plan[key]!==null&&Object.values(plan[key]).some(value=>value!==null)) {
    for(const prop of ['minDays','maxDays','dayType'])if(plan[key][prop]===null)need(`${key}.${prop}`);
  }
  return {valid:true,ready:pending.length===0&&!requiresReview,requiresReview,pending,errors:[],nativeSetupStatus:'pending'};
}
export function normalizeShippingPlan(policy,input,{complete=false}={}) {
  const plan=normalize(policy,input);
  if(complete){const check=readiness(plan);if(check.requiresReview)fail('SHIPPING_REVIEW_REQUIRED','zones');if(check.pending.length)fail('SHIPPING_INCOMPLETE',check.pending[0].field,{pending:check.pending});}
  return plan;
}
export function inspectShippingPlan(policy,input) {
  try{return readiness(normalize(policy,input));}catch(error){if(!(error instanceof ShippingPlanError))throw error;return {valid:false,ready:false,requiresReview:false,pending:[],errors:[{code:error.code,field:error.field}],nativeSetupStatus:'pending'};}
}

// Exact decimal UI conversion. API plans themselves always use integer units.
function parseDecimal(value,digits,field) {
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string')fail('SHIPPING_INVALID_DECIMAL',field);
  const text=value.trim();if(!text)return null;
  if(!new RegExp(`^\\d+(?:[.,]\\d{1,${digits}})?$`).test(text))fail('SHIPPING_INVALID_DECIMAL',field);
  const [whole,fraction='']=text.replace(',','.').split('.');
  if(whole.length>16)fail('SHIPPING_NUMERIC_LIMIT',field);
  const parsed=BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0'));
  if(parsed>MAX)fail('SHIPPING_NUMERIC_LIMIT',field);return Number(parsed);
}
export const parseMoneyMinor = value => parseDecimal(value,2,'money');
export const parseKilogramsToGrams = value => parseDecimal(value,3,'weight');

export function estimateShipping(policy,input,scenario) {
  const result={status:null,amountMinor:null,currency:'EUR',zoneId:null,reason:null,missing:[],totalWeightGrams:null,breakdown:null,localEstimateOnly:true,shopifyConfigured:false};
  const stop=(status,reason,extra={})=>({...result,status,reason,...extra});
  let plan,request;
  try{plan=normalize(policy,input);}catch(error){if(!(error instanceof ShippingPlanError))throw error;return stop('invalid_plan',error.code);}
  try{
    object(scenario,['country','currency','subtotalMinor','itemsWeightGrams'],'scenario');
    if(scenario.currency!=='EUR')fail('SHIPPING_UNSUPPORTED_CURRENCY','scenario.currency');
    request={country:country(scenario.country,'scenario.country'),subtotalMinor:integer(scenario.subtotalMinor,'scenario.subtotalMinor'),itemsWeightGrams:integer(scenario.itemsWeightGrams,'scenario.itemsWeightGrams')};
  }catch(error){if(!(error instanceof ShippingPlanError))throw error;return stop('invalid_request',error.code);}
  const index=plan.zones.findIndex(zone=>zone.countries.includes(request.country));
  if(index<0)return stop('uncovered_destination','SHIPPING_DESTINATION_UNCOVERED');
  const zone=plan.zones[index];result.zoneId=zone.id;
  if(zone.mode==='other')return stop('review_required','SHIPPING_REVIEW_REQUIRED');
  const pending=readiness(plan).pending.filter(({field})=>field.startsWith(`zones[${index}]`)&&!field.endsWith('.countries'));
  if(pending.length)return stop('incomplete',pending[0].code,{missing:pending.map(({field})=>field)});
  if(zone.mode===null)return stop('incomplete','SHIPPING_FIELD_REQUIRED',{missing:[`zones[${index}].mode`]});
  const quote=(amountMinor,extra={})=>stop('quoted',null,{amountMinor,breakdown:{basePriceMinor:zone.basePriceMinor??0,incrementCount:0,incrementPriceMinor:0,excessWeightGrams:0,freeApplied:false,...extra}});
  if(zone.mode==='always_free')return quote(0,{basePriceMinor:0,freeApplied:true});
  if(zone.mode==='flat')return quote(zone.basePriceMinor);
  const threshold=zone.freeFromAmountMinor;
  if(threshold!==null&&request.subtotalMinor===null)return stop('incomplete','SHIPPING_SUBTOTAL_REQUIRED',{missing:['subtotalMinor']});
  const qualifies=threshold!==null&&request.subtotalMinor>=threshold;
  if(qualifies&&zone.freeMaxWeightGrams===null)return quote(0,{freeApplied:true});
  const weightNeeded=zone.mode==='weight_increment'||qualifies&&zone.freeMaxWeightGrams!==null;
  if(weightNeeded){
    const missing=[];if(request.itemsWeightGrams===null)missing.push('itemsWeightGrams');if(plan.packageWeightGrams===null)missing.push('packageWeightGrams');
    if(missing.length)return stop('missing_weight','SHIPPING_WEIGHT_REQUIRED',{missing});
    const sum=BigInt(request.itemsWeightGrams)+BigInt(plan.packageWeightGrams);
    if(sum>MAX)return stop('calculation_limit','SHIPPING_NUMERIC_LIMIT');result.totalWeightGrams=Number(sum);
  }
  if(qualifies&&result.totalWeightGrams<=zone.freeMaxWeightGrams)return quote(0,{freeApplied:true});
  if(zone.mode==='free_from_amount')return quote(zone.basePriceMinor);
  const excess=result.totalWeightGrams>zone.initialWeightGrams?BigInt(result.totalWeightGrams)-BigInt(zone.initialWeightGrams):0n;
  const step=BigInt(zone.incrementWeightGrams);
  const count=zone.incrementMode==='complete_interval'?excess/step:(excess+step-1n)/step;
  const amount=BigInt(zone.basePriceMinor)+count*BigInt(zone.incrementPriceMinor);
  if(amount>MAX)return stop('calculation_limit','SHIPPING_NUMERIC_LIMIT');
  return quote(Number(amount),{incrementCount:Number(count),incrementPriceMinor:zone.incrementPriceMinor,excessWeightGrams:Number(excess)});
}
