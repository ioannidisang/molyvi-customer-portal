import {IntakeError} from './intake-store.mjs';

export const SHOPIFY_IMAGE_DECODE_LIMITS=Object.freeze({encodedBytes:16*1024*1024,pixels:12_000_000,rawBytes:48_000_000,wallMs:10_000,processingSeconds:5});
const types=Object.freeze({png:'image/png',jpeg:'image/jpeg',webp:'image/webp'});
const fail=code=>{throw new IntakeError(`SHOPIFY_IMAGE_DECODE_${code}`,422);};

/** Full local decoding, not a visual comparison or a signature-only check.
 * sharp is explicitly injected by the trusted operator; this module installs
 * nothing and reads no environment, files, credentials or network. The bundled
 * desktop runtime supplies sharp for the pilot; Render has no implicit decoder.
 */
export function createShopifyImageDecoder({sharp}={}){
  if(typeof sharp!=='function')fail('LIBRARY_REQUIRED');
  return async function decodeImage(input,{mime,maxPixels=SHOPIFY_IMAGE_DECODE_LIMITS.pixels,signal}={}){
    if(!Buffer.isBuffer(input)||input.length<1||input.length>SHOPIFY_IMAGE_DECODE_LIMITS.encodedBytes)fail('INPUT_LIMIT');
    if(!Object.values(types).includes(mime)||!Number.isSafeInteger(maxPixels)||maxPixels<1)fail('INPUT_TYPE');
    const cap=Math.min(maxPixels,SHOPIFY_IMAGE_DECODE_LIMITS.pixels);
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(SHOPIFY_IMAGE_DECODE_LIMITS.wallMs)]):AbortSignal.timeout(SHOPIFY_IMAGE_DECODE_LIMITS.wallMs);
    if(combined.aborted)fail('ABORTED');
    let image;
    const bounded=promise=>new Promise((resolve,reject)=>{
      const abort=()=>{image?.destroy();reject(new IntakeError('SHOPIFY_IMAGE_DECODE_ABORTED',422));};
      combined.addEventListener('abort',abort,{once:true});
      if(combined.aborted)abort();
      Promise.resolve(promise).then(resolve,reject).finally(()=>combined.removeEventListener('abort',abort));
    });
    try{
      image=sharp(Buffer.from(input),{failOn:'warning',limitInputPixels:cap,limitInputChannels:4,sequentialRead:true}).timeout({seconds:SHOPIFY_IMAGE_DECODE_LIMITS.processingSeconds});
      const metadata=await bounded(image.metadata());
      if(types[metadata.format]!==mime||(metadata.pages??1)!==1||!Number.isSafeInteger(metadata.width)||metadata.width<1||!Number.isSafeInteger(metadata.height)||metadata.height<1||metadata.width*metadata.height>cap)fail('METADATA_MISMATCH');
      // toBuffer forces decompression of every pixel; metadata alone is not PASS.
      const {data,info}=await bounded(image.raw().toBuffer({resolveWithObject:true}));
      if(!Buffer.isBuffer(data)||data.length>SHOPIFY_IMAGE_DECODE_LIMITS.rawBytes||info.width!==metadata.width||info.height!==metadata.height||!Number.isInteger(info.channels)||info.channels<1||info.channels>4||data.length!==info.width*info.height*info.channels)fail('PIXELS_INVALID');
      if(combined.aborted)fail('ABORTED');
      return {decoded:true,mime,width:info.width,height:info.height};
    }catch(error){
      if(error instanceof IntakeError&&error.code?.startsWith('SHOPIFY_IMAGE_DECODE_'))throw error;
      fail(combined.aborted?'ABORTED':'INVALID_IMAGE');
    }finally{image?.destroy();}
  };
}
