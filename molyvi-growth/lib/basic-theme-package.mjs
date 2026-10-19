import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {verifyBasicStorePackage} from './basic-store-package.mjs';
import {validateThemeSettings} from '../../forma-production-kit/scripts/apply-brief.mjs';

const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url)),JSZip=require('jszip');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const digest=value=>hash(canonicalJson(value));
const json=value=>JSON.stringify(value,null,2)+'\n';
const fail=code=>{throw new IntakeError(code,422);};
const folders=new Set(['assets','config','layout','locales','sections','snippets','templates','blocks']);
const pageIds=['terms','privacy','returns','shipping','about','contact','faq'];
const sourceDefault=path.join(WORKSPACE_ROOT,'forma-production-kit/theme');
const within=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const labels={collection:'Η συλλογή',about:'Σχετικά με εμάς',contact:'Επικοινωνία',faq:'Συχνές ερωτήσεις',terms:'Όροι χρήσης',privacy:'Απόρρητο',returns:'Επιστροφές και αλλαγές',shipping:'Αποστολές και παράδοση',navigation:'Πλοήγηση καταστήματος',notice:'Ιδιωτική προεπισκόπηση καταστήματος — δεν έχει δημοσιευτεί. Εκκρεμούν οι τελικοί έλεγχοι και οι ρυθμίσεις λειτουργίας.',signature:'Δημιουργία καταστήματος από τη Molyvi'};

