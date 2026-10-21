import {IntakeError} from './intake-store.mjs';
import {createBasicInstallationSource} from './basic-installation-source.mjs';
import {createShopifyBasicCatalogTransport,SHOPIFY_BASIC_CATALOG_SCOPES} from './shopify-basic-catalog.mjs';
import {createShopifyBasicMediaTransport,SHOPIFY_BASIC_MEDIA_SCOPES} from './shopify-basic-media.mjs';
import {createShopifyBasicRelationsTransport,SHOPIFY_BASIC_RELATIONS_SCOPES} from './shopify-basic-relations.mjs';
import {createShopifyBasicPagesTransport,SHOPIFY_BASIC_PAGES_SCOPES} from './shopify-basic-pages.mjs';
import {createShopifyBasicThemeTransport,SHOPIFY_BASIC_THEME_SCOPES} from './shopify-basic-theme.mjs';

export const SHOPIFY_BASIC_TRANSPORT_SCOPES=Object.freeze([...new Set([...SHOPIFY_BASIC_CATALOG_SCOPES,...SHOPIFY_BASIC_MEDIA_SCOPES,...SHOPIFY_BASIC_RELATIONS_SCOPES,...SHOPIFY_BASIC_PAGES_SCOPES])].sort());
// Theme access is opt-in. The existing catalogue/page-only integration must
// never request a broader grant merely because a new adapter is installed.
export const SHOPIFY_BASIC_FULL_PACKAGE_SCOPES=Object.freeze([...new Set([...SHOPIFY_BASIC_TRANSPORT_SCOPES,...SHOPIFY_BASIC_THEME_SCOPES])].sort());
const fail=code=>{throw new IntakeError(`SHOPIFY_BASIC_TRANSPORT_${code}`,422);};

/** Local composition for the existing durable one-attempt runner. No network
 * unless explicitly enabled by a trusted caller with an authorized credential.
 * Theme upload is enabled only with an explicitly supplied bound theme package.
 * There is no publication, permission expansion or run-all here.
 * Media source/CDN provenance is saved separately before the runner accepts its
 * receipt; the legacy journal deliberately retains only its established fields.
 * A sink failure leaves the durable attempt unknown, never automatically retried.
 */
export function createShopifyBasicTransport(options={}){
  if(typeof options.recordReadbackEvidence!=='function')fail('EVIDENCE_SINK_REQUIRED');
  const sink=options.recordReadbackEvidence;
  const referenceSource=options.referenceComposition===undefined?null:createBasicInstallationSource({prepared:options.prepared,referenceComposition:options.referenceComposition});
  const adapters=[createShopifyBasicCatalogTransport(options),createShopifyBasicMediaTransport(options),createShopifyBasicRelationsTransport(options),createShopifyBasicPagesTransport(options)];
  if(options.theme!==undefined)adapters.push(createShopifyBasicThemeTransport(options));
  const routes=new Map();
  for(const adapter of adapters)for(const kind of adapter.supportedKinds){if(routes.has(kind))fail('DUPLICATE_ROUTE');routes.set(kind,Object.fromEntries(['preflight','apply','readback'].map(name=>[name,adapter[name].bind(adapter)])));}
  const route=request=>{const selected=routes.get(request?.step?.kind);if(!selected)fail('UNSUPPORTED_STEP');return selected;};
  return Object.freeze({supportedKinds:Object.freeze([...routes.keys()]),...(options.theme!==undefined?{themeProcessing:'durable_v1'}:{}),
    preflight:async(request,control)=>route(request).preflight(request,control),
    apply:async(request,control)=>route(request).apply(request,control),
    async readback(request,control){
      const result=await route(request).readback(request,control);
      if(result.outcome==='found'){
        await referenceSource?.revalidate();
        try{await sink(structuredClone(result));}catch{fail('EVIDENCE_NOT_SAVED');}
        // A sink that runs asynchronously cannot commit a receipt for a source
        // revoked while evidence was being persisted. Keep its claim unknown.
        await referenceSource?.revalidate();
      }
      return result;
    }
  });
}
