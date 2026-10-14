import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// The offer is commercial data. Reading it never verifies a payment or activates sales.
export const SERVICE_OFFER_PATH = new URL('../../molyvi-contract/offer.v1.json', import.meta.url);
const offerBytes = readFileSync(SERVICE_OFFER_PATH);
const freeze = value => {if(value && typeof value === 'object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail = code => {const error = new Error(code);error.code = code;error.status = 422;throw error;};
export const SERVICE_OFFER = freeze(JSON.parse(offerBytes.toString('utf8')));
export const OFFER_HASH = createHash('sha256').update(offerBytes).digest('hex');
const aliases = Object.freeze({start:'basic',plus:'extended'});

export function resolvePackageId(id,{allowLegacyPackageId=false}={}) {
  const resolved = allowLegacyPackageId && Object.hasOwn(aliases,id) ? aliases[id] : id;
  if(!Object.hasOwn(SERVICE_OFFER.packages,resolved))fail('UNKNOWN_SERVICE_PACKAGE');
  return resolved;
}

function entitlementsFor(pack,{branding=false}={}) {
  return {
    // `products` remains the compatibility field for the one-visual-unit editor.
    products:pack.catalogUnitsIncluded,catalogUnits:pack.catalogUnitsIncluded,
    photoSlotsPerUnit:pack.photoSlotsPerUnit,photoSlots:pack.photoSlotsIncluded,
    aiTextVersionsPerField:SERVICE_OFFER.textPolicy.aiVersionsPerField,
    additionalPhotoRegenerationsPerSlot:SERVICE_OFFER.photoPolicy.additionalRegenerationsPerSlot,
    photoMixIds:[...pack.photoMixIds],branding,
    shipping:structuredClone(pack.shipping),blog:structuredClone(pack.blog),
    informationalPages:SERVICE_OFFER.sharedDeliverables.informationalPagesIncluded,
    withdrawalSetup:pack.withdrawalSetupIncluded,signatureRemoval:pack.molyviSignatureRemovalIncluded,
    credits:null,skuLimit:null,skuLimitStatus:'unresolved_not_unlimited',
  };
}

export function createOrderOfferSnapshot({packageId,branding=false,allowLegacyPackageId=false}) {
  if(typeof branding!=='boolean')fail('INVALID_BRANDING_ENTITLEMENT');
  const id=resolvePackageId(packageId,{allowLegacyPackageId}),pack=SERVICE_OFFER.packages[id];
  return {
    snapshotVersion:1,offerId:SERVICE_OFFER.id,offerHash:OFFER_HASH,packageId:id,
    packageName:pack.displayName??'Μεγαλύτερο πακέτο',currency:SERVICE_OFFER.currency,
    taxBasis:SERVICE_OFFER.taxBasis,netPriceMinor:pack.priceMinor,
    pricingStatus:SERVICE_OFFER.authority.priceStatus,commercialActivation:false,
    entitlements:entitlementsFor(pack,{branding}),
  };
}

// Trusted local-fixture helper only. A production payment adapter must provide
// independent verification; passing demo:false cannot manufacture a paid order.
export function createPaidOrder({id,packageId='basic',demo=true,status='verified_paid',branding=false,allowLegacyPackageId=false}) {
  if(typeof id!=='string'||!id||demo!==true||!['verified_paid','pending'].includes(status))fail('LOCAL_TEST_ORDER_REQUIRED');
  const offerSnapshot=createOrderOfferSnapshot({packageId,branding,allowLegacyPackageId});
  return {id,status,demo:true,paymentMode:'local_simulation',packageId:offerSnapshot.packageId,
    netPriceMinor:offerSnapshot.netPriceMinor,currency:offerSnapshot.currency,taxBasis:offerSnapshot.taxBasis,
    offerId:offerSnapshot.offerId,offerHash:offerSnapshot.offerHash,offerSnapshot,
    entitlements:structuredClone(offerSnapshot.entitlements)};
}

function validSnapshot(snapshot) {
  const ent=snapshot?.entitlements;
  if(snapshot?.snapshotVersion!==1||typeof snapshot.offerId!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.offerHash)||
    !['basic','extended'].includes(snapshot.packageId)||snapshot.currency!=='EUR'||snapshot.taxBasis!=='exclusive_vat'||
    !Number.isSafeInteger(snapshot.netPriceMinor)||snapshot.netPriceMinor<=0||!ent)fail('INVALID_ORDER_OFFER');
  for(const key of ['products','catalogUnits','photoSlotsPerUnit','photoSlots','aiTextVersionsPerField','additionalPhotoRegenerationsPerSlot']) {
    if(!Number.isSafeInteger(ent[key])||ent[key]<1)fail('INVALID_ORDER_OFFER');
  }
  if(ent.products!==ent.catalogUnits||ent.photoSlots!==ent.catalogUnits*ent.photoSlotsPerUnit)fail('INVALID_ORDER_OFFER');
}

export function packageForOrder(order) {
  if(order?.offerSnapshot) {
    const snapshot=order.offerSnapshot;validSnapshot(snapshot);
    // Historical snapshots use their own frozen values, never today's price.
    return freeze({id:snapshot.packageId,name:snapshot.packageName,netPriceMinor:snapshot.netPriceMinor,
      offerId:snapshot.offerId,offerHash:snapshot.offerHash,legacy:false,entitlements:structuredClone(snapshot.entitlements)});
  }
  // Existing v8 records predate the offer contract. Do not rewrite or reprice them.
  const products=order?.entitlements?.products===25?25:10,photoSlotsPerUnit=products===25?5:3;
  return freeze({id:products===25?'extended':'basic',name:null,netPriceMinor:null,offerId:null,offerHash:null,legacy:true,
    entitlements:{products,catalogUnits:products,photoSlotsPerUnit,photoSlots:products*photoSlotsPerUnit,
      aiTextVersionsPerField:5,additionalPhotoRegenerationsPerSlot:3,branding:order?.entitlements?.branding===true,
      credits:null,skuLimit:null,skuLimitStatus:'unresolved_not_unlimited'}});
}

export function publicOfferProjection() {
  return {offerId:SERVICE_OFFER.id,offerHash:OFFER_HASH,scopeVersion:`${SERVICE_OFFER.id}.runtime-1`,
    currency:SERVICE_OFFER.currency,taxBasis:SERVICE_OFFER.taxBasis,commercialActivation:false,
    packages:Object.fromEntries(Object.entries(SERVICE_OFFER.packages).map(([id,pack])=>[id,{
      id,name:pack.displayName??'Μεγαλύτερο πακέτο',netPriceEUR:pack.priceMinor/100,
      netPriceMinor:pack.priceMinor,productLimit:pack.catalogUnitsIncluded,
      commercialUnitLimit:pack.catalogUnitsIncluded,photoSlots:pack.photoSlotsIncluded,
      photoSlotsPerUnit:pack.photoSlotsPerUnit,skuLimit:null,skuLimitStatus:'unresolved_not_unlimited',
    }]))};
}

export function renderPublicOfferModule() {
  return '// Generated from molyvi-contract/offer.v1.json; checked before serving/building. No private data.\n'+
    'const deepFreeze=value=>{if(value&&typeof value===\'object\'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};\n'+
    `export const PUBLIC_OFFER=deepFreeze(${JSON.stringify(publicOfferProjection(),null,2)});\n`;
}

export function assertCurrentProjection(source=readFileSync(new URL('./service-offer-public.mjs',import.meta.url),'utf8')) {
  if(source!==renderPublicOfferModule())fail('PUBLIC_OFFER_PROJECTION_STALE');
  return true;
}
