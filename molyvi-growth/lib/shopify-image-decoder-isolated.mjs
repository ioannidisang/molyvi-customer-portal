import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {IntakeError} from './intake-store.mjs';import {SHOPIFY_IMAGE_DECODE_LIMITS} from './shopify-image-decoder.mjs';
// Each sequential full-pixel validation releases its native allocator on exit.
// No provider/network/service is created. The caller's production lease spans
// the actual child exit, including abort and timeout.
export function createIsolatedShopifyImageDecoder(){
 let chain=Promise.resolve();
 return (input,options={})=>{const run=chain.then(()=>new Promise((resolve,reject)=>{
  const fail=code=>new IntakeError(code,422);
  if(!Buffer.isBuffer(input)||!input.length||input.length>SHOPIFY_IMAGE_DECODE_LIMITS.encodedBytes)return reject(fail('SHOPIFY_IMAGE_DECODE_INPUT_LIMIT'));
  if(options.signal?.aborted)return reject(fail('SHOPIFY_IMAGE_DECODE_ABORTED'));
  const args={mime:options.mime,maxPixels:options.maxPixels??SHOPIFY_IMAGE_DECODE_LIMITS.pixels,sourceOriginal:options.sourceOriginal===true};
  const child=spawn(process.execPath,['--max-old-space-size=64',fileURLToPath(new URL('./shopify-image-decoder-child.mjs',import.meta.url)),JSON.stringify(args)],{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='',error=null,bytes=0;
  const stop=code=>{error??=fail(code);child.kill('SIGKILL');};
  const abort=()=>stop('SHOPIFY_IMAGE_DECODE_ABORTED');options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const timer=setTimeout(()=>stop('SHOPIFY_IMAGE_DECODE_ABORTED'),12000);timer.unref();
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>2048)stop('SHOPIFY_IMAGE_DECODE_CHILD_FAILED');else output+=b.toString('utf8');});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{error??=fail('SHOPIFY_IMAGE_DECODE_CHILD_FAILED');});child.on('error',()=>{error??=fail('SHOPIFY_IMAGE_DECODE_CHILD_FAILED');});
  child.on('close',code=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error)return reject(error);let r;try{r=JSON.parse(output);}catch{return reject(fail('SHOPIFY_IMAGE_DECODE_CHILD_FAILED'));}if(code!==0||r.ok!==true)return reject(fail(/^SHOPIFY_IMAGE_DECODE_[A-Z_]+$/.test(r.code??'')?r.code:'SHOPIFY_IMAGE_DECODE_CHILD_FAILED'));const v=r.result;if(v?.decoded!==true||v.mime!==args.mime||!Number.isSafeInteger(v.width)||v.width<1||!Number.isSafeInteger(v.height)||v.height<1||v.width*v.height>Math.min(args.maxPixels,args.sourceOriginal?16_000_000:SHOPIFY_IMAGE_DECODE_LIMITS.pixels))return reject(fail('SHOPIFY_IMAGE_DECODE_METADATA_MISMATCH'));resolve(v);});child.stdin.end(input);
 }));chain=run.catch(()=>{});return run;};
}
