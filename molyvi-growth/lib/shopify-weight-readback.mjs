// An omitted source weight stays unknown in our records. Shopify may represent
// that omission as a zero in the store's default unit. This is not a measured
// zero and must never be used to infer a shipping weight.
export function matchesShopifyWeight(weight,expectedGrams){
 if(expectedGrams===null)return weight===null||Boolean(weight&&['GRAMS','KILOGRAMS','OUNCES','POUNDS'].includes(weight.unit)&&weight.value===0);
 return Boolean(weight&&weight.unit==='GRAMS'&&Number.isSafeInteger(weight.value)&&weight.value>=0&&weight.value===expectedGrams);
}
