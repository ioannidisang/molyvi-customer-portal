import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {SHOPIFY_BASIC_THEME_OPERATIONS as T,SHOPIFY_BASIC_THEME_SCOPES} from '../../lib/shopify-basic-theme.mjs';
const require=createRequire(new URL('../../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
const gid=(type,value)=>`gid://shopify/${type}/${value}`,md5=v=>crypto.createHash('md5').update(v).digest('hex');
const response=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','x-shopify-api-version':'2026-10'}});
const connection=nodes=>({nodes,pageInfo:{hasNextPage:false}});

/** Pure synthetic HTTP model. Wraps an existing synthetic catalog/pages world,
 * never invokes global fetch or any actual service. Controls deliberately allow
 * tests to simulate a lying mutation response, persisted corruption and drift.
 */
export async function createSyntheticThemeWorld({baseWorld,theme}){
 const w=baseWorld,normalFetch=w.fetch,normalUpload=w.uploadFetch,zip=await JSZip.loadAsync(theme.zipBytes),sourceFiles=[];
 for(const file of Object.values(zip.files).filter(f=>!f.dir)){const bytes=await file.async('nodebuffer');sourceFiles.push({filename:file.name,size:String(bytes.length),checksumMd5:md5(bytes),body:{__typename:'OnlineStoreThemeFileBodyBase64',contentBase64:bytes.toString('base64')}});}
 const scopes=new Set([...w.app.accessScopes.map(s=>s.handle),...SHOPIFY_BASIC_THEME_SCOPES]);w.app.accessScopes=[...scopes].map(handle=>({handle}));
 w.themeCalls=[];w.themeWrites=[];w.themeExternal=[];w.themeControl={omitLicense:true,pageSize:50,processingReads:0};w.installedTheme=null;w.uploadedThemeZip=null;
 w.fetch=async(url,options)=>{
  const {query,variables:v}=JSON.parse(options.body);if(!Object.values(T).includes(query))return normalFetch(url,options);
  const c=w.themeControl,name=/^(?:query|mutation)\s+(\w+)/.exec(query)?.[1];w.themeCalls.push({name,query,variables:v,url,options});if(query.startsWith('mutation'))w.themeWrites.push(name);
  if(c.beforeResponse)await c.beforeResponse(name,v,w);
  const identity=w.identity();
  if(query===T.preflight)return response(identity);
  if(query===T.product)return response({...identity,product:w.products.find(p=>p.id===v.id)});
  if(query===T.page)return response({...identity,page:w.pages.find(p=>p.id===v.id)});
  if(query===T.collection)return response({...identity,collection:w.collections.find(p=>p.id===v.id)});
  if(query===T.stage){const f=v.input[0];return response({stagedUploadsCreate:{userErrors:[],stagedTargets:[{url:c.stageUrl??'https://shopify-staged-uploads.storage.googleapis.com/',resourceUrl:`https://shopify-staged-uploads.storage.googleapis.com/tmp/${f.filename}`,parameters:[{name:'key',value:`tmp/${f.filename}`},{name:'Content-Type',value:f.mimeType},{name:'policy',value:'SYNTHETIC_TEST_ONLY'}]}]}});}
  if(query===T.create){
   if(!w.uploadedThemeZip)throw Error('Synthetic theme upload missing');
   w.installedTheme={id:gid('OnlineStoreTheme','99001'),name:v.name,role:c.createdRole??'UNPUBLISHED',processing:false,processingFailed:false};
   if(c.loseCreateResponse)throw Error('Synthetic lost create response SECRET_MUST_NOT_LEAK');
   return response({themeCreate:{theme:{...w.installedTheme},userErrors:[]}});
  }
  if(query===T.state){const actual=w.installedTheme?{...w.installedTheme,processing:c.processingReads-->0}:null;return response({...identity,theme:actual});}
  if(query===T.files){
   let files=structuredClone(sourceFiles).filter(f=>!c.omitLicense||f.filename!=='LICENSE.md');
   if(c.transformFiles)files=c.transformFiles(files);
   const start=v.after?Number(v.after):0,size=c.pageSize,page=files.slice(start,start+size),hasNextPage=start+size<files.length;
   if(c.urlBody&&page.length){const f=page[0],bytes=Buffer.from(f.body.contentBase64,'base64'),url=c.fileUrl??`https://cdn.shopify.com/s/files/1/1086/6874/8113/t/99001/assets/${encodeURIComponent(f.filename)}?v=1`;w.themeUrlBytes=bytes;f.body={__typename:'OnlineStoreThemeFileBodyUrl',url};}
   return response({...identity,theme:w.installedTheme?{...w.installedTheme,files:{nodes:page,pageInfo:{hasNextPage,endCursor:hasNextPage?String(start+size):null},userErrors:c.fileErrors??[]}}:null});
  }
  throw Error('Unexpected synthetic theme operation');
 };
 w.uploadFetch=async(url,options)=>{
  const file=options.method==='POST'?options.body?.get('file'):null;
  if(file?.type==='application/zip'){
   w.themeExternal.push({url,method:options.method,headers:options.headers});w.uploadedThemeZip=Buffer.from(await file.arrayBuffer());if(w.themeControl.loseUploadResponse)throw Error('Synthetic lost upload response SECRET_MUST_NOT_LEAK');return new Response('',{status:201});
  }
  if(options.method==='GET'&&w.themeControl.urlBody){w.themeExternal.push({url,method:options.method,headers:options.headers});return new Response(w.themeUrlBytes,{headers:{'content-type':'application/octet-stream'}});}
  return normalUpload(url,options);
 };
 return w;
}
