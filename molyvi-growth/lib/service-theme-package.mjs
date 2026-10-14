import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {validateThemeSettings} from '../../forma-production-kit/scripts/apply-brief.mjs';

const require=createRequire(new URL('../../forma-production-kit/package.json',import.meta.url));
const JSZip=require('jszip');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const digest=value=>hash(canonicalJson(value));
const json=value=>JSON.stringify(value,null,2)+'\n';
const fail=code=>{throw new IntakeError(code,422);};
const folders=new Set(['assets','config','layout','locales','sections','snippets','templates','blocks']);
const pageIds=['terms','privacy','returns','shipping','about','contact','faq'];
const sourceDefault=path.join(WORKSPACE_ROOT,'forma-production-kit/theme');
const within=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const labels={collection:'Η συλλογή',about:'Σχετικά με εμάς',contact:'Επικοινωνία',faq:'Συχνές ερωτήσεις',terms:'Όροι χρήσης',privacy:'Απόρρητο',returns:'Επιστροφές και αλλαγές',shipping:'Αποστολές και παράδοση',information:'Πληροφορίες',navigation:'Πλοήγηση καταστήματος',notice:'Δοκιμαστικό κατάστημα — εικονικά στοιχεία και τιμές, χωρίς πραγματικές αγορές. Τα κείμενα πολιτικών είναι προσχέδια.',caption:'Επιλεγμένη εικόνα του ίδιου δοκιμαστικού έργου'};