async function checkedDirectory(directory){
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const info=await fs.lstat(current);
    if(info.isSymbolicLink()||!info.isDirectory())fail('BASIC_THEME_UNSAFE_DIRECTORY');
  }
  return absolute;
}
async function destinationFor(outputDirectory,source){
  if(typeof outputDirectory!=='string'||!outputDirectory||/[\x00-\x1f]/.test(outputDirectory))fail('BASIC_THEME_OUTPUT_REQUIRED');
  const destination=path.resolve(outputDirectory),roots=['briefs','customer-materials'].map(folder=>path.join(WORKSPACE_ROOT,folder));
  if(!roots.some(root=>destination!==root&&within(root,destination)))fail('BASIC_THEME_PRIVATE_OUTPUT_REQUIRED');
  if(within(source,destination)||within(destination,source))fail('BASIC_THEME_UNSAFE_OUTPUT');
  await checkedDirectory(path.dirname(destination));
  try{await fs.lstat(destination);fail('BASIC_THEME_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  return destination;
}
async function tree(directory,prefix=''){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isSymbolicLink())fail('BASIC_THEME_SYMLINK');
    if(entry.isDirectory())files.push(...await tree(path.join(directory,entry.name),file));
    else if(entry.isFile())files.push({file,bytes:await fs.readFile(path.join(directory,entry.name))});
    else fail('BASIC_THEME_NONREGULAR_FILE');
  }
  return files.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
}
const records=files=>files.map(({file,bytes})=>({file,bytes:bytes.length,sha256:hash(bytes)}));
function navigation(plan){
  const header=[['collection',`{{ routes.collections_url }}/${plan.namespace}`],['about',`/pages/${plan.namespace}-about`],['contact',`/pages/${plan.namespace}-contact`]],footer=pageIds.map(id=>[id,`/pages/${plan.namespace}-${id}`]);
  const links=items=>items.map(([label,url])=>`    <li><a href="${url}" class="link link--text focus-inset">{{ 'molyvi_basic.${label}' | t }}</a></li>`).join('\n');
  return `{% doc %}\nRenders the collection and informational pages of one private Basic package.\n@param {string} position - Header or footer navigation.\n{% enddoc %}\n<nav class="molyvi-basic-nav molyvi-basic-nav--{{ position | escape }} page-width" aria-label="{{ 'molyvi_basic.navigation' | t }}">\n  <ul role="list">\n  {% if position == 'footer' %}\n${links(footer)}\n  {% else %}\n${links(header)}\n  {% endif %}\n  </ul>\n</nav>\n`;
}
function scheme(background,text,button,label){return {settings:{background,background_gradient:'',text,button,button_label:label,secondary_button_label:text,shadow:text}};}
function textOn(color){const rgb=color.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#000000':'#ffffff';}
function replaceRequired(value,from,to){if(!value.includes(from))fail('BASIC_THEME_SOURCE_LAYOUT_CHANGED');return value.replace(from,to);}

// Private create-only projection, independent of the historical QA theme path.
// A bound target is metadata; no Shopify action, customer approval or publication
// is authorized by generating this archive. Its source remains unchanged.
export async function buildBasicThemePackage(prepared,{outputDirectory,themeSource=sourceDefault,upstreamPath=path.resolve(themeSource,'../upstream.json'),compact=false}={}){
  if(typeof compact!=='boolean')fail('BASIC_THEME_COMPACT_INVALID');
  verifyBasicStorePackage(prepared);
  // Snapshot before the first await: caller mutation cannot change an in-flight build.
  const snapshot={plan:structuredClone(prepared.plan),uploads:prepared.uploads.map(item=>({...item,bytes:Buffer.from(item.bytes)}))},plan=verifyBasicStorePackage(snapshot);
  if(!/^molyvi-basic-[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(plan.namespace??''))fail('BASIC_THEME_NAMESPACE_INVALID');
  if(!plan.branding?.brandName||!['text','existing'].includes(plan.branding.logoMode)||!Object.values({primary:plan.branding.palette?.primary,secondary:plan.branding.palette?.secondary,accent:plan.branding.palette?.accent}).every(color=>/^#[a-f\d]{6}$/i.test(color??'')))fail('BASIC_THEME_BRAND_INVALID');
  if(pageIds.some(id=>plan.pages.filter(page=>page.documentId===id&&page.handle===`${plan.namespace}-${id}`&&page.isPublished===false).length!==1))fail('BASIC_THEME_RESOURCES_INVALID');
  const source=await checkedDirectory(themeSource),destination=await destinationFor(outputDirectory,source),sourceFiles=await tree(source);
  const upstreamInfo=await fs.lstat(upstreamPath);if(upstreamInfo.isSymbolicLink()||!upstreamInfo.isFile())fail('BASIC_THEME_LICENSE_INVALID');
  const upstreamBytes=await fs.readFile(upstreamPath),upstream=JSON.parse(upstreamBytes),license=sourceFiles.find(file=>file.file==='LICENSE.md');
  if(!license||hash(license.bytes)!==upstream.licenseSha256||upstream.licenseSha256!=='189bbb2c31786bdbaa2c6b02a4cb8f8308e1303b176e0955658a26bc90154034'||upstream.commit!=='258f00f64365e2018ca4c62778a6bf55a5d3cd18')fail('BASIC_THEME_LICENSE_INVALID');
  const files=new Map(sourceFiles.filter(({file})=>file==='LICENSE.md'||file==='.theme-check.yml'||folders.has(file.split('/')[0])).map(({file,bytes})=>[file,bytes]));
  const read=file=>{if(!files.has(file))fail('BASIC_THEME_SOURCE_LAYOUT_CHANGED');return files.get(file).toString('utf8');};
  const set=(file,value)=>files.set(file,Buffer.isBuffer(value)?value:Buffer.from(value));
  const readJson=file=>JSON.parse(read(file));
  const settings=readJson('config/settings_data.json'),current=typeof settings.current==='string'?structuredClone(settings.presets[settings.current]):settings.current;
  const {primary,secondary,accent}=plan.branding.palette;
  Object.assign(current,{forma_brand_name:plan.branding.brandName,brand_headline:plan.branding.brandName,forma_demo_mode:true,logo:'',brand_description:`<p>${escape(plan.branding.brandName)}</p>`,predictive_search_enabled:false,color_schemes:{'scheme-1':scheme(secondary,primary,primary,textOn(primary)),'scheme-2':scheme(secondary,primary,primary,textOn(primary)),'scheme-3':scheme(primary,textOn(primary),secondary,textOn(secondary)),'scheme-4':scheme(accent,textOn(accent),primary,textOn(primary)),'scheme-5':scheme(secondary,primary,accent,textOn(accent))}});
  for(const key of Object.keys(current))if(key.startsWith('social_')&&key.endsWith('_link'))current[key]='';
  settings.current=current;settings.presets={'Molyvi Basic':structuredClone(current)};set('config/settings_data.json',json(settings));
  const header=readJson('sections/header-group.json');header.sections.header.settings.menu='';set('sections/header-group.json',json(header));
  const footer=readJson('sections/footer-group.json');delete footer.sections.footer.blocks.links;footer.sections.footer.block_order=footer.sections.footer.block_order.filter(id=>id!=='links');footer.sections.footer.settings.show_policy=false;set('sections/footer-group.json',json(footer));
  const hero=plan.products[0].photos.find(photo=>photo.role==='lifestyle')??plan.products[0].photos[0],heroUpload=snapshot.uploads.find(upload=>upload.fileName===hero.fileName),heroName=`molyvi-basic-hero${path.extname(hero.fileName)}`;
  const index=readJson('templates/index.json');
  Object.assign(index.sections.forma_hero.settings,{eyebrow:plan.branding.brandName,heading:plan.branding.brandName,text:'<p>Ανακάλυψε τη συλλογή μας.</p>',button_label:labels.collection,link:`shopify://collections/${plan.namespace}`,image:'',image_alt:hero.alt,caption:''});
  Object.assign(index.sections.featured_collection.settings,{collection:plan.namespace,title:labels.collection,description:'',show_description:false,products_to_show:12,image_ratio:'square'});
  // The inherited demo story is not customer content. Remove it instead of
  // fabricating positioning or product categories on the customer's behalf.
  delete index.sections.forma_note;index.order=index.order.filter(id=>id!=='forma_note');set('templates/index.json',json(index));
  const product=readJson('templates/product.json');product.sections['related-products'].disabled=true;set('templates/product.json',json(product));
  set(`assets/${heroName}`,heroUpload.bytes);
  set('sections/forma-editorial-hero.liquid',replaceRequired(read('sections/forma-editorial-hero.liquid'),"'forma-still-hero.webp'",`'${heroName}'`).replace('width="768" height="960"','width="1200" height="1200"').replace('object-fit:cover','object-fit:contain'));
  set('snippets/molyvi-basic-navigation.liquid',navigation(plan));
  let layout=replaceRequired(read('layout/theme.liquid'),"{% sections 'header-group' %}","{% sections 'header-group' %}\n    {% render 'molyvi-basic-navigation', position: 'header' %}");
  layout=replaceRequired(layout,'{{ page_title }}',"{% if request.page_type == 'index' %}{{ settings.forma_brand_name | escape }}{% else %}{{ page_title | escape }}{% endif %}");
  layout=replaceRequired(layout,'{%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}',"{%- if request.page_type != 'index' -%}{%- unless page_title contains settings.forma_brand_name %} &ndash; {{ settings.forma_brand_name | escape }}{% endunless -%}{%- endif -%}");
  layout=replaceRequired(layout,"{{ 'forma.demo_notice' | t }}","{{ 'molyvi_basic.notice' | t }}");set('layout/theme.liquid',layout);
  set('sections/footer.liquid',replaceRequired(read('sections/footer.liquid'),'      <div class="footer__copyright caption">',"      {% render 'molyvi-basic-navigation', position: 'footer' %}\n      <div class=\"footer__copyright caption\">\n        <small class=\"copyright__content\"><a href=\"https://molyvi.com\" rel=\"noopener\">{{ 'molyvi_basic.signature' | t }}</a></small>"));
  set('sections/header.liquid',read('sections/header.liquid').replace(/\s*render 'header-search', input_id: 'Search-In-Modal-1'/g,'').replace(/\s*{% render 'header-search', input_id: 'Search-In-Modal' %}/g,'').replaceAll('if shop.customer_accounts_enabled','if false'));
  if(plan.branding.logoMode==='existing'){
    const logo=snapshot.uploads.find(upload=>upload.fileName===plan.branding.logoFile),name=`molyvi-basic-logo${path.extname(logo.fileName)}`;set(`assets/${name}`,logo.bytes);
    const pattern='<span class="h2">{{ settings.forma_brand_name | default: shop.name | escape }}</span>';
    if(!read('sections/header.liquid').includes(pattern))fail('BASIC_THEME_SOURCE_LAYOUT_CHANGED');
    set('sections/header.liquid',read('sections/header.liquid').replaceAll(pattern,`<img src="{{ '${name}' | asset_url }}" class="molyvi-basic-logo" alt="{{ settings.forma_brand_name | escape }}" width="180" height="90" loading="eager">`));
  }
  for(const [file,bytes]of files){
    if(!file.endsWith('.liquid'))continue;
    let text=bytes.toString('utf8').replaceAll('shop.name','settings.forma_brand_name').replaceAll('routes.all_products_collection_url',`collections['${plan.namespace}'].url`).replaceAll('{{ settings.forma_brand_name }}','{{ settings.forma_brand_name | escape }}').replaceAll('{{ settings.forma_brand_name | link_to:','{{ settings.forma_brand_name | escape | link_to:').replaceAll('{{ settings.brand_headline }}','{{ settings.brand_headline | escape }}');
    if(file==='snippets/meta-tags.liquid')text=text.replace('  assign og_url',"  if request.page_type == 'index'\n    assign og_title = settings.forma_brand_name\n  endif\n  assign og_url").replace('shop.description','settings.brand_description | strip_html');
    set(file,text);
  }
  const css=`\n.molyvi-basic-nav ul{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 24px;list-style:none;padding:14px 0;margin:0}.molyvi-basic-nav a{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;font-size:14px}.molyvi-basic-nav--header{border-bottom:1px solid rgba(var(--color-foreground),.12)}.molyvi-basic-nav--footer{max-width:100%;padding:0}.footer__content-bottom-wrapper:has(.molyvi-basic-nav){flex-direction:column;align-items:center}.molyvi-basic-logo{max-width:180px;height:auto;object-fit:contain}body,h1,h2,h3,h4,h5,h6,.h0,.h1,.h2,.h3{font-family:${plan.branding.fontFamily==='Georgia, serif'?'Georgia, serif':'system-ui, sans-serif'}}@media(max-width:749px){.molyvi-basic-nav ul{gap:0 18px}.molyvi-basic-nav a{font-size:13px}.header__heading-link .h2{font-size:22px;letter-spacing:.02em}}\n`;
  set('assets/forma-still.css',read('assets/forma-still.css')+css);
  for(const name of ['locales/el.json','locales/en.default.json']){const locale=readJson(name);locale.molyvi_basic=labels;locale.forma.demo_notice=labels.notice;set(name,json(locale));}
  const changedFiles=[...files].filter(([file,bytes])=>!sourceFiles.some(original=>original.file===file&&original.bytes.equals(bytes))).map(([file])=>file).sort();
  if(digest(records(await tree(source)))!==digest(records(sourceFiles)))fail('BASIC_THEME_SOURCE_CHANGED');
  await checkedDirectory(path.dirname(destination));await fs.mkdir(destination,{mode:0o700});const themeDirectory=compact?null:path.join(destination,'theme');
  if(compact)await validateThemeSettings(null,undefined,{fileMap:files});
  else{
    await fs.mkdir(themeDirectory,{mode:0o700});
    for(const [file,bytes]of files){const target=path.join(themeDirectory,...file.split('/'));await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});}
    await validateThemeSettings(themeDirectory);
  }
  if(digest(records(await tree(source)))!==digest(records(sourceFiles)))fail('BASIC_THEME_SOURCE_CHANGED');
  const archiveFiles=[...files].filter(([file])=>!file.split('/').some(part=>part.startsWith('.'))).sort(([a],[b])=>a<b?-1:a>b?1:0),zip=new JSZip();
  for(const [file,bytes]of archiveFiles)zip.file(file,bytes,{date:new Date('2000-01-01T00:00:00Z'),createFolders:false,unixPermissions:0o100644});
  const zipBytes=await zip.generateAsync({type:'nodebuffer',platform:'UNIX',compression:'DEFLATE',compressionOptions:{level:6}}),zipName='MOLYVI_Basic_Draft.zip',zipPath=path.join(destination,zipName);
  const manifest={schemaVersion:1,kind:'molyvi_basic_theme_package',planHash:plan.planHash,projectId:plan.projectId,targetStore:plan.targetStore,status:'UNPUBLISHED_NOT_APPLIED',applicationAuthorized:false,publicationAuthorized:false,sourceTheme:{sha256:digest(records(sourceFiles)),files:sourceFiles.length},upstream:{commit:upstream.commit,license:upstream.license,licenseSha256:upstream.licenseSha256,recordSha256:hash(upstreamBytes)},resources:{collectionHandle:plan.namespace,counts:plan.counts,pages:plan.pages.map(({documentId,handle})=>({documentId,handle})),nativeSettingsApplied:false},hero:{file:`assets/${heroName}`,sourceFile:hero.fileName,sha256:hero.sha256},molyviSignatureIncluded:true,changedFiles,files:records([...files].map(([file,bytes])=>({file,bytes})).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0)),zip:{file:zipName,bytes:zipBytes.length,sha256:hash(zipBytes)},customerAcceptance:'PENDING',legalCertification:false};
  const manifestBytes=Buffer.from(json(manifest));await fs.writeFile(zipPath,zipBytes,{flag:'wx',mode:0o600});await fs.writeFile(path.join(destination,'manifest.json'),manifestBytes,{flag:'wx',mode:0o600});if(!compact)await fs.writeFile(path.join(destination,'upstream.json'),upstreamBytes,{flag:'wx',mode:0o600});
  return {directory:destination,themeDirectory,zipPath,manifest,manifestSha256:hash(manifestBytes),zipSha256:hash(zipBytes),changedFiles};
}
