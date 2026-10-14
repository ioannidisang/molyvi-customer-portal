import {validateSchema} from './schema-validation.mjs';
import {inspectShippingPlan} from './shipping.mjs';
import {inspectMerchantProfile,inspectPaymentPlan} from './merchant-payments.mjs';
import {inspectReturnsPlan,inspectPolicyInputs,inspectPageContent} from './store-content.mjs';

export function assertOffer(offer) {
  if (offer.schemaVersion !== '1.0.0' || offer.id !== 'molyvi-offer-20261012') throw new Error('Unknown offer version');
  if (offer.currency !== 'EUR' || offer.taxBasis !== 'exclusive_vat' || offer.commercialActivation !== false) throw new Error('Preparation offer must remain inactive and net EUR');
  for (const id of ['basic', 'extended']) {
    const pack = offer.packages?.[id];
    if (!pack || pack.id !== id) throw new Error(`Missing package: ${id}`);
    for (const key of ['priceMinor', 'catalogUnitsIncluded', 'photoSlotsPerUnit', 'photoSlotsIncluded']) {
      if (!Number.isSafeInteger(pack[key]) || pack[key] <= 0) throw new Error(`Invalid package field: ${id}.${key}`);
    }
    if (pack.catalogUnitsIncluded * pack.photoSlotsPerUnit !== pack.photoSlotsIncluded) throw new Error('Photo allowance arithmetic mismatch');
    if (!Array.isArray(pack.photoMixIds) || !pack.photoMixIds.length) throw new Error('Photo mix missing');
  }
  if (offer.photoPolicy?.additionalRegenerationsPerSlot !== 3 || offer.photoPolicy?.maxVersionsPerSlot !== 4) throw new Error('Photo policy mismatch');
  if (offer.textPolicy?.aiVersionsPerField !== 5) throw new Error('Text policy mismatch');
  return offer;
}