function verifyInput({plan,uploads}={}){
  if(!plan||!Array.isArray(uploads))fail('SERVICE_THEME_INPUT_REQUIRED');
  const {planHash,...unsigned}=plan;
  if(plan.kind!=='molyvi_service_store_package'||planHash!==digest(unsigned)||plan.targetStore!=='molyvi-still-dev.myshopify.com'||plan.status!=='DRAFT'||plan.applicationAuthorized!==false||plan.publicationAuthorized!==false||plan.overwriteExisting!==false||plan.deleteExisting!==false)fail('SERVICE_THEME_PLAN_INVALID');
  if(!/^molyvi-service-\d+-[a-f\d]{8}$/.test(plan.namespace??'')||!plan.branding?.brandName||!['text','existing'].includes(plan.branding.logoMode))fail('SERVICE_THEME_BRAND_INVALID');
  if(!Object.values({primary:plan.branding.palette?.primary,secondary:plan.branding.palette?.secondary,accent:plan.branding.palette?.accent}).every(color=>/^#[a-f\d]{6}$/i.test(color??'')))fail('SERVICE_THEME_BRAND_INVALID');
  if(plan.products?.length!==10||plan.pages?.length!==7||pageIds.some(id=>plan.pages.filter(page=>page.documentId===id&&page.handle===`${plan.namespace}-${id}`&&page.isPublished===false).length!==1))fail('SERVICE_THEME_RESOURCES_INVALID');
  const expected=plan.products.flatMap(product=>product.photos??[]).map(photo=>({fileName:photo.fileName,sha256:photo.sha256}));
  if(expected.length!==30||plan.products.some(product=>!product.handle.startsWith(`${plan.namespace}-`)||product.photos.length!==3))fail('SERVICE_THEME_RESOURCES_INVALID');
  if(plan.branding.logoMode==='existing')expected.push({fileName:plan.branding.logoFile,sha256:plan.branding.logoSha256});
  if(uploads.length!==expected.length||new Set(expected.map(item=>item.fileName)).size!==expected.length)fail('SERVICE_THEME_MEDIA_INVALID');
  for(const expectedFile of expected){
    if(!/^(images|branding)\/[a-zA-Z\d_.-]+\.(png|jpe?g|webp)$/.test(expectedFile.fileName??''))fail('SERVICE_THEME_MEDIA_INVALID');
    const candidates=uploads.filter(upload=>upload.fileName===expectedFile.fileName);
    if(candidates.length!==1||!Buffer.isBuffer(candidates[0].bytes)||candidates[0].sha256!==expectedFile.sha256||hash(candidates[0].bytes)!==expectedFile.sha256)fail('SERVICE_THEME_MEDIA_INVALID');
  }
  return plan;
}

async function tree(directory,prefix=''){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isSymbolicLink())fail('SERVICE_THEME_SYMLINK');
    if(entry.isDirectory())files.push(...await tree(path.join(directory,entry.name),file));
    else if(entry.isFile())files.push({file,bytes:await fs.readFile(path.join(directory,entry.name))});
    else fail('SERVICE_THEME_NONREGULAR_FILE');
  }
  return files.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
}
const records=files=>files.map(({file,bytes})=>({file,bytes:bytes.length,sha256:hash(bytes)}));
function navigation(plan){
  const header=[['collection',`{{ routes.collections_url }}/${plan.namespace}`],['about',`/pages/${plan.namespace}-about`],['contact',`/pages/${plan.namespace}-contact`]];
  const footer=pageIds.map(id=>[id,`/pages/${plan.namespace}-${id}`]);
  const links=items=>items.map(([label,url])=>`    <li><a href="${url}" class="link link--text focus-inset">{{ 'molyvi_service.${label}' | t }}</a></li>`).join('\n');
  return `{% doc %}\nRenders only the collection and pages of this assembled project.\n@param {string} position - Header or footer navigation.\n{% enddoc %}\n<nav class="molyvi-service-nav molyvi-service-nav--{{ position | escape }} page-width" aria-label="{{ 'molyvi_service.navigation' | t }}">\n  <ul role="list">\n  {% if position == 'footer' %}\n${links(footer)}\n  {% else %}\n${links(header)}\n  {% endif %}\n  </ul>\n</nav>\n`;
}
function scheme(background,text,button,label){return {settings:{background,background_gradient:'',text,button,button_label:label,secondary_button_label:text,shadow:text}};}
function textOn(color){const rgb=color.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#000000':'#ffffff';}

// Assembly is a local, create-only projection. It neither authorizes publishing
// nor applies store-wide payment, shipping, merchant or policy settings.
export async function buildServiceThemePackage(prepared,{outputDirectory,themeSource=sourceDefault,upstreamPath=path.resolve(themeSource,'../upstream.json')}={}){
  const plan=verifyInput(prepared);
  if(typeof outputDirectory!=='string'||!outputDirectory)fail('SERVICE_THEME_OUTPUT_REQUIRED');
  const source=await fs.realpath(themeSource),parent=await fs.realpath(path.dirname(path.resolve(outputDirectory))),destination=path.join(parent,path.basename(outputDirectory));
  if(within(source,destination)||within(destination,source))fail('SERVICE_THEME_UNSAFE_OUTPUT');
  const privateRoots=[path.join(WORKSPACE_ROOT,'briefs'),path.join(WORKSPACE_ROOT,'customer-materials')];
  if(!privateRoots.some(root=>within(root,destination)))fail('SERVICE_THEME_PRIVATE_OUTPUT_REQUIRED');
  try{await fs.lstat(destination);fail('SERVICE_THEME_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  const sourceFiles=await tree(source),upstreamBytes=await fs.readFile(upstreamPath),upstream=JSON.parse(upstreamBytes),license=sourceFiles.find(file=>file.file==='LICENSE.md');
  if(!license||hash(license.bytes)!==upstream.licenseSha256||upstream.licenseSha256!=='189bbb2c31786bdbaa2c6b02a4cb8f8308e1303b176e0955658a26bc90154034'||upstream.commit!=='258f00f64365e2018ca4c62778a6bf55a5d3cd18')fail('SERVICE_THEME_LICENSE_INVALID');
  const files=new Map(sourceFiles.filter(({file})=>file==='LICENSE.md'||file==='.theme-check.yml'||folders.has(file.split('/')[0])).map(({file,bytes})=>[file,bytes]));
  const read=file=>files.get(file).toString('utf8');
  const set=(file,value)=>files.set(file,Buffer.isBuffer(value)?value:Buffer.from(value));
  const readJson=file=>JSON.parse(read(file));
  const settings=readJson('config/settings_data.json');
  const current=typeof settings.current==='string'?structuredClone(settings.presets[settings.current]):settings.current;
  const {primary,secondary,accent}=plan.branding.palette;
  Object.assign(current,{forma_brand_name:plan.branding.brandName,brand_headline:plan.branding.brandName,forma_demo_mode:true,logo:'',brand_description:'<p>Δοκιμαστικό κατάστημα Molyvi. Τα προϊόντα, οι τιμές και τα στοιχεία είναι εικονικά.</p>',predictive_search_enabled:false,color_schemes:{'scheme-1':scheme(secondary,primary,primary,textOn(primary)),'scheme-2':scheme(secondary,primary,primary,textOn(primary)),'scheme-3':scheme(primary,textOn(primary),secondary,textOn(secondary)),'scheme-4':scheme(accent,textOn(accent),primary,textOn(primary)),'scheme-5':scheme(secondary,primary,accent,textOn(accent))}});
  for(const key of Object.keys(current))if(key.startsWith('social_')&&key.endsWith('_link'))current[key]='';
  settings.current=current;settings.presets={'FORMA Still':structuredClone(current)};set('config/settings_data.json',json(settings));
  const header=readJson('sections/header-group.json');header.sections.header.settings.menu='';set('sections/header-group.json',json(header));
  const footer=readJson('sections/footer-group.json');delete footer.sections.footer.blocks.links;footer.sections.footer.block_order=footer.sections.footer.block_order.filter(id=>id!=='links');footer.sections.footer.settings.show_policy=false;set('sections/footer-group.json',json(footer));
  const index=readJson('templates/index.json');
  Object.assign(index.sections.forma_hero.settings,{eyebrow:plan.branding.brandName,heading:'Η συλλογή μας, με τη δική της ταυτότητα.',text:'<p>Κοσμήματα, ένδυση και αντικείμενα σπιτιού σε μια ενιαία δοκιμαστική συλλογή.</p>',button_label:labels.collection,link:`shopify://collections/${plan.namespace}`,image_alt:plan.products[0].photos[1].alt,caption:labels.caption});
  Object.assign(index.sections.featured_collection.settings,{collection:plan.namespace,title:'Η δοκιμαστική συλλογή',products_to_show:12,image_ratio:'square'});
  Object.assign(index.sections.forma_note.settings,{label:'ΔΟΚΙΜΗ MOLYVI',heading:'Το ίδιο έργο, από την πρώτη απάντηση στην τελική εικόνα.',text:`<p>${labels.notice}</p>`});set('templates/index.json',json(index));
  const product=readJson('templates/product.json');product.sections['related-products'].disabled=true;set('templates/product.json',json(product));
  const hero=plan.products[0].photos[1],heroUpload=prepared.uploads.find(upload=>upload.fileName===hero.fileName),heroName=`molyvi-service-hero${path.extname(hero.fileName)}`;set(`assets/${heroName}`,heroUpload.bytes);
  set('sections/forma-editorial-hero.liquid',read('sections/forma-editorial-hero.liquid').replace("'forma-still-hero.webp'",`'${heroName}'`).replace('width="768" height="960"','width="1254" height="1254"').replace('object-fit:cover','object-fit:contain'));
  set('snippets/molyvi-service-navigation.liquid',navigation(plan));
  let layout=read('layout/theme.liquid').replace('{% sections \'header-group\' %}',"{% sections 'header-group' %}\n    {% render 'molyvi-service-navigation', position: 'header' %}");
  layout=layout.replace('{{ page_title }}',"{% if request.page_type == 'index' %}{{ settings.forma_brand_name | escape }}{% else %}{{ page_title | escape }}{% endif %}");
  layout=layout.replace('{%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}',"{%- if request.page_type != 'index' -%}{%- unless page_title contains settings.forma_brand_name %} &ndash; {{ settings.forma_brand_name | escape }}{% endunless -%}{%- endif -%}");
  layout=layout.replace("{{ 'forma.demo_notice' | t }}","{{ 'molyvi_service.notice' | t }}");set('layout/theme.liquid',layout);
  set('sections/footer.liquid',read('sections/footer.liquid').replace('      <div class="footer__copyright caption">',"      {% render 'molyvi-service-navigation', position: 'footer' %}\n      <div class=\"footer__copyright caption\">"));
  set('sections/header.liquid',read('sections/header.liquid').replace(/\s*render 'header-search', input_id: 'Search-In-Modal-1'/g,'').replace(/\s*{% render 'header-search', input_id: 'Search-In-Modal' %}/g,'').replaceAll('if shop.customer_accounts_enabled','if false'));
  if(plan.branding.logoMode==='existing'){
    const logo=prepared.uploads.find(upload=>upload.fileName===plan.branding.logoFile),name=`molyvi-service-logo${path.extname(logo.fileName)}`;set(`assets/${name}`,logo.bytes);
    set('sections/header.liquid',read('sections/header.liquid').replaceAll('<span class="h2">{{ settings.forma_brand_name | default: shop.name | escape }}</span>',`<img src="{{ '${name}' | asset_url }}" class="molyvi-service-logo" alt="{{ settings.forma_brand_name | escape }}" width="180" height="90" loading="eager">`));
  }
  for(const [file,bytes]of files){
    if(!file.endsWith('.liquid'))continue;
    let text=bytes.toString('utf8').replaceAll('shop.name','settings.forma_brand_name').replaceAll('routes.all_products_collection_url',`collections['${plan.namespace}'].url`)
      .replaceAll('{{ settings.forma_brand_name }}','{{ settings.forma_brand_name | escape }}')
      .replaceAll('{{ settings.forma_brand_name | link_to:', '{{ settings.forma_brand_name | escape | link_to:')
      .replaceAll('{{ settings.brand_headline }}','{{ settings.brand_headline | escape }}');
    if(file==='snippets/meta-tags.liquid')text=text.replace('  assign og_url',"  if request.page_type == 'index'\n    assign og_title = settings.forma_brand_name\n  endif\n  assign og_url").replace('shop.description','settings.brand_description | strip_html').replace('content="{{ settings.forma_brand_name }}"','content="{{ settings.forma_brand_name | escape }}"');
    set(file,text);
  }
  const css=`\n.molyvi-service-nav ul{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 24px;list-style:none;padding:14px 0;margin:0}.molyvi-service-nav a{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;font-size:14px}.molyvi-service-nav--header{border-bottom:1px solid rgba(var(--color-foreground),.12)}.molyvi-service-nav--footer{max-width:100%;padding:0}.footer__content-bottom-wrapper:has(.molyvi-service-nav){flex-direction:column;align-items:center}.molyvi-service-logo{max-width:180px;height:auto;object-fit:contain}body,h1,h2,h3,h4,h5,h6,.h0,.h1,.h2,.h3{font-family:${plan.branding.fontFamily==='Georgia, serif'?'Georgia, serif':'system-ui, sans-serif'}}@media(max-width:749px){.molyvi-service-nav ul{gap:0 18px}.molyvi-service-nav a{font-size:13px}.header__heading-link .h2{font-size:22px;letter-spacing:.02em}}\n`;
  set('assets/forma-still.css',read('assets/forma-still.css')+css);
  for(const name of ['locales/el.json','locales/en.default.json']){const locale=readJson(name);locale.molyvi_service=labels;set(name,json(locale));}
  const changedFiles=[...files].filter(([file,bytes])=>!sourceFiles.some(original=>original.file===file&&original.bytes.equals(bytes))).map(([file])=>file).sort();
  await fs.mkdir(destination,{mode:0o700});const themeDirectory=path.join(destination,'theme');await fs.mkdir(themeDirectory);
  for(const [file,bytes]of files){const target=path.join(themeDirectory,...file.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
  await validateThemeSettings(themeDirectory);
  if(digest(records(await tree(source)))!==digest(records(sourceFiles)))fail('SERVICE_THEME_SOURCE_CHANGED');
  const archiveFiles=[...files].filter(([file])=>!file.split('/').some(part=>part.startsWith('.'))).sort(([a],[b])=>a<b?-1:a>b?1:0),zip=new JSZip();
  for(const [file,bytes]of archiveFiles)zip.file(file,bytes,{date:new Date('2000-01-01T00:00:00Z'),createFolders:false,unixPermissions:0o100644});
  const zipBytes=await zip.generateAsync({type:'nodebuffer',platform:'UNIX',compression:'DEFLATE',compressionOptions:{level:6}}),zipName='MOLYVI_Service_STILL_Draft.zip',zipPath=path.join(destination,zipName);
  const themeFiles=records([...files].map(([file,bytes])=>({file,bytes})).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0));
  const manifest={schemaVersion:1,kind:'molyvi_service_theme_package',planHash:plan.planHash,projectId:plan.projectId,targetStore:plan.targetStore,status:'UNPUBLISHED_NOT_APPLIED',publicationAuthorized:false,sourceTheme:{sha256:digest(records(sourceFiles)),files:sourceFiles.length},upstream:{commit:upstream.commit,license:upstream.license,licenseSha256:upstream.licenseSha256,recordSha256:hash(upstreamBytes)},resources:{collectionHandle:plan.namespace,pages:plan.pages.map(({documentId,handle})=>({documentId,handle})),nativeSettingsApplied:false},hero:{file:`assets/${heroName}`,sourceFile:hero.fileName,sha256:hero.sha256},changedFiles,files:themeFiles,zip:{file:zipName,bytes:zipBytes.length,sha256:hash(zipBytes)},customerAcceptance:'PENDING',legalCertification:false};
  const manifestBytes=Buffer.from(json(manifest));await fs.writeFile(zipPath,zipBytes,{flag:'wx'});await fs.writeFile(path.join(destination,'manifest.json'),manifestBytes,{flag:'wx'});await fs.writeFile(path.join(destination,'upstream.json'),upstreamBytes,{flag:'wx'});
  return {directory:destination,themeDirectory,zipPath,manifest,manifestSha256:hash(manifestBytes),zipSha256:hash(zipBytes),changedFiles};
}
