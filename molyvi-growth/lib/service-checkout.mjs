import {IntakeError} from './intake-store.mjs';

// A cart identifier is not an access credential. Never put the private return
// key, customer details or a payment assertion in this URL.
export function serviceCheckoutUrl(purchase) {
  if(purchase?.shopDomain!=='molyvi-still-dev.myshopify.com'||purchase.evidenceMode!=='shopify_test'||
    purchase.checkoutEnabled!==true||!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(purchase.intentId??'')||
    !/^[1-9]\d{0,19}$/.test(String(purchase.expected?.variantId??'')))throw new IntakeError('SERVICE_CHECKOUT_UNAVAILABLE',409);
  const url=new URL(`https://${purchase.shopDomain}/cart/${purchase.expected.variantId}:1`);
  url.searchParams.set('attributes[molyvi_service_intent]',purchase.intentId);
  url.searchParams.set('locale','el');
  return url.href;
}
