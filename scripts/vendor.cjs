'use strict';
// Copy this pet-kit version into a game:  node scripts/vendor.cjs ../pet-bomb
// The game keeps its own pinned copy in vendor/pet-kit/ (like vendor/doll/), so a kit change
// never reaches a game until that game upgrades and passes its own tests.
// `check(gameDir)` is for the game's build: game code may import only the two public entries,
// vendor/pet-kit/index.js (room + wire, CommonJS) and vendor/pet-kit/looks.js (browser ES module).
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const kit=path.resolve(__dirname,'..');
function vendor(gameDir){
  const pkg=JSON.parse(fs.readFileSync(path.join(kit,'package.json'),'utf8'));
  const out=path.join(gameDir,'vendor/pet-kit');fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
  const files={};
  for(const f of fs.readdirSync(path.join(kit,'src')).filter(f=>f.endsWith('.js'))){const b=fs.readFileSync(path.join(kit,'src',f));fs.writeFileSync(path.join(out,f),b);files[f]=crypto.createHash('sha256').update(b).digest('hex');}
  const verifier=fs.readFileSync(__filename);fs.writeFileSync(path.join(out,'verify.cjs'),verifier);files['verify.cjs']=crypto.createHash('sha256').update(verifier).digest('hex');
  fs.copyFileSync(path.join(kit,'LICENSE'),path.join(out,'LICENSE'));
  // The strict fake host, for the game's own net tests (not bundled into the HTML).
  fs.mkdirSync(path.join(out,'testing'));fs.copyFileSync(path.join(kit,'test/fake-sessions.cjs'),path.join(out,'testing/fake-sessions.cjs'));
  fs.writeFileSync(path.join(out,'VERSION.json'),JSON.stringify({name:'pet-kit',version:pkg.version,files},null,2)+'\n');
  return pkg.version;
}
function check(gameDir){
  const bad=[];
  const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){if(!['vendor','node_modules','dist','artifacts','.git'].includes(e.name))walk(p);}
    else if(/\.(c?js|mjs)$/.test(e.name)){const src=fs.readFileSync(p,'utf8');for(const m of src.matchAll(/(?:require\(|from\s+)['"]([^'"]*pet-kit[^'"]*)['"]/g))if(!/pet-kit\/((index|looks|motion)(\.js)?|verify\.cjs|testing\/fake-sessions\.cjs)$/.test(m[1]))bad.push(path.relative(gameDir,p)+' → '+m[1]);}}};
  walk(gameDir);
  if(bad.length)throw Error('pet-kit internals imported (use vendor/pet-kit/index.js or looks.js / motion.js):\n  '+bad.join('\n  '));
  const v=JSON.parse(fs.readFileSync(path.join(gameDir,'vendor/pet-kit/VERSION.json'),'utf8'));
  for(const [f,h] of Object.entries(v.files))/* src files only */if(crypto.createHash('sha256').update(fs.readFileSync(path.join(gameDir,'vendor/pet-kit',f))).digest('hex')!==h)throw Error('vendor/pet-kit/'+f+' was edited in the game; change pet-kit and re-vendor instead');
  return v.version;
}
module.exports={vendor,check};
if(require.main===module){const dir=process.argv[2];if(!dir){console.error('usage: node scripts/vendor.cjs <gameDir>');process.exit(1);}console.log('pet-kit',vendor(path.resolve(dir)),'→',path.resolve(dir,'vendor/pet-kit'));}
