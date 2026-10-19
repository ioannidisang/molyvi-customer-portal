import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requirementKeys = ['story','colors','references','assets','categories','markets','currency','payments','shipping','returns','pages','deadline','notes'];
const intakeTextKeys = ['business','contact','email','sector','style','logo','products','variants','catalog','languages','migration','integrations','texts','policies',...requirementKeys];

export function compileBrief(brief) {
  if (!isObject(brief) || brief.schemaVersion !== '1.0' || !isObject(brief.intake)) throw new Error('Expected a Molyvi brief object with schemaVersion 1.0 and an intake object.');
  const b=brief.intake;
  for (const key of ['brand','style']) {
    if (brief[key] !== undefined && typeof brief[key] !== 'string') throw new Error(`Invalid brief.${key}: expected a string.`);
  }
  for (const key of intakeTextKeys) {
    if (b[key] !== undefined && typeof b[key] !== 'string') throw new Error(`Invalid intake.${key}: expected a string.`);
  }
  const brand=(b.business||brief.brand||'').trim();
  if (!brand || brand.length>80) throw new Error('Brand name must contain 1 to 80 characters.');
  const style=String(b.style||brief.style||'');
  if(style!=='still') throw new Error('ASSESSMENT_REQUIRED: This pilot supports STILL. Other directions need their own reviewed theme preset.');
  const count=String(b.products||'').replace(/[–—-]/g,' έως ').replace(/\s+/g,' ').trim();
  const reasons=[];
  if(!['1 έως 20','21 έως 100'].includes(count))reasons.push('Unconfirmed or large product catalog');
  if(!['Ελληνικά','Αγγλικά'].includes(b.languages))reasons.push('Multiple or unconfirmed languages');
  if(b.migration!=='Όχι')reasons.push('Migration');
  if(b.integrations!=='Όχι')reasons.push('Integrations');
  if(!['Όχι','Ναι, απλές παραλλαγές'].includes(b.variants))reasons.push('Complex or unconfirmed variants');
  if(reasons.length)throw new Error('ASSESSMENT_REQUIRED: '+reasons.join('; '));
  const blockers=[];
  if(b.logo!=='Ναι, σε επεξεργάσιμη μορφή')blockers.push('Approved editable logo');
  if(!b.assets)blockers.push('Brand assets and photography');
  if(b.catalog!=='Έτοιμο αρχείο με τιμές, περιγραφές και εικόνες')blockers.push('Structured product catalog');
  if(b.texts!=='Ναι')blockers.push('Approved copy');
  if(b.policies!=='Ναι, για έλεγχο από τον σύμβουλό μου')blockers.push('Merchant-reviewed legal pages');
  const themeSettings={forma_brand_name:brand,forma_demo_mode:true,brand_headline:brand};
  const requirements=Object.fromEntries(requirementKeys.map(key=>[key,(b[key]||'').slice(0,4000)]));
  return {schemaVersion:'1.0',brand,style,language:b.languages==='Ελληνικά'?'el':'en',package:count==='21 έως 100'?'Plus':'Start',productLimit:count==='21 έως 100'?100:20,themeSettings,requirements,readiness:{state:'staging_only',blockers,approvalRequiredBeforeLaunch:true},tasks:[
    {stage:'scope',status:'pending',description:'Confirm scope, price and exclusions with the customer'},
    {stage:'assets',status:'pending',description:'Check ownership, quality, completeness and mapping of assets'},
    {stage:'store',status:'pending',description:'Create or select the authorized target store and upload as unpublished'},
    {stage:'catalog',status:'pending',description:'Import draft products, check variants and inventory, then activate in the authorized test store'},
    {stage:'commerce',status:'pending',description:'Configure merchant-approved payment, shipping, taxes and notification settings'},
    {stage:'qa',status:'pending',description:'Complete storefront and test-checkout checks'},
    {stage:'approval',status:'pending',description:'Obtain customer approval and release checklist before launch'}
  ]};
}

function containsPath(parent, child) {
 const relative=path.relative(parent,child);
 return relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative));
}

// Resolve existing parents too, so a junction cannot place a new output inside the source.
async function resolveDestination(destination) {
 let candidate=destination;
 const suffix=[];
 while(true){
  try{return path.join(await fs.realpath(candidate),...suffix);}catch(error){
   if(error.code!=='ENOENT')throw error;
   const parent=path.dirname(candidate);
   if(parent===candidate)throw error;
   suffix.unshift(path.basename(candidate));candidate=parent;
  }
 }
}

async function hashTree(root) {
 const files=[];
 async function visit(directory,prefix=''){
  const entries=await fs.readdir(directory,{withFileTypes:true});
  entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const entry of entries){
   const file=path.join(directory,entry.name);
   const relative=prefix+entry.name;
   if(entry.isDirectory())await visit(file,relative+'/');
   else if(entry.isFile()){
    const bytes=await fs.readFile(file);
    files.push({path:relative,bytes:bytes.length,sha256:sha256(bytes)});
   }else throw new Error('Source theme must contain only regular files and directories: '+relative);
  }
 }
 await visit(root);
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {sha256:sha256(JSON.stringify(files)),fileCount:files.length};
}

