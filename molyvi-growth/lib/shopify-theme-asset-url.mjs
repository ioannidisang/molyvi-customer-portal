import {IntakeError} from './intake-store.mjs';
// Asset URLs come from the authenticated, exact-store theme API. Both hosts
// are exact allowlist entries; the transport still rejects redirects, limits
// response bytes and verifies the complete payload against the source hash.
export function safeShopifyThemeUrl(value,kind){
 const fail=()=>{throw new IntakeError('SHOPIFY_BASIC_THEME_UNSAFE_URL',422)};
 let url;try{url=new URL(value)}catch{fail()}
 if(typeof value!=='string'||/[\x00-\x20\\]/.test(value)||url.protocol!=='https:'||url.port||url.username||url.password||url.hash)fail();
 const stage=url.hostname==='shopify-staged-uploads.storage.googleapis.com';
 const asset=['cdn.shopify.com','shopify-shop-assets.storage.googleapis.com'].includes(url.hostname)&&url.pathname.startsWith('/s/files/');
 if(kind==='stage'?!stage:kind!=='cdn'||!asset)fail();
 return url.href;
}
