import {canonicalJson,IntakeError} from './intake-store.mjs';
import crypto from 'node:crypto';
const sha=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=code=>{throw new IntakeError(code,422);};
const luminance=hex=>{const values=hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return values[0]*.2126+values[1]*.7152+values[2]*.0722;};
const ink=hex=>luminance(hex)>.179?'#000000':'#ffffff';
const fonts={minimal:'system-ui, sans-serif',elegant:'Georgia, serif',natural:'Georgia, serif',retro:'Georgia, serif',futuristic:'system-ui, sans-serif',playful:'system-ui, sans-serif',other:'system-ui, sans-serif'};
export function brandPresentation(record){
  const task=record.tasks.branding,submission=task?.submission,business=record.tasks.business,job=business?.submission&&record.jobs[`${business.submission.hash}:work`];
  if(!submission||job?.status!=='succeeded')fail('BRAND_DEPENDENCY_PENDING');
  const answers=submission.answers;if(answers.logoMode==='create')fail('BRAND_CREATION_PENDING');
  const asset=answers.logoMode==='existing'?record.brandAssets?.[answers.logoReference]:null;if(answers.logoMode==='existing'&&!asset)fail('LOGO_UPLOAD_REQUIRED');
  if(!['text','existing'].includes(answers.logoMode)||!Object.values({primary:answers.primary,secondary:answers.secondary,accent:answers.accent}).every(value=>/^#[a-f\d]{6}$/i.test(value)))fail('BRAND_PALETTE_PENDING');
  return {delivery:'brand_presentation',version:1,brandName:business.submission.answers.name,logoMode:answers.logoMode,logoAssetId:asset?.id??null,logoSha256:asset?.sha256??null,
    style:answers.style,styleNotes:[answers.styleNotes,answers.styleOther].filter(Boolean).join('\n'),fontFamily:fonts[answers.style]??fonts.minimal,
    palette:{source:answers.palette==='from_logo'?'logo_proposal':answers.palette==='custom'?'customer':'preset_proposal',primary:answers.primary,secondary:answers.secondary,accent:answers.accent},
    readable:{onPrimary:ink(answers.primary),onSecondary:ink(answers.secondary),onAccent:ink(answers.accent)},
    businessResultHash:job.result.hash,submissionHash:submission.hash,approvalRequired:true,storeApplied:false};
}
export function approvedBrandPresentation(record){
  const task=record.tasks.branding;if(!task?.submission)return null;
  const job=record.jobs[`${task.submission.hash}:work`];if(job?.status!=='succeeded'||job.result?.output.delivery!=='brand_presentation'||task.approvedHash!==job.result.hash)return null;
  const current=brandPresentation(record);if(sha(current)!==job.result.hash)fail('BRAND_RESULT_STALE');return structuredClone(job.result.output);
}
