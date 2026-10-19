import crypto from 'node:crypto';
import {TextDecoder} from 'node:util';
import {IntakeError} from './intake-store.mjs';
export const SHOPIFY_THEME_COMMENT_PREFIX='/*\n * ------------------------------------------------------------\n * IMPORTANT: The contents of this file are auto-generated.\n *\n * This file may be updated by the Shopify admin theme editor\n * or related systems. Please exercise caution as any changes\n * made to this file may be overwritten.\n * ------------------------------------------------------------\n */\n';
export const SHOPIFY_LANGUAGE_COMMENT_PREFIX=SHOPIFY_THEME_COMMENT_PREFIX.replace('theme editor','language editor');
const SHOPIFY_JSON_PREFIX=Buffer.from(SHOPIFY_THEME_COMMENT_PREFIX),SHOPIFY_JSON_PREFIX_SHA='b2d0b5bfe5534586cfe55a488ada77a83d6e979b1d09228d069d782e820b2940';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),md5=b=>crypto.createHash('md5').update(b).digest('hex');
const stop=code=>{throw new IntakeError('SHOPIFY_BASIC_THEME_PROVIDER_BODY_'+code,422);},need=(ok,code)=>{if(!ok)stop(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const LANGUAGE_PREFIX=Buffer.from(SHOPIFY_JSON_PREFIX.toString('utf8').replace('theme editor','language editor'));
const LANGUAGE_PREFIX_SHA='8601bab28f8e07bcfc9b31c5b0707feb861387da5859f7e8ea91028434ff2191';
need(SHOPIFY_JSON_PREFIX.length===363&&sha(SHOPIFY_JSON_PREFIX)===SHOPIFY_JSON_PREFIX_SHA&&LANGUAGE_PREFIX.length===366&&sha(LANGUAGE_PREFIX)===LANGUAGE_PREFIX_SHA,'LANGUAGE_PREFIX_LITERAL_MISMATCH');
// Source-bound rules copied from the independently reviewed installation proof.
// These are intentionally not generalized to arbitrary JSON or newer templates.
const manifest={
  "kind": "EXACT_FOUR_REVIEWED_TEMPLATE_TRANSFORMS",
  "files": [
    {
      "file": "templates/404.json",
      "sourceSha256": "16fa73d997867377e2dc0fba53ded438d255caad673fdec0ed01858540564fae",
      "sourceBytes": 98,
      "additions": [
        "/sections/main/settings"
      ],
      "keyOrderChanges": [],
      "storedBytes": 72,
      "storedSha256": "3321b3b8eeaf71de7a44dff26f8e5c12df59fa5d147bcd9acbd2b3f0d9b1e265",
      "storedMd5": "f14a0bd594f4fee47b13fc09543098ff",
      "payloadSha256": "673bac78f620425711ef917d9ae94a014d403aeedc4041114eb2238459cf304f"
    },
    {
      "file": "templates/article.json",
      "sourceSha256": "fbc9c1aea853aad32074743b7828e2ee8715d76f3864d8c8104386a5adb4e952",
      "sourceBytes": 740,
      "additions": [
        "/sections/main/blocks/content/settings",
        "/sections/main/settings"
      ],
      "keyOrderChanges": [],
      "storedBytes": 413,
      "storedSha256": "20dd132b3bb4c2be9661adb4e34248e34df74045e157129b2187c05024f0b1d5",
      "storedMd5": "2fceb4c3e270e8ea0e7f4ea683d4c303",
      "payloadSha256": "87bd4daa709defcfb3ad9a029c58709f9df157abd5cadd22728d2a1e1b21b205"
    },
    {
      "file": "templates/password.json",
      "sourceSha256": "d1e91fef0691e49a4c4627ed935dd07fe06f04ef96b180934d9a276375b188fe",
      "sourceBytes": 1072,
      "additions": [
        "/sections/main/blocks/email_form/settings"
      ],
      "keyOrderChanges": [
        {
          "path": "/sections/main/settings",
          "sourceOrder": [
            "image_overlay_opacity",
            "show_background_image",
            "image_height",
            "desktop_content_position",
            "show_text_box",
            "desktop_content_alignment",
            "color_scheme",
            "mobile_content_alignment",
            "show_text_below"
          ],
          "providerOrder": [
            "show_background_image",
            "image_overlay_opacity",
            "image_height",
            "desktop_content_position",
            "desktop_content_alignment",
            "show_text_box",
            "color_scheme",
            "mobile_content_alignment",
            "show_text_below"
          ]
        }
      ],
      "storedBytes": 685,
      "storedSha256": "9ba6599b47a2ef20519554b6810216a176e23c57e19dbb48942ba5f47fdd4285",
      "storedMd5": "4749b3d611b8e5c606c326b9c959bfc5",
      "payloadSha256": "17b85070e369ec5de393197c1f1a73057ad17b063284f9ba7b3a0a0e3dababa1"
    },
    {
      "file": "templates/product.json",
      "sourceSha256": "7246efa61fd67420855dff7c89e74aef2cf4709df05d3c2831ce33ff319c24da",
      "sourceBytes": 2306,
      "additions": [
        "/sections/main/blocks/description/settings",
        "/sections/main/blocks/price/settings",
        "/sections/main/blocks/quantity_selector/settings",
        "/sections/main/blocks/title/settings"
      ],
      "keyOrderChanges": [
        {
          "path": "/sections/main/settings",
          "sourceOrder": [
            "enable_sticky_info",
            "color_scheme",
            "media_position",
            "gallery_layout",
            "media_size",
            "constrain_to_viewport",
            "media_fit",
            "image_zoom",
            "mobile_thumbnails",
            "hide_variants",
            "enable_video_looping",
            "padding_top",
            "padding_bottom"
          ],
          "providerOrder": [
            "enable_sticky_info",
            "color_scheme",
            "media_size",
            "constrain_to_viewport",
            "media_fit",
            "gallery_layout",
            "mobile_thumbnails",
            "media_position",
            "image_zoom",
            "hide_variants",
            "enable_video_looping",
            "padding_top",
            "padding_bottom"
          ]
        },
        {
          "path": "/sections/related-products",
          "sourceOrder": [
            "type",
            "settings",
            "disabled"
          ],
          "providerOrder": [
            "type",
            "disabled",
            "settings"
          ]
        },
        {
          "path": "/sections/related-products/settings",
          "sourceOrder": [
            "heading",
            "heading_size",
            "products_to_show",
            "columns_desktop",
            "color_scheme",
            "image_ratio",
            "image_shape",
            "show_secondary_image",
            "show_vendor",
            "show_rating",
            "columns_mobile",
            "padding_top",
            "padding_bottom"
          ],
          "providerOrder": [
            "heading",
            "heading_size",
            "products_to_show",
            "columns_desktop",
            "columns_mobile",
            "color_scheme",
            "image_ratio",
            "image_shape",
            "show_secondary_image",
            "show_vendor",
            "show_rating",
            "padding_top",
            "padding_bottom"
          ]
        }
      ],
      "storedBytes": 1492,
      "storedSha256": "e091752cb12e0a97611863de63906b26bcaf520f6f2c0dda770203d8aaad8814",
      "storedMd5": "67659336e95fb396dbd59d30e1bbe509",
      "payloadSha256": "32f038b941fc4c56635482ec4e8c5cf1d1106c4b3bd227a87604c98310670603"
    }
  ]
};
const transforms=new Map(manifest.files.map(f=>[f.file,f]));
need(same([...transforms.keys()],['templates/404.json','templates/article.json','templates/password.json','templates/product.json']),'EXACT_FOUR_TRANSFORMS_REQUIRED');
function compare(source,provider,rule,p=[],found=[]){
 const pointer='/'+p.join('/');
 if(Array.isArray(source)||Array.isArray(provider)){need(Array.isArray(source)&&Array.isArray(provider)&&source.length===provider.length,'TRANSFORM_ARRAY_CHANGED');source.forEach((v,i)=>compare(v,provider[i],rule,[...p,String(i)],found));return found;}
 if(source!==null&&typeof source==='object'){
  need(provider!==null&&typeof provider==='object'&&!Array.isArray(provider),'TRANSFORM_TYPE_CHANGED');const sk=Object.keys(source),pk=Object.keys(provider);
  need(sk.every(k=>Object.hasOwn(provider,k)),'TRANSFORM_KEY_REMOVED');
  for(const k of pk.filter(k=>!Object.hasOwn(source,k))){const target=pointer+'/'+k,v=provider[k];need(k==='settings'&&rule.additions.includes(target)&&v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0,'TRANSFORM_UNPERMITTED_ADDITION');found.push(target);}
  const sharedProviderKeys=pk.filter(k=>Object.hasOwn(source,k)),orderRule=rule.keyOrderChanges.find(c=>c.path===pointer);
  need(orderRule?same(sk,orderRule.sourceOrder)&&same(sharedProviderKeys,orderRule.providerOrder):same(sk,sharedProviderKeys),'TRANSFORM_UNREVIEWED_KEY_ORDER');
  for(const k of sk)compare(source[k],provider[k],rule,[...p,k],found);return found;
 }
 need(Object.is(source,provider),'TRANSFORM_SCALAR_OR_TYPE_CHANGED');return found;
}
/** Exact source bytes or two observed fixed comment envelopes. A separate,
 * source-hash-bound four-file rule permits only the eight reviewed empty
 * settings additions, reviewed object-key order and exact observed serializer.
 * No arbitrary JSON equivalence, whitespace stripping or source adoption.
 */
export function verifyShopifyThemeProviderBody({filename,bodyType,rawBytes,sourceBytes,providerSize,providerMd5}={}){
 need(typeof filename==='string'&&filename.length<=512&&!filename.includes('\\')&&!filename.split('/').some(p=>!p||p==='.'||p==='..')&&!/[\x00-\x1f]/.test(filename)&&Buffer.isBuffer(rawBytes)&&Buffer.isBuffer(sourceBytes)&&sourceBytes.length<=8*1024*1024&&rawBytes.length<=8*1024*1024+366&&['OnlineStoreThemeFileBodyText','OnlineStoreThemeFileBodyBase64','OnlineStoreThemeFileBodyUrl'].includes(bodyType),'REPRESENTATION_INPUT_INVALID');
 const sourceSha=sha(sourceBytes),sourceMd5=md5(sourceBytes),size=typeof providerSize==='string'&&/^(?:0|[1-9]\d*)$/.test(providerSize)&&providerSize.length<16?Number(providerSize):providerSize;
 let representation='exact_source_bytes',prefix=null,payload=rawBytes,stored=sourceBytes,transformed=false,additions=[];
 if(!rawBytes.equals(sourceBytes)){
  need(bodyType==='OnlineStoreThemeFileBodyText','UNAPPROVED_PROVIDER_BODY_TYPE');
  if(/^locales\/[^/]+\.json$/.test(filename))prefix=LANGUAGE_PREFIX;
  else if(filename==='config/settings_data.json'||/^sections\/[^/]+\.json$/.test(filename)||/^templates\/(?:(?:customers|metaobject)\/)?[^/]+\.json$/.test(filename))prefix=SHOPIFY_JSON_PREFIX;
  need(prefix&&rawBytes.subarray(0,prefix.length).equals(prefix),'UNAPPROVED_PROVIDER_HEADER');payload=rawBytes.subarray(prefix.length);
  if(payload.equals(sourceBytes))representation=prefix===LANGUAGE_PREFIX?'shopify_exact_language_comment_prefix':'shopify_exact_theme_comment_prefix';
  else{
   const rule=transforms.get(filename);need(rule&&sourceSha===rule.sourceSha256&&sourceBytes.length===rule.sourceBytes&&prefix===SHOPIFY_JSON_PREFIX,'UNAPPROVED_SOURCE_TRANSFORMATION');
   let source,provider;try{const decoder=new TextDecoder('utf-8',{fatal:true});source=JSON.parse(decoder.decode(sourceBytes));provider=JSON.parse(decoder.decode(payload));}catch{stop('TRANSFORM_JSON_INVALID');}
   // Roundtrip byte equality rejects duplicate keys, trailing data, alternate
   // escapes and unreviewed whitespace before semantic comparison occurs.
   need(payload.equals(Buffer.from(JSON.stringify(provider,null,2)+'\n')),'TRANSFORM_SERIALIZATION_OR_DUPLICATE_KEYS');
   additions=compare(source,provider,rule).sort();need(same(additions,rule.additions),'TRANSFORM_ADDITIONS_CHANGED');
   stored=Buffer.from(JSON.stringify(provider).replaceAll('/','\\/'));
   need(stored.length===rule.storedBytes&&sha(stored)===rule.storedSha256&&md5(stored)===rule.storedMd5&&sha(payload)===rule.payloadSha256,'TRANSFORM_REVIEWED_BYTES_CHANGED');
   transformed=true;representation='shopify_exact_reviewed_template_transform';
  }
 }
 need(Number.isSafeInteger(size)&&size===stored.length&&(providerMd5===md5(stored)||(representation==='exact_source_bytes'&&providerMd5===null)),'PROVIDER_STORED_METADATA_MISMATCH');
 return {file:filename,representation,sourceFileBytes:sourceBytes.length,sourceFileSha256:sourceSha,sourceFileMd5:sourceMd5,returnedBodyBytes:rawBytes.length,returnedBodySha256:sha(rawBytes),returnedBodyMd5:md5(rawBytes),providerPayloadBytes:payload.length,providerPayloadSha256:sha(payload),verifiedStoredBytes:stored.length,verifiedStoredSha256:sha(stored),providerStoredBytes:size,providerChecksumMd5:providerMd5,envelopePrefixBytes:prefix?.length??0,envelopePrefixSha256:prefix?sha(prefix):null,rawBodyEqualsSource:rawBytes.equals(sourceBytes),sourcePayloadByteEquality:payload.equals(sourceBytes),narrowProviderTransformationApplied:transformed,reviewedEmptySettingsAdditions:additions,sourceValuesTypesArraysPreserved:true,generalNormalizationAccepted:false};
}
