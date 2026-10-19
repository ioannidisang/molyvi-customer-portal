import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.textContent='';this.hidden=false;this.checked=false;this.disabled=false;}
  append(...children){this.children.push(...children);} replaceChildren(...children){this.children=children;}
  setAttribute(name,value){this[name]=value;} addEventListener(name,fn){this.listeners[name]=fn;}
}
const source=await fs.readFile(new URL('../public/workspace/basic-preparation.js',import.meta.url),'utf8');
const all=node=>[node,...node.children.flatMap(all)];
function harness(){
  const panel=new Element('section'),sandbox={window:{},document:{getElementById:()=>panel,createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element('#text'),{textContent:text})},Date};
  vm.runInNewContext(source,sandbox);return {panel,client:sandbox.window.MolyviBasicPreparation};
}
const ready=(projectId='a',sourceHash='1'.repeat(64))=>({projectId,sourceHash,readiness:{ready:true,state:'ready_for_preparation',summary:{products:10,photos:30,pages:7},blockers:[]},request:null});
test('a different server-selected project cannot offer confirmation under the visible project',async()=>{
  const h=harness();h.client.configure({enabled:true,api:async()=>ready('b')});await h.client.refresh('a',true);assert.equal(h.panel.hidden,true);assert.equal(all(h.panel).filter(n=>n.tag==='button').length,0);
});
test('explicit checkbox enables one exact-source request and prevents concurrent double click',async()=>{
  const h=harness(),requests=[];let saved=false;
  h.client.configure({enabled:true,api:async(url,payload)=>{if(payload){requests.push({url,payload});saved=true;return {};}return {...ready(),request:saved?{state:'requested',sourceHash:'1'.repeat(64)}:null};}});
  await h.client.refresh('a',true);const checkbox=all(h.panel).find(n=>n.tag==='input'),button=all(h.panel).find(n=>n.tag==='button');assert.equal(button.disabled,true);
  await button.listeners.click();assert.equal(requests.length,0);checkbox.checked=true;checkbox.listeners.change();
  await Promise.all([button.listeners.click(),button.listeners.click()]);assert.equal(requests.length,1);assert.equal(requests[0].payload.acknowledged,true);assert.equal(requests[0].payload.expectedSourceHash,'1'.repeat(64));
  assert.deepEqual(Object.keys(requests[0].payload).sort(),['acknowledged','expectedSourceHash']);assert.equal(all(h.panel).filter(n=>n.tag==='input').length,0);
  assert(!all(h.panel).some(n=>n.textContent.includes('Επιβεβαίωσε ότι ολοκλήρωσες')));
});
test('pending production and stale selection render clear safe text without confirming or trusting markup',async()=>{
  const h=harness();let response={...ready(),readiness:{...ready().readiness,ready:false,state:'production_pending',blockers:[{taskId:'catalog',message:'<script>untrusted</script>'}]}};
  h.client.configure({enabled:true,api:async()=>response,context:()=>({tasks:[{id:'catalog',title:'Προϊόντα'}]})});await h.client.refresh('a',true);
  assert.equal(all(h.panel).filter(n=>n.tag==='button').length,0);assert(all(h.panel).some(n=>n.tag==='li'&&n.textContent==='Προϊόντα: <script>untrusted</script>'));
  response={...ready('a','2'.repeat(64)),request:{state:'source_changed',sourceHash:'1'.repeat(64)}};await h.client.refresh('a',true);assert(all(h.panel).some(n=>n.textContent.includes('Τα στοιχεία άλλαξαν')));assert(all(h.panel).find(n=>n.tag==='button').disabled);
});

test('installation progress distinguishes blocked work from verified unpublished completion',async()=>{
 const h=harness();let stage='installing';h.client.configure({enabled:true,api:async()=>({...ready(),request:{state:'prepared_for_installation_review',sourceHash:'1'.repeat(64)},installation:{stage,published:false}})});
 await h.client.refresh('a',true);assert(all(h.panel).some(n=>n.textContent.includes('Εγκαθιστούμε')));assert(!all(h.panel).some(n=>n.textContent.includes('ολοκληρώθηκαν')));
 stage='blocked';await h.client.refresh('a',true);assert(all(h.panel).some(n=>n.textContent.includes('σταμάτησε για έλεγχο')));
 stage='installed_draft';await h.client.refresh('a',true);assert(all(h.panel).some(n=>n.textContent.includes('δεν έχει δημοσιευτεί')));assert.equal(all(h.panel).filter(n=>n.tag==='button').length,0);
});
