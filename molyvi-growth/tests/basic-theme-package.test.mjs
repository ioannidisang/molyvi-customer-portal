import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {WORKSPACE_ROOT,canonicalJson} from '../lib/intake-store.mjs';
import {prepareBasicStorePackage,createBasicAssemblyBinding} from '../lib/basic-store-package.mjs';
import {buildBasicThemePackage} from '../lib/basic-theme-package.mjs';
import {buildServiceThemePackage} from '../lib/service-theme-package.mjs';
import {createBasicAssemblyFixture} from './helpers/basic-assembly-fixture.mjs';
import {validateThemeSettings} from '../../forma-production-kit/scripts/apply-brief.mjs';

const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sign=plan=>{const {planHash,...unsigned}=plan;return {...unsigned,planHash:hash(canonicalJson(unsigned))};};
function preparedFixture(settings={}){
  const fixture=createBasicAssemblyFixture(settings),binding=createBasicAssemblyBinding(fixture.record,{targetStore:fixture.options.targetStore});
  return prepareBasicStorePackage(fixture.record,{...fixture.options,binding});
}
async function output(t){
  const root=path.join(WORKSPACE_ROOT,'briefs'),directory=await fs.mkdtemp(path.join(root,'_basic-theme-test-'));
  t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(root));await fs.rm(real,{recursive:true});});return directory;
}
const read=(result,file)=>fs.readFile(path.join(result.themeDirectory,file),'utf8');

test('one-product Basic and color-unit Basic build neutral brand themes with exact selected assets and actual dynamic counts',async t=>{
  const parent=await output(t);
  for(const [name,settings]of [['one',{productCount:1}],['colors',{withColorUnits:true,sizeProductCount:2}]]){
    const prepared=preparedFixture(settings),before=canonicalJson(prepared.plan),result=await buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,name)});
    assert.equal(canonicalJson(prepared.plan),before);assert.deepEqual(result.manifest.resources.counts,prepared.plan.counts);
    const index=JSON.parse(await read(result,'templates/index.json')),config=JSON.parse(await read(result,'config/settings_data.json'));
    assert.equal(config.current.forma_brand_name,prepared.plan.branding.brandName);assert.equal(config.current.forma_demo_mode,true);
    assert.equal(index.sections.forma_hero.settings.heading,prepared.plan.branding.brandName);assert.equal(index.sections.featured_collection.settings.collection,prepared.plan.namespace);
    assert.equal(index.sections.forma_note,undefined);assert(!index.order.includes('forma_note'));
    assert(!JSON.stringify(index).includes('STILL'));assert(!JSON.stringify(index).includes('εικονικ'));assert(!JSON.stringify(index).includes('Κοσμήματα'));
    const hero=prepared.plan.products[0].photos.find(photo=>photo.role==='lifestyle')??prepared.plan.products[0].photos[0];
    assert.equal(result.manifest.hero.sourceFile,hero.fileName);assert.equal(hash(await fs.readFile(path.join(result.themeDirectory,result.manifest.hero.file))),hero.sha256);
    const nav=await read(result,'snippets/molyvi-basic-navigation.liquid');for(const page of prepared.plan.pages)assert(nav.includes(`/pages/${page.handle}`));
    assert((await read(result,'layout/theme.liquid')).includes('noindex, nofollow'));assert((await read(result,'sections/footer.liquid')).includes("'molyvi_basic.signature' | t"));
    const locale=JSON.parse(await read(result,'locales/el.json'));assert.equal(locale.molyvi_basic.signature,'Δημιουργία καταστήματος από τη Molyvi');assert(!locale.forma.demo_notice.includes('Ενδεικτικά προϊόντα'));
    assert.equal(result.manifest.applicationAuthorized,false);assert.equal(result.manifest.publicationAuthorized,false);assert.equal(result.manifest.resources.nativeSettingsApplied,false);assert.equal(result.manifest.customerAcceptance,'PENDING');
    for(const file of ['sections/header.liquid','sections/footer.liquid','layout/theme.liquid','snippets/meta-tags.liquid'])assert(!(await read(result,file)).includes('shop.name'),file);
    const archive=await JSZip.loadAsync(await fs.readFile(result.zipPath));assert.equal(archive.file('workspace.json'),null);assert.equal(archive.file('package-plan.json'),null);assert.equal(archive.file('upstream.json'),null);assert.equal(archive.file('.theme-check.yml'),null);assert(archive.file('LICENSE.md'));
    assert.equal(hash(await fs.readFile(result.zipPath)),result.zipSha256);for(const file of result.manifest.files)assert.equal(hash(await fs.readFile(path.join(result.themeDirectory,file.file))),file.sha256,file.file);
  }
});

test('theme preserves brand text as data and snapshots inputs before asynchronous writes',async t=>{
  const parent=await output(t),brandName='Brand & <script>alert(1)</script> {{ shop.name }}',prepared=preparedFixture({productCount:1,brandName}),before=JSON.parse(JSON.stringify(prepared.plan));
  const running=buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,'escaped')});
  prepared.plan.branding.brandName='changed while building';prepared.uploads[0].bytes.fill(0);
  const result=await running,config=JSON.parse(await read(result,'config/settings_data.json'));
  assert.equal(config.current.forma_brand_name,brandName);assert.equal(config.current.brand_description,'<p>Brand &amp; &lt;script&gt;alert(1)&lt;/script&gt; {{ shop.name }}</p>');
  assert.equal(result.manifest.planHash,before.planHash);
  assert((await read(result,'sections/header.liquid')).includes('settings.forma_brand_name | default: settings.forma_brand_name | escape'));
  assert((await read(result,'sections/footer.liquid')).includes('settings.forma_brand_name | escape | link_to:'));
  assert(!(await read(result,'snippets/molyvi-basic-navigation.liquid')).includes('alert(1)'));
});

