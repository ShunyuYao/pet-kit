// pet-kit looks (browser only, ES module): character sources → one portable "driver":
//   {profile:{name,signature,kind,color}, asset:{kind,...}, portrait}
// `asset` is the exact JSON sent to the peer, so both screens build the driver from
// the same bytes. Imported photos stay in this browser profile and the session;
// nothing is uploaded anywhere else.
import {openZip,openFolder} from './zip.js';

export const TOYS=[
  {id:'mouse',name:'奶酪鼠',color:'#ffc93c'},
  {id:'cat',name:'橘子猫',color:'#ff8a3d'},
  {id:'bunny',name:'棉花兔',color:'#ff8fc2'},
];
const COLORS=['#ff5a5f','#3d8bff','#22c55e','#a855f7','#ff9f1c','#14b8a6'];

async function sha(text){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(d).slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');}
function loadImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('image_decode_failed'));img.src=src;});}
function blobUrl(bytes,type){return URL.createObjectURL(new Blob([bytes],{type}));}
const mimeOf=name=>/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':/\.jpe?g$/i.test(name)?'image/jpeg':/\.gif$/i.test(name)?'image/gif':'';
// Re-encode to WebP with a size cap; optionally trim transparent margins (2D sprites).
async function reencode(src,{max=512,trim=false,quality=.86}={}){
  const img=await loadImage(src);let sx=0,sy=0,sw=img.naturalWidth,sh=img.naturalHeight;
  if(!sw||!sh)throw Error('image_decode_failed');
  if(trim){
    const c=document.createElement('canvas');c.width=sw;c.height=sh;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
    const d=g.getImageData(0,0,sw,sh).data;let x0=sw,y0=sh,x1=-1,y1=-1;
    for(let y=0;y<sh;y+=2)for(let x=0;x<sw;x+=2)if(d[(y*sw+x)*4+3]>24){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
    if(x1>x0&&y1>y0){sx=Math.max(0,x0-4);sy=Math.max(0,y0-4);sw=Math.min(img.naturalWidth-sx,x1-x0+9);sh=Math.min(img.naturalHeight-sy,y1-y0+9);}
  }
  const scale=Math.min(1,max/Math.max(sw,sh)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(sw*scale));c.height=Math.max(1,Math.round(sh*scale));
  c.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,c.width,c.height);
  return {url:c.toDataURL('image/webp',quality),width:c.width,height:c.height};
}
async function finish(profile,asset,portrait){
  const signature=asset.kind+':'+await sha(JSON.stringify(asset));
  return {profile:{...profile,signature,kind:asset.kind},asset,portrait};
}
export async function toyDriver(id='mouse',name){
  const toy=TOYS.find(t=>t.id===id)||TOYS[0];
  return finish({name:name||toy.name,color:toy.color},{kind:'toy',species:toy.id,color:toy.color},null);
}
// 2D: any image file.
export async function imageDriver(file){
  if(file.size>12*1024*1024)throw Error('file_too_large');
  const url=URL.createObjectURL(file);
  try{const img=await reencode(url,{max:384,trim:true});
    return finish({name:file.name.replace(/\.[^.]+$/,'').slice(0,16)||'我的角色',color:COLORS[file.size%COLORS.length]},{kind:'sprite',frames:[img.url],fps:0,aspect:img.width/img.height},img.url);}
  finally{URL.revokeObjectURL(url);}
}
// 2D: the pet the user currently runs, via pet.character (HTML work SDK).
export async function currentPetDriver(sdk){
  const current=await sdk.getCurrent({states:['idle']});
  const pose=current?.poses?.find(p=>p.id==='idle');
  if(!pose||!/^data:image\/(png|webp);base64,/.test(pose.dataUrl))throw Error('CHARACTER_IMAGE_UNAVAILABLE');
  const img=await reencode(pose.dataUrl,{max:384,trim:true});
  const d=await finish({name:[...String(current.name||'我的桌宠')].slice(0,16).join(''),color:COLORS[(current.key||'').length%COLORS.length]},{kind:'sprite',frames:[img.url],fps:0,aspect:img.width/img.height},img.url);
  d.characterKey=current.key;d.source='pet';return d;
}
// Character pack (ZIP or folder). A v2 `realtime` block (pet-ragdoll-renderer
// data) becomes a 3D rag doll; otherwise idle frames become an animated sprite.
export async function packDriver(input){
  const pack=input instanceof Blob?await openZip(input):openFolder(input);
  const names=pack.names(),charPath=names.filter(n=>/(^|\/)character\.json$/.test(n)).sort((a,b)=>a.split('/').length-b.split('/').length)[0];
  if(!charPath)throw Error('pack_no_character');
  const base=charPath.slice(0,-'character.json'.length),json=async n=>JSON.parse(new TextDecoder().decode(await pack.read(base+n,2*1024*1024)));
  const character=await json('character.json');let manifest=null;try{manifest=await json('manifest.json');}catch{}
  const name=[...String(character.name||manifest?.name||'角色包')].slice(0,16).join('');
  const color=COLORS[[...String(character.key||name)].reduce((a,c)=>a+c.charCodeAt(0),0)%COLORS.length];
  const safe=rel=>{if(typeof rel!=='string'||rel.startsWith('/')||rel.split(/[\\/]/).includes('..'))throw Error('pack_invalid_path');return base+rel;};
  const imageUrl=async(rel,opts)=>{const path=safe(rel),type=mimeOf(path);if(!type)throw Error('pack_invalid_image');const url=blobUrl(await pack.read(path),type);try{return await reencode(url,opts);}finally{URL.revokeObjectURL(url);}};
  // Sprite frames from the idle clip (at most 8 evenly spaced).
  let sprite=null;
  const clip=character.anim?.idle;
  if(clip&&typeof clip.dir==='string'&&typeof clip.base==='string'){
    const count=Math.max(1,Math.min(1000,clip.count|0)),take=Math.min(8,count),frames=[];
    for(let i=0;i<take;i++){const idx=(clip.start||0)+Math.floor(i*count/take);const rel=clip.dir+'/'+clip.base+String(idx).padStart(clip.pad??2,'0')+'.'+(clip.ext||'png');
      try{frames.push(await imageUrl(rel,{max:320,trim:false}));}catch(e){if(!frames.length&&i===take-1)throw e;}}
    if(frames.length)sprite={kind:'sprite',frames:frames.map(f=>f.url),fps:Math.min(12,frames.length/(count/(clip.fps||12))),aspect:frames[0].width/frames[0].height};
  }
  const rt=character.realtime;
  if(rt&&rt.dataVersion===2&&rt.assets&&typeof rt.data==='string'){
    const data=await json(rt.data),A=rt.assets,garments={};
    if(!['female','male'].includes(data.person))throw Error('pack_realtime_invalid');
    for(const slot of ['top','bottom']){
      const g=data.garments?.[slot];if(!g)throw Error('pack_realtime_invalid');
      const key=f=>{const k=g.assets?.[f];if(!k||!A[k])throw Error('pack_realtime_invalid');return A[k];};
      garments[slot]={kind:g.kind,front:(await imageUrl(key('front'),{max:640})).url,back:(await imageUrl(key('back'),{max:640})).url,
        frontBump:(await imageUrl(key('frontBump'),{max:256,quality:.7})).url,backBump:(await imageUrl(key('backBump'),{max:256,quality:.7})).url,
        shape:JSON.parse(new TextDecoder().decode(await pack.read(safe(key('shape')),512*1024)))};
    }
    const head=await imageUrl(A.head,{max:512,quality:.9});
    const headScale=Number.isFinite(data.headScale)?Math.min(2,Math.max(.75,data.headScale)):1;
    const d=await finish({name,color},{kind:'doll3d',person:data.person,headScale,head:head.url,garments},sprite?.frames[0]||head.url);
    d.characterKey=character.key;d.fallback=sprite;return d;
  }
  if(!sprite)throw Error('pack_no_frames');
  const d=await finish({name,color},sprite,sprite.frames[0]);d.characterKey=character.key;return d;
}
// 3D straight from the host: pet.character.getRealtime() (newer hosts only).
// Same doll asset shape as a pack import, so the peer receives identical bytes.
export async function realtimeDriver(rt,sprite){
  if(!rt||rt.renderer!=='rat-doll-renderer'||rt.dataVersion!==2)return null;
  const data=rt.data,A=rt.assets||{},url=id=>{const a=A[id];if(!a||!/^image\//.test(a.contentType))throw Error('pack_realtime_invalid');return 'data:'+a.contentType+';base64,'+a.dataBase64;};
  const json=id=>{const a=A[id];if(!a||a.contentType!=='application/json')throw Error('pack_realtime_invalid');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(a.dataBase64),c=>c.charCodeAt(0))));};
  if(!['female','male'].includes(data?.person))throw Error('pack_realtime_invalid');
  const garments={};
  for(const slot of ['top','bottom']){
    const g=data.garments?.[slot],key=f=>{const k=g?.assets?.[f];if(!k)throw Error('pack_realtime_invalid');return k;};
    garments[slot]={kind:g.kind,front:(await reencode(url(key('front')),{max:640})).url,back:(await reencode(url(key('back')),{max:640})).url,
      frontBump:(await reencode(url(key('frontBump')),{max:256,quality:.7})).url,backBump:(await reencode(url(key('backBump')),{max:256,quality:.7})).url,shape:json(key('shape'))};
  }
  const head=await reencode(url('head'),{max:512,quality:.9}),headScale=Number.isFinite(data.headScale)?Math.min(2,Math.max(.75,data.headScale)):1;
  const d=await finish({name:[...String(rt.name)].slice(0,16).join(''),color:sprite?.profile.color||COLORS[0]},{kind:'doll3d',person:data.person,headScale,head:head.url,garments},sprite?.portrait||head.url);
  d.characterKey=rt.key;d.source='pet';d.fallback=sprite?.asset;return d;
}
// Validate an asset received from the peer before it reaches the renderer.
export function checkAsset(a){
  const img=v=>typeof v==='string'&&/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v)&&v.length<700000;
  if(!a||typeof a!=='object')return false;
  if(a.kind==='toy')return TOYS.some(t=>t.id===a.species)&&/^#[0-9a-f]{6}$/i.test(a.color);
  if(a.kind==='sprite')return Array.isArray(a.frames)&&a.frames.length>=1&&a.frames.length<=8&&a.frames.every(img)&&Number.isFinite(a.aspect)&&a.aspect>.05&&a.aspect<20;
  if(a.kind==='doll3d')return ['female','male'].includes(a.person)&&Number.isFinite(a.headScale)&&img(a.head)&&['top','bottom'].every(s=>{const g=a.garments?.[s];return g&&typeof g.kind==='string'&&['front','back','frontBump','backBump'].every(k=>img(g[k]))&&g.shape&&typeof g.shape==='object';});
  return false;
}
// IndexedDB cache so an imported pack survives reopening the game (received
// works get a persistent partition). Every access is optional.
// Each game keeps its own cache: configureLooks({dbName:'pet-bomb'}) once at boot.
let DB='pet-kit-looks';const STORE='fighters';
export function configureLooks({dbName}={}){if(typeof dbName==='string'&&dbName)DB=dbName;}
function db(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function saveDriver(key,driver){try{const d=await db();await new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).put({profile:driver.profile,asset:driver.asset,portrait:driver.portrait,characterKey:driver.characterKey,source:driver.source,fallback:driver.fallback,savedAt:Date.now()},key);t.oncomplete=res;t.onerror=()=>rej(t.error);});d.close();return true;}catch{return false;}}
export async function loadDriver(key){try{const d=await db();const v=await new Promise((res,rej)=>{const r=d.transaction(STORE).objectStore(STORE).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});d.close();return v&&checkAsset(v.asset)?v:null;}catch{return null;}}
