import {SERVICE_OFFER,assertCurrentProjection} from './service-offer.mjs';

// Controlled build/server interpolation, never user HTML or runtime evaluation.
export function renderOfferHtml(html) {
  assertCurrentProjection();
  const values={
    'basic.price':SERVICE_OFFER.packages.basic.priceMinor/100,
    'basic.units':SERVICE_OFFER.packages.basic.catalogUnitsIncluded,
    'basic.photos':SERVICE_OFFER.packages.basic.photoSlotsIncluded,
    'basic.photosPerUnit':SERVICE_OFFER.packages.basic.photoSlotsPerUnit,
    'extended.price':SERVICE_OFFER.packages.extended.priceMinor/100,
    'extended.units':SERVICE_OFFER.packages.extended.catalogUnitsIncluded,
    'extended.photos':SERVICE_OFFER.packages.extended.photoSlotsIncluded,
    'extended.photosPerUnit':SERVICE_OFFER.packages.extended.photoSlotsPerUnit,
    'shared.pages':SERVICE_OFFER.sharedDeliverables.informationalPagesIncluded,
    'photo.regenerations':SERVICE_OFFER.photoPolicy.additionalRegenerationsPerSlot,
    'text.versions':SERVICE_OFFER.textPolicy.aiVersionsPerField,
    'extended.blogArticles':SERVICE_OFFER.packages.extended.blog.articlesIncluded,
    'branding.initialPrice':SERVICE_OFFER.addOns.branding.initialPriceMinor/100,
  };
  return html.replace(/\{\{offer\.([^}]+)\}\}/g,(_,key)=>{
    if(!Object.hasOwn(values,key))throw new Error(`Unknown offer HTML binding: ${key}`);
    return new Intl.NumberFormat('el-GR',{maximumFractionDigits:2}).format(values[key]);
  });
}
