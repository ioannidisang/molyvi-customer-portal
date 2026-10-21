// Local test double only: source files stand in for provider storage after the
// entire uploaded body has been hashed. No retained image buffers or network.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createSyntheticBasicWorld} from './shopify-basic-composed-world.mjs';
import {createSyntheticThemeWorld} from './shopify-basic-theme-world.mjs';
import {SHOPIFY_BASIC_MEDIA_OPERATIONS as M} from '../../lib/shopify-basic-media.mjs';
const response=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
export async function createReferenceDiskWorld({sharp,theme,assets}){
  const base=createSyntheticBasicWorld({sharp}),normalFetch=base.fetch;
  const uploaded=new Map(),cdn=new Map(),uploads=[],downloads=[];let active=0,maxActive=0;
  base.fetch=async(url,options)=>{
    const {query,variables:v}=JSON.parse(options.body);
    if(query!==M.create)return normalFetch(url,options);
    base.otherCalls.push({query,variables:v});base.mutationNames.push('MolyviBasicFileCreate');
    const f=v.files[0],input=uploaded.get(f.filename);assert(input,'Previously verified upload required');
    const meta=await sharp(input.file).metadata();
    const image={id:`gid://shopify/MediaImage/${50000+base.files.size}`,alt:f.alt,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',image:{url:`https://cdn.shopify.com/s/files/1/1086/6874/8113/files/${f.filename}`,width:meta.width,height:meta.height}};
    base.files.set(image.id,image);cdn.set(image.image.url,input);return response({fileCreate:{files:[{id:image.id}],userErrors:[]}});
  };
  base.uploadFetch=async(url,options)=>{
    active++;maxActive=Math.max(maxActive,active);assert.equal(active,1);
    try{
      if(options.method==='POST'){
        const file=options.body.get('file'),h=crypto.createHash('sha256');let bytes=0;
        for await(const chunk of Readable.fromWeb(file.stream())){bytes+=chunk.length;assert(bytes<=10*1024*1024);h.update(chunk);}
        const sha256=h.digest('hex'),found=assets.find(a=>a.sha256===sha256&&a.bytes===bytes);assert(found,'Upload must equal a pinned source');
        assert.equal((await fs.stat(found.file)).size,bytes);uploaded.set(file.name,found);uploads.push({bytes,sha256});return new Response('',{status:201});
      }
      assert.equal(options.method,'GET');const source=cdn.get(url);assert(source,'Known image ID required');downloads.push({bytes:source.bytes,sha256:source.sha256});
      return new Response(Readable.toWeb(createReadStream(source.file,{highWaterMark:65536})),{headers:{'content-type':'image/png'}});
    }finally{active--;}
  };
  const world=await createSyntheticThemeWorld({baseWorld:base,theme});
  return {world,uploads,downloads,summary:()=>({products:world.products.length,variants:world.products.reduce((n,p)=>n+p.variants.nodes.length,0),images:world.files.size,pages:world.pages.length,collections:world.collections.length,themeRole:world.installedTheme?.role,graphql:world.calls.length+world.otherCalls.length+world.themeCalls.length,mutations:world.mutations+world.mutationNames.length+world.themeWrites.length,imageUploads:uploads.length,themeUploads:world.themeExternal.filter(x=>x.method==='POST').length,downloads:downloads.length,maxActive,retainedImageBuffers:world.uploaded.size+world.cdn.size,synthetic:true,sourceBytesStandInForCDN:true})};
}
