import {SHOPIFY_BASIC_CATALOG_OPERATIONS as operations,SHOPIFY_BASIC_CATALOG_SCOPES as scopes} from '../../lib/shopify-basic-catalog.mjs';

const targetStore='molyvi-still-dev.myshopify.com',shopId='108668748113',appId='436878311425',installationId='1195450433873',liveThemeId='207379235153',inventoryLocationId='125398417745';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
export const syntheticConnection=nodes=>({nodes,pageInfo:{hasNextPage:false}});
export function syntheticShopifyResponse(data,options={}){return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'},...options});}

// Independent in-memory persisted response model. No real credentials or fetch.
// Never use this fixture as installed-Shopify evidence or authorization.
export function createSyntheticCatalogWorld(overrides={}){
  const world={calls:[],products:[],mutations:0,shop:{id:gid('Shop',shopId),myshopifyDomain:targetStore,currencyCode:'EUR'},app:{id:gid('AppInstallation',installationId),app:{id:gid('App',appId)},accessScopes:scopes.map(handle=>({handle}))},themes:syntheticConnection([{id:gid('OnlineStoreTheme',liveThemeId),role:'MAIN'}]),location:{id:gid('Location',inventoryLocationId),isActive:true,fulfillsOnlineOrders:true},...overrides};
  const identity=()=>({shop:world.shop,currentAppInstallation:world.app,themes:world.themes,location:world.location});
  world.identity=identity;
  world.fetch=async(url,options)=>{
    const payload=JSON.parse(options.body);world.calls.push({url,options,payload});
    if(world.handler)return world.handler(payload,options,identity);
    if(payload.query===operations.preflight){
      const handle=payload.variables.query.replace(/^handle:/,'');
      return syntheticShopifyResponse({...identity(),products:syntheticConnection(world.products.filter(p=>p.handle===handle).map(({id,handle})=>({id,handle})))});
    }
    if(payload.query===operations.create){
      world.mutations++;const input=payload.variables.input,id=gid('Product',String(100+world.mutations)),offset=(world.mutations-1)*1000;
      const variants=input.variants.map((v,index)=>({id:gid('ProductVariant',String(200+offset+index)),sku:v.sku,price:v.price,inventoryPolicy:v.inventoryPolicy,selectedOptions:v.optionValues.map(o=>({name:o.optionName,value:o.name})),inventoryItem:{id:gid('InventoryItem',String(300+offset+index)),...v.inventoryItem,measurement:v.inventoryItem.measurement??{weight:null},inventoryLevels:syntheticConnection(v.inventoryQuantities.map(q=>({location:{id:q.locationId},quantities:[{name:q.name,quantity:q.quantity}]})))}}));
      world.products.push({id,handle:input.handle,title:input.title,descriptionHtml:input.descriptionHtml,vendor:input.vendor,productType:input.productType,status:input.status,tags:input.tags,options:input.productOptions.map(o=>({name:o.name,position:o.position,optionValues:o.values})),resourcePublicationsCount:{count:0,precision:'EXACT'},variants:syntheticConnection(variants)});
      return syntheticShopifyResponse({productSet:{product:{id},userErrors:[]}});
    }
    if(payload.query===operations.readback){
      const product=structuredClone(world.products.find(p=>p.id===payload.variables.id)??null);
      if(product?.variants&&Number.isSafeInteger(payload.variables.variantLimit)){
        product.variants.pageInfo.hasNextPage=product.variants.pageInfo.hasNextPage||product.variants.nodes.length>payload.variables.variantLimit;
        product.variants.nodes=product.variants.nodes.slice(0,payload.variables.variantLimit);
      }
      return syntheticShopifyResponse({...identity(),product});
    }
    throw Error('Unexpected synthetic catalog operation');
  };
  return world;
}