export function inspectProject(project, schema, offer) {
  assertOffer(offer);
  const errors = validateSchema(project, schema).map(message => ({code: 'SCHEMA', message}));
  const pending = [];
  if (errors.length) return {valid: false, errors, pending, summary: null};
  const fail = (code, message) => errors.push({code, message});
  const wait = (code, subject) => pending.push({code, subject});
  function checkReferences(value, at = '$') {
    if (typeof value === 'string' && /^(briefs|customer-materials)\//.test(value)) {
      const parts = value.split('/');
      if (parts.some(part => !part || part === '.' || part === '..') || /[\\:%\x00-\x1f]/.test(value)) fail('PRIVATE_REFERENCE', `Unsafe private reference at ${at}`);
    } else if (typeof value === 'string' && value.startsWith('https://')) {
      try {
        const url = new URL(value);
        if (url.username || url.password) fail('URL_CREDENTIALS', `Credentials are not allowed in evidence URLs at ${at}`);
      } catch { fail('INVALID_URL', `Invalid HTTPS reference at ${at}`); }
    }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) checkReferences(child, `${at}.${key}`);
  }
  checkReferences(project);
  const pack = offer.packages[project.packageId];
  if (project.offerId !== offer.id) fail('OFFER_VERSION', 'Project references a different offer');
  if (project.payment.basePriceMinorExVat !== pack.priceMinor) fail('PRICE', 'Construction price must match the referenced offer');
  if (!pack.photoMixIds.includes(project.photos.mix)) fail('PHOTO_MIX', 'The mix does not belong to this package');
  if (project.payment.status === 'test_verified' && !project.payment.testEvidenceRef) fail('PAYMENT_EVIDENCE', 'A test payment declaration needs an evidence reference');
  if (project.payment.status !== 'test_verified') wait('TEST_PAYMENT_NOT_EXECUTED', 'payment');
  // A reference is not independent verification. The future payment adapter must
  // verify the event; this offline tool neither grants rights nor starts work.
  const seen = new Map();
  const remember = (kind, id) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) fail('DUPLICATE_ID', `Duplicate ${kind} identifier: ${id}`);
    seen.set(key, true);
  };
  const assets = new Map();
  for (const asset of project.assets) {
    remember('asset', asset.id);
    assets.set(asset.id, asset);
  }
  const usedAssets = new Set();
  if (project.brand.logoMode === 'existing') {
    const logo = assets.get(project.brand.logoAssetId);
    if (!logo) wait('LOGO_ASSET_PENDING', 'brand');
    else if (logo.kind !== 'logo') fail('LOGO_KIND', 'An existing logo must reference a logo asset');
    else usedAssets.add(logo.id);
  }
  if (project.operations?.withdrawalSetup === 'included_in_extended' && project.packageId !== 'extended') fail('PACKAGE_FEATURE', 'Withdrawal setup is not included in Basic');
  let variants = 0;
  let units = 0;
  const sourceOwners = new Map();
  const skus = new Set();
  for (const product of project.products) {
    remember('product', product.id);
    for (const field of ['title', 'description', 'category']) if (!product[field].trim()) wait('PRODUCT_VALUE_PENDING', `${product.id}.${field}`);
    if (!product.variants.length) wait('PRODUCT_VARIANTS_PENDING', product.id);
    const localVariants = new Map();
    const assigned = new Set();
    for (const variant of product.variants) {
      remember('variant', variant.id);
      variants++;
      localVariants.set(variant.id, variant);
      if (variant.sku !== null) {
        const sku = variant.sku.trim();
        if (!sku) wait('SKU_PENDING', variant.id);
        if (skus.has(sku)) fail('DUPLICATE_SKU', `Duplicate project SKU: ${sku}`);
        skus.add(sku);
      } else wait('SKU_PENDING', variant.id);
      for (const field of ['priceMinor', 'stock', 'weightGrams']) if (variant[field] === null) wait('VARIANT_VALUE_PENDING', `${variant.id}.${field}`);
    }
    for (const unit of product.visualUnits) {
      remember('visual_unit', unit.id);
      units++;
      if (!unit.variantIds.length) wait('UNIT_VARIANTS_PENDING', unit.id);
      for (const variantId of unit.variantIds) {
        const variant = localVariants.get(variantId);
        if (!variant) fail('VARIANT_REFERENCE', `Unit ${unit.id} must reference variants of its own product`);
        else {
          if (assigned.has(variantId)) fail('DOUBLE_UNIT_ASSIGNMENT', `Variant ${variantId} cannot consume two units without an explicit separate representation model`);
          assigned.add(variantId);
          const normalize = value => typeof value === 'string' ? value.trim().toLocaleLowerCase('el') : value;
          if (normalize(variant.color) !== normalize(unit.color)) fail('COLOR_UNIT', `Variant ${variantId} requires the matching color unit`);
        }
      }
      if (!unit.sourceAssetIds.length) wait('SOURCE_ASSET_PENDING', unit.id);
      for (const assetId of unit.sourceAssetIds) {
        usedAssets.add(assetId);
        const owner = sourceOwners.get(assetId);
        if (owner && owner !== product.id) wait('CROSS_PRODUCT_SOURCE_REVIEW', assetId);
        else sourceOwners.set(assetId, product.id);
        if (!assets.has(assetId)) fail('ASSET_REFERENCE', `Unknown asset ${assetId} in ${unit.id}`);
        else if (assets.get(assetId).kind !== 'source_image') fail('SOURCE_KIND', `Asset ${assetId} must be a source image`);
      }
    }
    for (const variant of product.variants) if (!assigned.has(variant.id)) fail('UNASSIGNED_VARIANT', `Variant ${variant.id} has no visual unit`);
  }
  if (units > pack.catalogUnitsIncluded) fail('PACKAGE_UNITS', 'Commercial product-work units exceed the package allowance');
  if (!project.products.length) wait('CATALOG_PENDING', 'products');
  if(project.operations?.shippingPlan){
    const shipping=inspectShippingPlan(pack.shipping,project.operations.shippingPlan);
    for(const issue of shipping.errors)fail(issue.code,issue.field);
    for(const issue of shipping.pending)wait(issue.code,issue.field);
    if(shipping.requiresReview)wait('SHIPPING_REVIEW_REQUIRED','operations.shippingPlan');
    wait('SHIPPING_NATIVE_APPLICATION_PENDING','operations.shippingPlan');
  }else if (!project.operations?.shippingPlanRef) wait('SHIPPING_PLAN_PENDING', 'operations');
  if (!project.operations?.legalInputsRef&&!project.content?.policyInputs) wait('LEGAL_INPUTS_PENDING', 'operations');
  for(const [value,inspect,subject] of [[project.operations?.returnsPlan,input=>inspectReturnsPlan(input,{merchantProfile:project.business?.merchantProfile}),'operations.returnsPlan'],[project.content?.policyInputs,inspectPolicyInputs,'content.policyInputs'],[project.content?.pageContent,inspectPageContent,'content.pageContent']]){
    if(!value){wait('STORE_CONTENT_INPUTS_PENDING',subject);continue;}
    const result=inspect(value);for(const issue of result.errors)fail(issue.code,issue.field);for(const issue of result.pending)wait(issue.code,issue.field);
    if(result.requiresReview)wait('STORE_CONTENT_REVIEW_REQUIRED',subject);
  }
  if(project.content?.reviewStatus!=='test_recorded'||!project.content?.reviewBundleHash)wait('STORE_CONTENT_MERCHANT_REVIEW_PENDING','content');
  wait('STORE_CONTENT_NATIVE_APPLICATION_PENDING','content');
  wait('WITHDRAWAL_RUNTIME_PENDING','operations');
  if(project.business?.merchantProfile){
    const merchant=inspectMerchantProfile(project.business.merchantProfile);
    for(const issue of merchant.errors)fail(issue.code,issue.field);
    for(const issue of merchant.pending)wait(issue.code,issue.field);
    if(merchant.requiresReview)wait('MERCHANT_REVIEW_REQUIRED','business.merchantProfile');
    wait('MERCHANT_DETAILS_NATIVE_APPLICATION_PENDING','business.merchantProfile');
  }else if(!project.business?.merchantDetailsRef)wait('MERCHANT_DETAILS_PENDING','business');
  if(project.operations?.paymentPlan){
    const payments=inspectPaymentPlan(project.operations.paymentPlan,{merchantProfile:project.business?.merchantProfile});
    for(const issue of payments.errors)fail(issue.code,issue.field);
    for(const issue of payments.pending)wait(issue.code,issue.field);
    if(payments.requiresReview)wait('PAYMENT_REVIEW_REQUIRED','operations.paymentPlan');
    wait('PAYMENTS_OWNER_ACTIVATION_PENDING','operations.paymentPlan');
  }else wait('PAYMENT_PREFERENCES_PENDING','operations');
  for (const id of usedAssets) {
    const asset = assets.get(id);
    if (!asset) continue;
    if (asset.availability !== 'available') wait('SOURCE_ASSET_PENDING', id);
    if (asset.license.status !== 'verified') wait('ASSET_LICENSE_PENDING', id);
    if (!asset.ref || !asset.sha256) wait('ASSET_BYTES_UNVERIFIED', id);
  }
  return {
    valid: errors.length === 0, errors, pending,
    summary: {
      packageId: project.packageId, basePriceMinorExVat: pack.priceMinor,
      catalogEntries: project.products.length, skuCount: variants,
      commercialProductWorkUnits: units, includedCommercialUnits: pack.catalogUnitsIncluded,
      initialPhotoSlots: units * pack.photoSlotsPerUnit,
      packagePhotoSlots: pack.photoSlotsIncluded,
      maximumRequestedRegenerations: units * pack.photoSlotsPerUnit * offer.photoPolicy.additionalRegenerationsPerSlot,
      maximumImageOutputs: units * pack.photoSlotsPerUnit * offer.photoPolicy.maxVersionsPerSlot,
      aiTextVersionsPerField: offer.textPolicy.aiVersionsPerField,
      includedWalletCredits: null,
      walletNote: 'Construction entitlements are not an invented credit grant.',
      usedSourceAssets: usedAssets.size,
      skuLimit: null,
      skuLimitStatus: 'UNRESOLVED_COMMERCIAL_LIMIT_NOT_UNLIMITED',
    },
  };
}