test('separate generic path does not weaken QA guards; tampered/re-signed unsafe flags, namespace, media or page scopes fail before writing',async t=>{
  const parent=await output(t),valid=preparedFixture({productCount:1});
  await assert.rejects(buildServiceThemePackage(valid,{outputDirectory:path.join(parent,'legacy')}),{code:'SERVICE_THEME_PLAN_INVALID'});
  const changes=[p=>p.plan.branding.brandName='changed',p=>{p.plan.publicationAuthorized=true;p.plan=sign(p.plan);},p=>{p.plan.namespace="injection' }}";p.plan=sign(p.plan);},p=>p.uploads[0].bytes=Buffer.from('changed'),p=>p.uploads.pop(),p=>{p.plan.pages[0].handle='other-project';p.plan=sign(p.plan);}];
  for(const [index,change]of changes.entries()){
    const prepared=preparedFixture({productCount:1});change(prepared);const destination=path.join(parent,`bad-${index}`);
    await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:destination}));await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  }
});

test('deterministic ZIP, pinned source license, create-only private paths and preserved partial output',async t=>{
  const parent=await output(t),prepared=preparedFixture({productCount:1}),first=await buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,'first')}),second=await buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,'second')});
  assert.equal(first.zipSha256,second.zipSha256);assert.equal(first.manifestSha256,second.manifestSha256);
  assert.equal(await read(first,'LICENSE.md'),await fs.readFile(path.join(WORKSPACE_ROOT,'forma-production-kit/theme/LICENSE.md'),'utf8'));
  await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:first.directory}),{code:'BASIC_THEME_OUTPUT_EXISTS'});
  const partial=path.join(parent,'partial');await fs.mkdir(partial);await fs.writeFile(path.join(partial,'evidence.txt'),'keep');
  await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:partial}),{code:'BASIC_THEME_OUTPUT_EXISTS'});assert.equal(await fs.readFile(path.join(partial,'evidence.txt'),'utf8'),'keep');
  await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:path.join(WORKSPACE_ROOT,'public-basic-forbidden')}),{code:'BASIC_THEME_PRIVATE_OUTPUT_REQUIRED'});
  await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,'..','..','public-basic-forbidden')}),{code:'BASIC_THEME_PRIVATE_OUTPUT_REQUIRED'});
  const upstream=JSON.parse(await fs.readFile(path.join(WORKSPACE_ROOT,'forma-production-kit/upstream.json'),'utf8'));upstream.licenseSha256='0'.repeat(64);const altered=path.join(parent,'upstream.json');await fs.writeFile(altered,JSON.stringify(upstream));
  const destination=path.join(parent,'bad-license');await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:destination,upstreamPath:altered}),{code:'BASIC_THEME_LICENSE_INVALID'});await assert.rejects(fs.stat(destination),{code:'ENOENT'});
});

test('linked output parent cannot escape the private tree',async t=>{
  const parent=await output(t),prepared=preparedFixture({productCount:1}),link=path.join(parent,'linked');
  try{await fs.symlink(WORKSPACE_ROOT,link,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Host does not allow filesystem link creation');return;}throw error;}
  await assert.rejects(buildBasicThemePackage(prepared,{outputDirectory:path.join(link,'outside-output')}),{code:'BASIC_THEME_UNSAFE_DIRECTORY'});
});

test('compact hosted output writes only ZIP and manifest with identical validated bytes and provenance',async t=>{
  const parent=await output(t),prepared=preparedFixture({productCount:1}),expanded=await buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,'expanded')}),compact=await buildBasicThemePackage(prepared,{outputDirectory:path.join(parent,'compact'),compact:true});
  assert.equal(compact.themeDirectory,null);assert.deepEqual((await fs.readdir(compact.directory)).sort(),['MOLYVI_Basic_Draft.zip','manifest.json']);
  assert.equal(compact.zipSha256,expanded.zipSha256);assert.equal(compact.manifestSha256,expanded.manifestSha256);assert.deepEqual(compact.manifest,expanded.manifest);
  assert.deepEqual(await fs.readFile(compact.zipPath),await fs.readFile(expanded.zipPath));
  const fileMap=new Map(await Promise.all(expanded.manifest.files.map(async file=>[file.file,await fs.readFile(path.join(expanded.themeDirectory,...file.file.split('/')))])));
  await validateThemeSettings(null,undefined,{fileMap});
  await assert.rejects(validateThemeSettings(null,undefined,{fileMap:new Map([...fileMap].filter(([name])=>!name.startsWith('sections/')))}),/missing in-memory directory/);
  const collision=new Map(fileMap);collision.set('config',Buffer.from('file instead of directory'));await assert.rejects(validateThemeSettings(null,undefined,{fileMap:collision}),/conflicting in-memory file/);
  const data=JSON.parse(fileMap.get('config/settings_data.json')),schema=JSON.parse(fileMap.get('config/settings_schema.json')),range=schema.flatMap(group=>group.settings??[]).find(setting=>setting.type==='range');
  assert(range);data.current[range.id]=range.max+1;fileMap.set('config/settings_data.json',Buffer.from(JSON.stringify(data)));await fs.writeFile(path.join(expanded.themeDirectory,'config/settings_data.json'),JSON.stringify(data));
  await assert.rejects(validateThemeSettings(null,undefined,{fileMap}),/THEME_SETTINGS_INVALID/);await assert.rejects(validateThemeSettings(expanded.themeDirectory),/THEME_SETTINGS_INVALID/);
  fileMap.set('../outside',Buffer.from('not read'));await assert.rejects(validateThemeSettings(null,undefined,{fileMap}),/invalid in-memory file map/);
});
