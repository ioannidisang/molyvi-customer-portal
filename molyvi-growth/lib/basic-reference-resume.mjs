import fs from 'node:fs/promises';import crypto from 'node:crypto';import {canonicalJson,IntakeError} from './intake-store.mjs';const hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');const need=(v)=>{if(!v)throw new IntakeError('BASIC_REFERENCE_RESUME_REVIEW_MISMATCH',409);};
export async function validateReviewedReferenceResume({root,state,review,confirmation,binding,limits,now=Date.now()}){
 if(review?.kind==='molyvi_reviewed_undispatched_variant_resume_v1')return validateUndispatched({root,state,review,confirmation,binding,limits,now});
 need(review?.kind==='molyvi_reviewed_first_catalog_reconciliation_v1'&&review.intentHash===state.intentHash&&review.journalHead===state.head&&review.eventCount===1&&state.eventCount===1&&review.sourceHash===confirmation.sourceHash&&state.intent.registryDirectory&&review.key===state.intent.steps[0].key&&state.intent.steps[0].kind==='catalog'&&/^[1-9][0-9]*$/.test(review.remoteId??'')&&/^[a-f0-9]{64}$/.test(review.observedProductSha256??''));
 need(state.steps[review.key]?.status==='claimed_outcome_unknown'&&state.steps[review.key].attemptId===review.attemptId&&Object.entries(state.steps).every(([k,s])=>k===review.key||s.status==='pending'));
 need(Array.isArray(review.bridgeEvents)&&review.bridgeEvents.length>0&&review.bridgeEvents.length<=10);
 const names=await fs.readdir(root),expected=['binding.json',...review.bridgeEvents.map((_,i)=>String(i+1).padStart(6,'0')+'.json')];need(canonicalJson(names.sort())===canonicalJson(expected.sort()));
 const read=async(name,pin)=>{const f=root+'/'+name,s=await fs.lstat(f);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=256*1024);const raw=await fs.readFile(f);need(sha(raw)===pin);return JSON.parse(raw);};
 const previous=await read('binding.json',review.bridgeBindingSha256);need(canonicalJson(previous.confirmation)===canonicalJson(confirmation)&&canonicalJson(previous.binding)===canonicalJson(binding)&&canonicalJson(previous.limits)===canonicalJson(limits)&&previous.publicationAuthorized===false&&previous.newChargesAuthorized===false);
 let head=hash(confirmation),counters={graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0};
 for(let i=0;i<review.bridgeEvents.length;i++){const e=await read(String(i+1).padStart(6,'0')+'.json',review.bridgeEvents[i]);const{eventHash,...body}=e;need(e.sequence===i+1&&e.previousHash===head&&e.intentHash===state.intentHash&&hash(body)===eventHash&&['query','mutation'].includes(e.kind));counters={...counters,graphQLRequests:counters.graphQLRequests+1,mutations:counters.mutations+(e.kind==='mutation'?1:0)};need(canonicalJson(e.counters)===canonicalJson(counters));head=eventHash;}
 need(counters.mutations===1&&counters.stagedUploads===0&&counters.externalRequests===0);
 const started=Date.parse(previous.startedAt),deadline=Date.parse(previous.deadlineAt);need(Number.isFinite(started)&&deadline-started===limits.elapsedMs&&now<deadline&&now>=started);for(const k of Object.keys(counters))need(counters[k]<=limits[k]);
 return {counters,head,sequence:review.bridgeEvents.length,started,deadline,catalogRecovery:{intentHash:state.intentHash,key:review.key,attemptId:review.attemptId,remoteId:review.remoteId}};
}

const undispatchedAuthorities=new WeakSet();
export function permitsUndispatchedReferenceStep(authority,state,key){const ok=undispatchedAuthorities.has(authority)&&authority.intentHash===state.intentHash&&authority.head===state.head&&authority.key===key&&authority.attemptId===state.steps[key]?.attemptId;if(ok)undispatchedAuthorities.delete(authority);return ok;}
async function validateUndispatched({root,state,review,confirmation,binding,limits,now}){
 need(review.intentHash===state.intentHash&&review.journalHead===state.head&&review.eventCount===state.eventCount&&review.sourceHash===confirmation.sourceHash);
 const at=state.intent.steps.findIndex(s=>s.key===review.key);need(at>0&&state.intent.steps[at].kind==='variant_media');
 need(state.steps[review.key].status==='claimed_outcome_unknown'&&state.steps[review.key].attemptId===review.attemptId);
 need(state.intent.steps.every((s,i)=>i===at||state.steps[s.key].status===(i<at?'succeeded':'pending')));
 need(Array.isArray(review.bridgeFiles)&&review.bridgeFiles.length<1000&&review.bridgeFiles.every(p=>/^(?:binding|reviewed-resume|readback-[a-f0-9-]+|[0-9]{6})\.json$/.test(p.name)&&/^[a-f0-9]{64}$/.test(p.sha256)));
 const names=(await fs.readdir(root)).sort();need(canonicalJson(names)===canonicalJson(review.bridgeFiles.map(p=>p.name).sort()));const docs=new Map();
 for(const p of review.bridgeFiles){const f=root+'/'+p.name,s=await fs.lstat(f);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size===p.bytes&&s.size<=256*1024);const raw=await fs.readFile(f);need(sha(raw)===p.sha256);docs.set(p.name,JSON.parse(raw));}
 const previous=docs.get('binding.json');need(canonicalJson(previous.confirmation)===canonicalJson(confirmation)&&canonicalJson(previous.binding)===canonicalJson(binding)&&canonicalJson(previous.limits)===canonicalJson(limits)&&previous.publicationAuthorized===false&&previous.newChargesAuthorized===false);
 const events=names.filter(n=>/^[0-9]{6}\.json$/.test(n));let head=hash(confirmation),counters={graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0};
 for(let i=0;i<events.length;i++){need(events[i]===String(i+1).padStart(6,'0')+'.json');const e=docs.get(events[i]),{eventHash,...body}=e;need(e.sequence===i+1&&e.previousHash===head&&e.intentHash===state.intentHash&&hash(body)===eventHash&&['query','mutation','upload','download'].includes(e.kind));if(['query','mutation'].includes(e.kind))counters.graphQLRequests++;if(e.kind==='mutation')counters.mutations++;if(e.kind==='upload')counters.stagedUploads++;if(['upload','download'].includes(e.kind))counters.externalRequests++;need(canonicalJson(e.counters)===canonicalJson(counters));head=eventHash;}
 const completed=state.intent.steps.slice(0,at);need(completed.every(s=>['catalog','media','variant_media'].includes(s.kind)));
 const expectedMutations=completed.reduce((n,s)=>n+(s.kind==='media'?3:1),0),images=completed.filter(s=>s.kind==='media').length;
 // All reserved mutations belong to already verified steps. The held variant
 // claim has consumed no mutation reservation: its append was never dispatched.
 need(counters.mutations===expectedMutations&&counters.stagedUploads===images&&counters.externalRequests===images*2);
 const started=Date.parse(previous.startedAt),deadline=Date.parse(previous.deadlineAt);need(Number.isFinite(started)&&deadline-started===limits.elapsedMs&&now<deadline&&now>=started);for(const k of Object.keys(counters))need(counters[k]<=limits[k]);
 const authority=Object.freeze({intentHash:state.intentHash,head:state.head,key:review.key,attemptId:review.attemptId});undispatchedAuthorities.add(authority);
 return {counters,head,sequence:events.length,started,deadline,undispatchedAuthority:authority};
}
