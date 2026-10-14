// Fixed, versioned suggestions. Viewing or choosing a palette never calls an AI provider.
export const BRAND_PALETTE_VERSION=1;
const rows=[
  ['minimal-graphite','minimal','Γραφίτης','#292929','#f6f5f1','#a29b8e'],
  ['minimal-blue','minimal','Ήρεμο μπλε','#283b53','#f1f4f7','#7894b1'],
  ['minimal-warm','minimal','Ζεστό λευκό','#4e443c','#f7f2e9','#b08b6b'],
  ['elegant-sand','elegant','Άμμος & κακάο','#49362c','#f4eee5','#b79568'],
  ['elegant-wine','elegant','Βαθύ κρασί','#562c3c','#f7f0f0','#bd9c8a'],
  ['elegant-midnight','elegant','Μπλε της νύχτας','#22354b','#f2f1ed','#b3a17d'],
  ['natural-olive','natural','Ελιά & λινό','#526044','#f2f1e5','#b7a27b'],
  ['natural-clay','natural','Πηλός & άμμος','#945c44','#f4eadb','#c7a27e'],
  ['natural-forest','natural','Δάσος & φασκόμηλο','#345549','#eff2e9','#9faf8e'],
  ['retro-honey','retro','Μέλι & κεραμιδί','#943c27','#f6dfb0','#d99a64'],
  ['retro-petrol','retro','Πετρόλ & κρέμα','#296064','#f5e6c6','#c57942'],
  ['retro-cherry','retro','Κεράσι & βανίλια','#a03940','#fff0cf','#718d6c'],
  ['futuristic-mint','futuristic','Μέντα στο σκοτάδι','#9d8bff','#16172b','#a5f6e0'],
  ['futuristic-electric','futuristic','Ηλεκτρικό μπλε','#788eff','#101c32','#dfed71'],
  ['futuristic-orbit','futuristic','Μωβ τροχιά','#c99bff','#24172f','#f7a8cd'],
  ['playful-coral','playful','Κοραλί & λιλά','#7154a0','#ffe6d6','#f57570'],
  ['playful-sun','playful','Ήλιος & ουρανός','#3766aa','#fff5cf','#efaa48'],
  ['playful-pink','playful','Ροζ & φιστίκι','#a14470','#fcebf2','#99bd7b'],
  ['other-neutral','other','Ήρεμη βάση','#383633','#f5f3ed','#b3a28e'],
  ['other-blue','other','Μπλε κατεύθυνση','#32475a','#f1f4f5','#90adb3'],
  ['other-earth','other','Γήινη κατεύθυνση','#625345','#f4ecdf','#aa8567']
];
export const BRAND_PALETTES=rows.map(([id,style,name,primary,secondary,accent])=>({id,style,name,primary,secondary,accent}));
export const paletteFor=id=>BRAND_PALETTES.find(palette=>palette.id===id);
export const palettesForStyle=style=>BRAND_PALETTES.filter(palette=>palette.style===style);