function validateSettingValues(values, definitions, location) {
 for (const definition of definitions || []) {
  const value=values?.[definition.id];
  if(value===undefined)continue;
  const setting=`${location}.${definition.id}`;
  if(definition.type==='range'){
   const step=definition.step??1;
   const position=(value-definition.min)/step;
   if(typeof value!=='number'||!Number.isFinite(value)||value<definition.min||value>definition.max||Math.abs(position-Math.round(position))>1e-7){
    throw new Error(`THEME_SETTINGS_INVALID: ${setting} must be a number from ${definition.min} to ${definition.max} in steps of ${step}.`);
   }
  }else if(['select','radio'].includes(definition.type)&&!definition.options.some(option=>option.value===value)){
   throw new Error(`THEME_SETTINGS_INVALID: ${setting} must match a schema option.`);
  }
 }
}

export async function validateThemeSettings(themeRoot, settingsData, {includeFile=()=>true,fileMap}={}) {
 if(fileMap!==undefined&&(!(fileMap instanceof Map)||[...fileMap].some(([name,bytes])=>typeof name!=='string'||/[\\:\x00-\x1f]/.test(name)||name.split('/').some(bit=>!bit||bit==='.'||bit==='..')||!Buffer.isBuffer(bytes))))throw new Error('THEME_SETTINGS_INVALID: invalid in-memory file map.');
 if(fileMap)for(const name of fileMap.keys()){const parts=name.split('/');for(let i=1;i<parts.length;i++)if(fileMap.has(parts.slice(0,i).join('/')))throw new Error('THEME_SETTINGS_INVALID: conflicting in-memory file.');}
 const readText=async relative=>{
  if(!fileMap)return fs.readFile(path.join(themeRoot,relative),'utf8');
  const bytes=fileMap.get(relative);if(!bytes)throw new Error('THEME_SETTINGS_INVALID: missing in-memory file.');return bytes.toString('utf8');
 };
 const readEntries=async relative=>{
  if(!fileMap)return fs.readdir(path.join(themeRoot,relative),{withFileTypes:true});
  const names=new Map(),prefix=relative+'/';
  for(const file of fileMap.keys())if(file.startsWith(prefix)){
   const rest=file.slice(prefix.length),name=rest.split('/')[0],directory=rest.includes('/');
   if(names.has(name)&&names.get(name)!==directory)throw new Error('THEME_SETTINGS_INVALID: conflicting in-memory file.');names.set(name,directory);
  }
  if(!names.size)throw new Error('THEME_SETTINGS_INVALID: missing in-memory directory.');
  return [...names].map(([name,directory])=>({name,isFile:()=>!directory,isDirectory:()=>directory}));
 };
 const readJson=async relative=>JSON.parse(await readText(relative));
 const schema=await readJson('config/settings_schema.json');
 const definitions=schema.flatMap(group=>group.settings||[]);
 const data=settingsData??await readJson('config/settings_data.json');
 const sectionSchemas=new Map();
 for(const entry of await readEntries('sections')){
  if(!entry.isFile()||!entry.name.endsWith('.liquid')||!includeFile(`sections/${entry.name}`))continue;
  const content=await readText(`sections/${entry.name}`);
  const match=content.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if(match)sectionSchemas.set(entry.name.slice(0,-7),JSON.parse(match[1]));
 }
 function validateSections(sections,location){
  for(const [id,section] of Object.entries(sections||{})){
   const sectionSchema=sectionSchemas.get(section.type);
   if(!sectionSchema)continue;
   const sectionLocation=`${location}.sections.${id}`;
   validateSettingValues(section.settings,sectionSchema.settings,sectionLocation);
   for(const [blockId,block] of Object.entries(section.blocks||{})){
    const blockSchema=sectionSchema.blocks?.find(candidate=>candidate.type===block.type);
    if(blockSchema)validateSettingValues(block.settings,blockSchema.settings,`${sectionLocation}.blocks.${blockId}`);
   }
  }
 }
 const current=typeof data.current==='string'?data.presets?.[data.current]:data.current;
 if(!isObject(current)||!isObject(data.presets))throw new Error('THEME_SETTINGS_INVALID: current must contain settings or name an existing preset.');
 for(const [location,values] of [['config/settings_data.json.current',current],...Object.entries(data.presets).map(([name,values])=>[`config/settings_data.json.presets.${name}`,values])]){
  if(!isObject(values))throw new Error(`THEME_SETTINGS_INVALID: ${location} must contain a settings object.`);
  validateSettingValues(values,definitions,location);
  validateSections(values.sections,location);
 }
 async function visit(relative){
  for(const entry of await readEntries(relative)){
   const file=path.posix.join(relative,entry.name);
   if(entry.isDirectory())await visit(file);
   else if(entry.isFile()&&entry.name.endsWith('.json')&&includeFile(file))validateSections((await readJson(file)).sections,file);
  }
 }
 await visit('sections');
 await visit('templates');
}

