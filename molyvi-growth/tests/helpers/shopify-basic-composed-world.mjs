import {createSyntheticCatalogWorld,syntheticConnection as connection,syntheticShopifyResponse as response} from './shopify-basic-catalog-world.mjs';
import {SHOPIFY_BASIC_CATALOG_OPERATIONS as C} from '../../lib/shopify-basic-catalog.mjs';
import {SHOPIFY_BASIC_MEDIA_OPERATIONS as M} from '../../lib/shopify-basic-media.mjs';
import {SHOPIFY_BASIC_PAGES_OPERATIONS as P} from '../../lib/shopify-basic-pages.mjs';
import {SHOPIFY_BASIC_RELATIONS_OPERATIONS as R} from '../../lib/shopify-basic-relations.mjs';
import {SHOPIFY_BASIC_TRANSPORT_SCOPES} from '../../lib/shopify-basic-transport.mjs';

const gid=(type,value)=>`gid://shopify/${type}/${value}`;
/** Synthetic persisted HTTP model only. No global fetch, credentials, external
 * services, actual upload or merchant data. Real decoder is injected separately.
 */
export function createSyntheticBasicWorld({sharp}){
  const w=createSyntheticCatalogWorld(),catalogFetch=w.fetch;
  w.app.accessScopes=SHOPIFY_BASIC_TRANSPORT_SCOPES.map(handle=>({handle}));
  Object.assign(w,{files:new Map(),uploaded:new Map(),cdn:new Map(),pages:[],collections:[],http:[],otherCalls:[],mutationNames:[]});
  const lookup=id=>w.products.find(p=>p.id===id);
  const product=id=>{const p=lookup(id);if(p){p.media??=connection([]);for(const v of p.variants.nodes)v.media??=connection([]);}return p;};
  w.fetch=async(url,options)=>{
    const {query,variables:v}=JSON.parse(options.body);
    if(Object.values(C).includes(query))return catalogFetch(url,options);
    w.otherCalls.push({query,variables:v});
    const name=/^(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    if(query.startsWith('mutation'))w.mutationNames.push(name);
    if(query===M.preflight||query===M.readback)return response({...w.identity(),product:product(v.id)});
    if(query===M.stage){const f=v.input[0];return response({stagedUploadsCreate:{userErrors:[],stagedTargets:[{url:'https://shopify-staged-uploads.storage.googleapis.com/',resourceUrl:`https://shopify-staged-uploads.storage.googleapis.com/tmp/${f.filename}`,parameters:[{name:'key',value:`tmp/${f.filename}`},{name:'Content-Type',value:f.mimeType},{name:'policy',value:'SYNTHETIC_TEST_ONLY'}]}]}});}
    if(query===M.create){
      const f=v.files[0],input=w.uploaded.get(f.filename);if(!input)throw Error('Upload missing');
      const bytes=await sharp(input).png({compressionLevel:0}).toBuffer(),meta=await sharp(bytes).metadata();
      const file={id:gid('MediaImage',String(50000+w.files.size)),alt:f.alt,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',image:{url:`https://cdn.shopify.com/s/files/1/1086/6874/8113/files/${f.filename}`,width:meta.width,height:meta.height}};
      w.files.set(file.id,file);w.cdn.set(file.image.url,bytes);return response({fileCreate:{files:[{id:file.id}],userErrors:[]}});
    }
    if(query===M.processing)return response({...w.identity(),node:w.files.get(v.id)});
    if(query===M.attach){const f=v.files[0];product(f.referencesToAdd[0]).media.nodes.push(w.files.get(f.id));return response({fileUpdate:{files:[{id:f.id}],userErrors:[]}});}
    if(query===P.preflight)return response({...w.identity(),pages:connection(w.pages.filter(p=>p.handle===v.query.replace(/^handle:/,'')))});
    if(query===P.create){const page={id:gid('Page',String(80000+w.pages.length)),...v.page};w.pages.push(page);return response({pageCreate:{page:{id:page.id},userErrors:[]}});}
    if(query===P.readback)return response({...w.identity(),page:w.pages.find(p=>p.id===v.id)});
    if(query===R.preflight)return response({...w.identity(),nodes:v.ids.map(product),collections:connection(w.collections.filter(c=>c.handle===v.query.replace(/^handle:/,'')).map(({id,handle})=>({id,handle})))});
    if(query===R.append){const p=product(v.productId);for(const association of v.variantMedia){const variant=p.variants.nodes.find(item=>item.id===association.variantId);variant.media.nodes.push(...association.mediaIds.map(id=>({id})));}return response({productVariantAppendMedia:{product:{id:p.id},userErrors:[]}});}
    if(query===R.create){const source=v.collection.sources[0].source;const c={id:gid('Collection',String(90000+w.collections.length)),title:v.collection.title,handle:v.collection.handle,resourcePublicationsCount:{count:0,precision:'EXACT'},products:connection(source.inclusion.selections.map(({productId})=>({id:productId})))};w.collections.push(c);return response({collectionCreate:{collection:{id:c.id},userErrors:[]}});}
    if(query===R.readVariants)return response({...w.identity(),nodes:v.ids.map(product)});
    if(query===R.readCollection)return response({...w.identity(),nodes:v.ids.map(product),collection:w.collections.find(c=>c.id===v.id)});
    throw Error(`Unexpected synthetic operation ${name}`);
  };
  w.uploadFetch=async(url,options)=>{
    w.http.push({url,method:options.method,headers:options.headers});
    if(options.method==='POST'){
      const file=options.body.get('file');w.uploaded.set(file.name,Buffer.from(await file.arrayBuffer()));return new Response('',{status:201});
    }
    if(!w.cdn.has(url))throw Error('Unknown synthetic CDN image');
    return new Response(w.cdn.get(url),{headers:{'content-type':'image/png'}});
  };
  return w;
}
