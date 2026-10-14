// Customer-safe projection: no access hash, private owner ID or webhook secret.
export function publicServicePayment(record){
  const purchase=record.servicePurchase;if(!purchase)return null;
  return {status:record.order.status,mode:'test',evidenceMode:purchase.evidenceMode,
    sourceVerified:Boolean(purchase.receipt),providerDeliveryVerified:Boolean(purchase.receipt)&&purchase.evidenceMode==='shopify_test',
    checkoutConfigured:purchase.checkoutEnabled===true,netMinor:purchase.expected.netMinor,taxMinor:purchase.expected.taxMinor,grossMinor:purchase.expected.grossMinor,
    currency:'EUR',automaticImageProduction:false};
}
