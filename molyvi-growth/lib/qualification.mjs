// Shared deterministic scope rules. No Node APIs, network calls, or client pricing trust.
import {PUBLIC_OFFER} from './service-offer-public.mjs';
export const SCOPE_VERSION = PUBLIC_OFFER.scopeVersion;
export const PACKAGES = PUBLIC_OFFER.packages;

export const QUALIFICATION_FIELDS = Object.freeze([
  'stage', 'kind', 'productCount', 'sellableSkuCount', 'language', 'variants',
  'catalog', 'brandAssets', 'integrations', 'market', 'currency', 'targetDate',
]);

const choices = Object.freeze({
  stage: ['new', 'existing'], kind: ['physical', 'digital', 'mixed'],
  language: ['el', 'en', 'multi'], variants: ['none', 'simple', 'complex'],
  catalog: ['ready', 'partial', 'missing'], brandAssets: ['ready', 'partial', 'missing'],
  integrations: ['none', 'required', 'unknown'], market: ['gr', 'other'],
  currency: ['EUR', 'other'], targetDate: ['flexible', 'urgent'],
});

const gateLabels = Object.freeze({
  catalog_ready: 'Πλήρης κατάλογος με τιμές, παραλλαγές και εικόνες',
  brand_assets_ready: 'Εγκεκριμένο λογότυπο και φωτογραφίες',
  full_brief_complete: 'Πλήρες και ελεγμένο brief',
  scope_accepted: 'Επιβεβαιωμένο scope και προσφορά',
  budget_verified: 'Επαληθευμένο κόστος παραγωγής',
  capacity_reserved: 'Διαθέσιμη θέση παραγωγής',
  payment_verified: 'Επιβεβαιωμένη συμφωνημένη πληρωμή',
  store_authorized: 'Εξουσιοδότηση στο σωστό κατάστημα',
  test_mode_verified: 'Επαληθευμένη δοκιμαστική λειτουργία πληρωμών',
  qa_passed: 'Έλεγχοι του συγκεκριμένου παραδοτέου',
  launch_authorized: 'Έγκριση πριν από δημοσίευση',
});