async function main(){
 const {values}=parseArgs({options:{brief:{type:'string'},output:{type:'string'}}});
 if(!values.brief||!values.output)throw new Error('Usage: node scripts/apply-brief.mjs --brief ./demo/brief.json --output ./build/still');
 const kit=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const source=path.join(kit,'theme');
 const dest=path.resolve(values.output);
 const sourceReal=await fs.realpath(source);
 const destinationReal=await resolveDestination(dest);
 if(containsPath(sourceReal,destinationReal)||containsPath(destinationReal,sourceReal))throw new Error('Output must be outside the source theme and cannot be its ancestor.');
 const inputBytes=await fs.readFile(values.brief);
 const plan=compileBrief(JSON.parse(inputBytes.toString('utf8')));
 try{await fs.lstat(dest);throw new Error('Output already exists. Choose a new output directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const packageInfo=JSON.parse(await fs.readFile(path.join(kit,'package.json'),'utf8'));
 const upstream=JSON.parse(await fs.readFile(path.join(kit,'upstream.json'),'utf8'));
 const generatorHash=sha256(await fs.readFile(fileURLToPath(import.meta.url)));
 const sourceTree=await hashTree(source);
 const settings=JSON.parse(await fs.readFile(path.join(source,'config/settings_data.json'),'utf8'));
 await validateThemeSettings(source,settings);
 const current=typeof settings.current==='string'?structuredClone(settings.presets[settings.current]):settings.current;
 Object.assign(current,plan.themeSettings);
 if(plan.language==='en')current.brand_description='<p>Thoughtful objects for the everyday.</p>';
 settings.current=current;
 settings.presets['FORMA Still']=structuredClone(current);
 await validateThemeSettings(source,settings);
 await fs.mkdir(path.dirname(dest),{recursive:true});
 try{await fs.mkdir(dest);}catch(e){if(e.code==='EEXIST')throw new Error('Output already exists. Choose a new output directory.');throw e;}
 await fs.cp(source,path.join(dest,'theme'),{recursive:true,errorOnExist:true,force:false});
 const settingsPath=path.join(dest,'theme/config/settings_data.json');
 await fs.writeFile(settingsPath,JSON.stringify(settings,null,2)+'\n');
 const indexPath=path.join(dest,'theme/templates/index.json');
 const index=JSON.parse(await fs.readFile(indexPath,'utf8'));
 index.sections.forma_hero.settings.eyebrow=plan.brand;
 if(plan.language==='en'){
   Object.assign(index.sections.forma_hero.settings,{heading:'Fewer things. More space.',text:'<p>Quiet textures and thoughtful objects for the everyday.</p>',button_label:'The collection',caption:'A Molyvi design direction',image_alt:'Sculptural white ceramic vase on pale stone'});
   index.sections.featured_collection.settings.title='The considered collection';
   Object.assign(index.sections.forma_note.settings,{label:'OUR APPROACH',heading:'Room for what matters.',text:'<p>A Molyvi pilot storefront. Products and prices are illustrative and are not commercial offers.</p>'});
   const productPath=path.join(dest,'theme/templates/product.json');
   const product=JSON.parse(await fs.readFile(productPath,'utf8'));
   product.sections.main.blocks.share.settings.share_label='Share';
   product.sections['related-products'].settings.heading='In the same space';
   await fs.writeFile(productPath,JSON.stringify(product,null,2)+'\n');
   const footerPath=path.join(dest,'theme/sections/footer-group.json');
   const footer=JSON.parse(await fs.readFile(footerPath,'utf8'));
   footer.sections.footer.blocks.links.settings.heading='Information';
   await fs.writeFile(footerPath,JSON.stringify(footer,null,2)+'\n');
 }
 await fs.writeFile(indexPath,JSON.stringify(index,null,2)+'\n');
 await fs.writeFile(path.join(dest,'production-plan.json'),JSON.stringify(plan,null,2)+'\n');
 const outputTree=await hashTree(path.join(dest,'theme'));
 if((await hashTree(source)).sha256!==sourceTree.sha256)throw new Error('Source theme changed during generation. Choose a new output and retry.');
 const provenance={
  input:{schemaVersion:plan.schemaVersion,sha256:sha256(inputBytes)},
  generator:{name:packageInfo.name,version:packageInfo.version,sha256:generatorHash},
  upstream:{project:upstream.project,commit:upstream.commit,license:upstream.license},
  sourceTheme:sourceTree,
  outputTheme:outputTree
 };
 const manifest={schemaVersion:'1.0',buildId:sha256(JSON.stringify(provenance)),...provenance};
 await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({output:dest,buildId:manifest.buildId,brand:plan.brand,package:plan.package,status:plan.readiness.state,blockers:plan.readiness.blockers.length},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
