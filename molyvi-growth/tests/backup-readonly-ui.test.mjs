import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const sources=Object.fromEntries(await Promise.all(['customer','workspace'].map(async name=>[name,await fs.readFile(new URL('../public/workspace/'+name+'.js',import.meta.url),'utf8')])));
function harness(kind){
  const nodes=[],ids=new Map(),calls=[],navigations=[];
  class Element{
    constructor(tag,id){this.tagName=tag.toUpperCase();this.attributes=new Map();this.children=[];this.listeners=new Map();this.hidden=false;this.disabled=false;this.value='';this.isConnected=true;this.open=false;this.textContent='';this.classList={toggle(){}};nodes.push(this);if(id)this.setAttribute('id',id);}
    get id(){return this.getAttribute('id')??'';}
    setAttribute(key,value){this.attributes.set(key,String(value));if(key==='id')ids.set(String(value),this);}
    getAttribute(key){return this.attributes.get(key)??null;}
    hasAttribute(key){return this.attributes.has(key);}
    removeAttribute(key){this.attributes.delete(key);}
    append(...children){this.children.push(...children);}
    prepend(...children){this.children.unshift(...children);}
    replaceChildren(...children){for(const child of this.children)child.isConnected=false;this.children=[...children];}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
    async emit(type){for(const fn of this.listeners.get(type)??[])await fn({preventDefault(){}});}
    reportValidity(){return true;}
  }
  const main=new Element('main'),body=new Element('body');
  const element=(tag,id)=>new Element(tag,id);
  const get=id=>ids.get(id)??(id==='backup-readonly-notice'?null:element('div',id));
  const document={body,getElementById:get,createElement:tag=>element(tag),querySelector:selector=>selector==='main'?main:null,querySelectorAll(selector){const tags=selector.split(',').map(x=>x.toUpperCase());return nodes.filter(n=>n.isConnected&&tags.includes(n.tagName));}};
  const sandbox={document,Intl,structuredClone,console,setInterval(){},location:{assign:value=>navigations.push(value)},fetch:async(...args)=>{calls.push(args);return new Promise(()=>{});}};
  const context=vm.createContext(sandbox);vm.runInContext(sources[kind],context);
  calls.length=0;
  return {context,sandbox,element,get,nodes,calls,navigations,run:code=>vm.runInContext(code,context)};
}
for(const kind of ['customer','workspace']){
  test(kind+' read-only controls preserve drafts, prior disabled state and file links across recovery',()=>{
    const h=harness(kind),input=h.element('textarea','draft'),locked=h.element('input','already-locked'),button=h.element('button','mutation'),link=h.element('a','download'),image=h.element('img','product-image');
    input.value='Αυτό το κείμενο δεν έχει αποθηκευτεί';locked.disabled=true;link.setAttribute('href','/customer-files/id/all.zip');image.setAttribute('src','/api/generated-photo/id');
    h.run('setBackupReadOnly(true)');
    assert.equal(input.disabled,true);assert.equal(locked.disabled,true);assert.equal(button.disabled,true);assert.equal(link.getAttribute('href'),null);assert.equal(image.getAttribute('src'),null);assert.equal(image.hidden,true);
    assert.equal(h.get('backup-readonly-notice').hidden,false);assert.match(h.get('backup-readonly-notice').textContent,/μην την ανανεώσεις/);
    h.run('setBackupReadOnly(false)');
    assert.equal(input.disabled,false);assert.equal(locked.disabled,true);assert.equal(button.disabled,false);assert.equal(input.value,'Αυτό το κείμενο δεν έχει αποθηκευτεί');
    assert.equal(link.getAttribute('href'),'/customer-files/id/all.zip');assert.equal(image.getAttribute('src'),'/api/generated-photo/id');assert.equal(image.hidden,false);assert.deepEqual(h.navigations,[]);
  });
  test(kind+' read-only API blocks mutations and excluded reads before fetch; a backup response enters limited mode',async()=>{
    const h=harness(kind);h.run('setBackupReadOnly(true)');
    for(const call of ['api("/api/customer/select",{})','api("/api/task",{action:"save"})','api("/api/content-preview")']){
      await assert.rejects(h.run(call),e=>e.code==='BACKUP_RESOURCES_IN_PROGRESS');
    }
    assert.equal(h.calls.length,0);
    h.sandbox.fetch=async(url,options)=>{h.calls.push([url,options]);return {ok:true,json:async()=>({backupReadOnly:true})};};
    await h.run('api("/api/customer/me")');assert.equal(h.calls.length,1);assert.equal(h.run('backupReadOnly'),true);
    h.run('setBackupReadOnly(false)');h.sandbox.fetch=async()=>({ok:false,json:async()=>({error:'BACKUP_SNAPSHOT_IN_PROGRESS'})});
    await assert.rejects(h.run('api("/api/customer/me")'),e=>e.code==='BACKUP_RESOURCES_IN_PROGRESS');assert.equal(h.run('backupReadOnly'),true);assert.deepEqual(h.navigations,[]);
  });
}
test('customer opens only its already-selected project without POST and preserves a feedback draft during polling',async()=>{
  const h=harness('customer');
  h.sandbox.fixtureAccount={account:{name:'Δοκιμή'},selectedProjectId:'selected',projects:[{id:'selected',label:'Έργο Α',orderId:'A',deliveries:[]},{id:'other',label:'Έργο Β',orderId:'B',deliveries:[]}]};
  h.run('account=fixtureAccount;setBackupReadOnly(true);render()');
  const buttons=h.nodes.filter(n=>n.hasAttribute('data-backup-project')),selected=buttons.find(n=>n.getAttribute('data-backup-project')==='selected'),other=buttons.find(n=>n!==selected);
  assert.equal(selected.disabled,false);assert.equal(other.disabled,true);
  await selected.emit('click');assert.deepEqual(h.navigations,['/workspace/']);assert.equal(h.calls.length,0);
  await other.emit('click');assert.deepEqual(h.navigations,['/workspace/']);assert.equal(h.calls.length,0);
  const draft=h.element('textarea','feedback-draft');draft.value='Ανοιχτή παρατήρηση';
  h.sandbox.fetch=async(url)=>{h.calls.push([url]);return {ok:true,json:async()=>({backupReadOnly:true,selectedProjectId:'selected'})};};
  const card=h.get('projects').children[0];await h.run('refreshBackupState()');
  assert.equal(h.get('projects').children[0],card);assert.equal(draft.value,'Ανοιχτή παρατήρηση');assert.equal(h.calls.length,1);
});
test('unauthenticated customer recovers login automatically through bounded public config without losing typed values',async()=>{
  const h=harness('customer'),email=h.element('input','email'),login=h.element('button','login-submit');email.value='typed@example.invalid';
  h.run('setBackupReadOnly(true)');assert.equal(login.disabled,true);
  h.sandbox.fetch=async(url)=>{h.calls.push([url]);return {ok:true,json:async()=>({customerCodeRequests:true,realEmailEnabled:true})};};
  await h.run('refreshBackupState()');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/api/service-config');assert.equal(h.run('backupReadOnly'),false);assert.equal(login.disabled,false);assert.equal(email.value,'typed@example.invalid');assert.equal(h.get('request-code').hidden,false);assert.deepEqual(h.navigations,[]);
});
test('workspace backup refresh preserves dirty state and inputs without rendering, readiness or navigation',async()=>{
  const h=harness('workspace'),input=h.element('input','field-story'),nav=h.element('button','nav');
  input.value='Το μη αποθηκευμένο κείμενό μου';nav.setAttribute('data-backup-navigation','');
  h.sandbox.before={id:'project',tasks:[{id:'business',draft:{story:'local'}}]};h.sandbox.renderCalls=0;h.sandbox.readinessCalls=0;
  h.sandbox.MolyviBasicPreparation={refresh(){h.sandbox.readinessCalls++;}};
  h.run('workspace=before;dirty=true;render=()=>renderCalls++;');
  h.sandbox.fetch=async()=>({ok:true,json:async()=>({id:'project',backupReadOnly:true,tasks:[{id:'business',draft:{story:'server'}}]})});
  await h.run('refresh()');
  assert.equal(h.run('workspace===before'),true);assert.equal(h.run('dirty'),true);assert.equal(input.value,'Το μη αποθηκευμένο κείμενό μου');assert.equal(input.disabled,true);assert.equal(nav.disabled,true);
  assert.equal(h.sandbox.renderCalls,0);assert.equal(h.sandbox.readinessCalls,0);assert.deepEqual(h.navigations,[]);
  h.run('dirty=false;applyBackupReadOnly()');assert.equal(nav.disabled,false);
});
test('workspace snapshot refusal during session bootstrap never redirects or clears existing drafts',async()=>{
  const h=harness('workspace'),input=h.element('input','field-story');input.value='Να παραμείνει';
  h.sandbox.fetch=async url=>url==='/api/service-config'?{ok:true,json:async()=>({customerAccess:true,backupReadOnly:true})}:{ok:false,json:async()=>({error:'BACKUP_SNAPSHOT_IN_PROGRESS'})};
  await h.run('initialize()');assert.deepEqual(h.navigations,[]);assert.equal(input.value,'Να παραμείνει');assert.equal(input.disabled,true);assert.equal(h.run('backupReadOnly'),true);
});
