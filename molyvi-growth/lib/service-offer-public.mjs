// Generated from molyvi-contract/offer.v1.json; checked before serving/building. No private data.
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
export const PUBLIC_OFFER=deepFreeze({
  "offerId": "molyvi-offer-20261012",
  "offerHash": "8957d121caa423f47eee4b5f9eb06c2d7abcce67927a498abe3f9d11862c5998",
  "scopeVersion": "molyvi-offer-20261012.runtime-1",
  "currency": "EUR",
  "taxBasis": "exclusive_vat",
  "commercialActivation": false,
  "packages": {
    "basic": {
      "id": "basic",
      "name": "Basic",
      "netPriceEUR": 190,
      "netPriceMinor": 19000,
      "productLimit": 10,
      "commercialUnitLimit": 10,
      "photoSlots": 30,
      "photoSlotsPerUnit": 3,
      "skuLimit": null,
      "skuLimitStatus": "unresolved_not_unlimited"
    },
    "extended": {
      "id": "extended",
      "name": "Μεγαλύτερο πακέτο",
      "netPriceEUR": 399,
      "netPriceMinor": 39900,
      "productLimit": 25,
      "commercialUnitLimit": 25,
      "photoSlots": 125,
      "photoSlotsPerUnit": 5,
      "skuLimit": null,
      "skuLimitStatus": "unresolved_not_unlimited"
    }
  }
});
