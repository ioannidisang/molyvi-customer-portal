import {IntakeError} from './intake-store.mjs';
import {MerchantPaymentsError,normalizeMerchantProfile as normalizeMerchant,inspectMerchantProfile as inspectMerchant,normalizePaymentPlan as normalizePayment,inspectPaymentPlan as inspectPayment} from '../../molyvi-contract/lib/merchant-payments.mjs';
export {PAYMENT_GUIDANCE} from '../../molyvi-contract/lib/merchant-payments.mjs';
function adapt(fn) {try{return fn();}catch(error){if(error instanceof MerchantPaymentsError)throw new IntakeError(error.code,422,error.details);throw error;}}
export const normalizeMerchantProfile=(input,options)=>adapt(()=>normalizeMerchant(input,options));
export const inspectMerchantProfile=input=>inspectMerchant(input);
export const normalizePaymentPlan=(input,options)=>adapt(()=>normalizePayment(input,options));
export const inspectPaymentPlan=(input,options)=>inspectPayment(input,options);