export function evaluateQualification(input) {
  const q = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const missing = [];
  for (const key of QUALIFICATION_FIELDS) {
    if (key === 'productCount' || key === 'sellableSkuCount') {
      if (q[key] !== 'unknown' && (!Number.isSafeInteger(q[key]) || q[key] < 1 || q[key] > 100000)) missing.push(key);
    } else if (!choices[key].includes(q[key])) missing.push(key);
  }
  const reasons = [];
  const add = (code, label) => reasons.push({code, label});
  const gates = Object.entries(gateLabels).map(([code, label]) => ({
    code, label,
    status: code === 'catalog_ready' && q.catalog === 'ready' || code === 'brand_assets_ready' && q.brandAssets === 'ready'
      ? 'passed' : 'pending',
  }));
  if (missing.length) return {status: 'incomplete', packageId: null, netPriceEUR: null, reasons, missing, gates, scope: null};
  if (q.productCount === 'unknown' || q.sellableSkuCount === 'unknown') add('CATALOG_COUNT_REVIEW', 'Δεν γνωρίζεις ακόμη το πλήθος προϊόντων ή SKU· θα το εκτιμήσουμε πριν από προσφορά.');
  if (Number.isInteger(q.productCount) && Number.isInteger(q.sellableSkuCount)) {
    if (q.sellableSkuCount < q.productCount) add('INVALID_SKU_COUNT', 'Οι πωλήσιμες παραλλαγές δεν μπορούν να είναι λιγότερες από τα προϊόντα.');
    if (q.variants === 'none' && q.sellableSkuCount !== q.productCount) add('INCONSISTENT_VARIANTS', 'Ο αριθμός SKU χρειάζεται έλεγχο σε σχέση με τις δηλωμένες παραλλαγές.');
  }
  if (q.stage === 'existing') add('MIGRATION_REVIEW', 'Η μεταφορά υπάρχοντος καταστήματος χρειάζεται ξεχωριστή εκτίμηση.');
  if (q.kind !== 'physical') add('DIGITAL_REVIEW', 'Η ψηφιακή παράδοση και ο μικτός κατάλογος χρειάζονται ξεχωριστή εκτίμηση.');
  if (q.productCount > PACKAGES.extended.productLimit) add('PRODUCT_LIMIT', `Πάνω από ${PACKAGES.extended.productLimit} φωτογραφικές μονάδες προϊόντων χρειάζονται ξεχωριστή εκτίμηση.`);
  if (q.language === 'multi') add('LANGUAGE_REVIEW', 'Το πολύγλωσσο κατάστημα χρειάζεται ξεχωριστή εκτίμηση.');
  if (q.variants === 'complex') add('VARIANTS_REVIEW', 'Οι σύνθετες επιλογές και τα bundles χρειάζονται ξεχωριστή εκτίμηση.');
  if (q.variants === 'simple') add('VARIANT_SCOPE_REVIEW', 'Θα αντιστοιχίσουμε χρώματα, μεγέθη και κοινές φωτογραφίες πριν επιβεβαιώσουμε το πακέτο. Τα συνολικά όρια SKU δεν έχουν ακόμη οριστεί.');
  if (q.integrations !== 'none') add('INTEGRATION_REVIEW', 'Οι απαιτούμενες ή άγνωστες διασυνδέσεις χρειάζονται τεχνικό έλεγχο.');
  if (q.market !== 'gr' || q.currency !== 'EUR') add('MARKET_REVIEW', 'Η πρώτη ελεγμένη διαδρομή αφορά Ελλάδα και EUR.');
  if (q.targetDate === 'urgent') add('TIMING_REVIEW', 'Η επείγουσα προθεσμία χρειάζεται επιβεβαίωση πριν δεσμευτούμε.');
  if (reasons.length) return {status: 'review', packageId: null, netPriceEUR: null, reasons, missing, gates, scope: null};

  const packageId = q.productCount > PACKAGES.basic.productLimit ? 'extended' : 'basic';
  const selected = PACKAGES[packageId];
  return {
    status: 'standard', packageId, netPriceEUR: selected.netPriceEUR, reasons, missing, gates,
    scope: {
      version: SCOPE_VERSION, offerId:PUBLIC_OFFER.offerId, offerHash:PUBLIC_OFFER.offerHash, style: 'still', packageId,
      productLimit: selected.productLimit, skuLimit: selected.skuLimit,
      skuLimitStatus:selected.skuLimitStatus,commercialUnitLimit:selected.commercialUnitLimit,
      photoSlots:selected.photoSlots,photoSlotsPerUnit:selected.photoSlotsPerUnit,
      language: q.language, market: 'gr', currency: 'EUR', pricingStatus: 'candidate_not_live',
      included: ['Προσαρμογή της βάσης STILL', 'Ελεγμένος κατάλογος εντός ορίων', 'Έλεγχος σε κινητό και desktop', 'Έλεγχος δοκιμαστικής αγοράς πριν την παράδοση'],
      excluded: ['Συνδρομή Shopify', 'Domain', 'Χρεώσεις εφαρμογών και παρόχων', 'Διαφήμιση', 'Migration', 'ERP/marketplace και άλλες ειδικές συνδέσεις'],
    },
  };
}

export function publicConfig() {
  return {
    scopeVersion: SCOPE_VERSION, offerId:PUBLIC_OFFER.offerId, offerHash:PUBLIC_OFFER.offerHash,
    currency: PUBLIC_OFFER.currency,taxBasis:PUBLIC_OFFER.taxBasis,commercialActivation:false, pricingStatus: 'candidate_not_live',
    packages: PACKAGES, submissionMode: 'local_only', emailConfirmation: false,
  };
}
