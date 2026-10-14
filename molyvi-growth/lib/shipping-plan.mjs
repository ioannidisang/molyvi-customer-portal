import {packageForOrder} from './service-offer.mjs';
import {IntakeError} from './intake-store.mjs';
import {normalizeShippingPlan as normalize,inspectShippingPlan as inspect,estimateShipping as estimate,ShippingPlanError,SHIPPING_COUNTRIES} from '../../molyvi-contract/lib/shipping.mjs';
export {SHIPPING_COUNTRIES,parseMoneyMinor,parseKilogramsToGrams} from '../../molyvi-contract/lib/shipping.mjs';

function policyFor(order) {
  const policy=packageForOrder(order).entitlements.shipping;
  if(!policy)throw new IntakeError('SHIPPING_OFFER_REVIEW_REQUIRED',422);
  return policy;
}
export function shippingPolicyForOrder(order) {
  const policy=packageForOrder(order).entitlements.shipping;
  if(!policy)return Object.freeze({available:false,countries:SHIPPING_COUNTRIES,reason:'SHIPPING_OFFER_REVIEW_REQUIRED',localEstimateOnly:true,shopifyConfigured:false});
  return {...structuredClone(policy),available:true,countries:SHIPPING_COUNTRIES,localEstimateOnly:true,shopifyConfigured:false};
}
export function normalizeShippingPlan(order,input,options) {
  try{return normalize(policyFor(order),input,options);}catch(error){if(error instanceof ShippingPlanError)throw new IntakeError(error.code,422,error.details);throw error;}
}
export function inspectShippingPlan(order,input) {return inspect(policyFor(order),input);}
export function estimateShipping(order,input,scenario) {
  try{return estimate(policyFor(order),input,scenario);}catch(error){if(error instanceof ShippingPlanError)throw new IntakeError(error.code,422,error.details);throw error;}
}
