'use strict';
// Wire format for pet.sessions messages.
//
// The host only accepts plain JSON (demo/core/peer-session/contracts.js → safeJson): no
// undefined, NaN, Infinity, functions, class instances or cycles; ≤ 20,000 nodes; ≤ 60 KB a
// latest message. `plain()` finds the first offending path so a game learns *which* field is
// wrong instead of getting a bare invalid_request from the host.
//
// `pack()` gzips a whole message into one base64 string when it is big enough to be worth it.
// Every message decodes on its own (no shared dictionary, no deltas), so a dropped or coalesced
// latest message never breaks the next one.
const COMPRESS_ABOVE=512,MAX_UNPACKED=1024*1024;

function nonPlain(v,path='$',seen=new Set()){
  if(v===null||typeof v==='string'||typeof v==='boolean')return null;
  if(typeof v==='number')return Number.isFinite(v)?null:path+' is '+v;
  if(v===undefined)return path+' is undefined';
  if(typeof v!=='object')return path+' is a '+typeof v;
  if(seen.has(v))return path+' is a cycle';
  const proto=Object.getPrototypeOf(v);
  if(!Array.isArray(v)&&proto!==Object.prototype&&proto!==null)return path+' is not a plain object';
  seen.add(v);
  if(Array.isArray(v)){for(let i=0;i<v.length;i++){if(!(i in v))return path+'['+i+'] is a hole';const r=nonPlain(v[i],path+'['+i+']',seen);if(r)return r;}}
  else for(const k of Object.keys(v)){const r=nonPlain(v[k],path+'.'+k,seen);if(r)return r;}
  seen.delete(v);return null;
}
// Throws with the path in strict mode; otherwise returns a JSON round-trip (undefined dropped,
// NaN → null) so a slip in a game never turns into a host refusal on a friend's machine.
function plain(v,{strict=false,label='message'}={}){
  if(strict){const bad=nonPlain(v);if(bad)throw Error('not_plain_json: '+label+' '+bad);}
  return JSON.parse(JSON.stringify(v));
}

const toB64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const fromB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function through(bytes,stream,max){
  const out=[];let size=0;const reader=new Blob([bytes]).stream().pipeThrough(stream).getReader();
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('unpacked_too_large');}out.push(value);}
  const all=new Uint8Array(size);let o=0;for(const c of out){all.set(c,o);o+=c.length;}return all;
}
// → {j: value} or {z: base64 gzip of JSON}
async function pack(value,{compress=true,above=COMPRESS_ABOVE}={}){
  const text=JSON.stringify(value);
  if(!compress||text.length<=above||typeof CompressionStream==='undefined')return {j:value};
  const z=toB64(await through(new TextEncoder().encode(text),new CompressionStream('gzip'),MAX_UNPACKED));
  return z.length<text.length?{z}:{j:value};
}
async function unpack(p){
  if(!p||typeof p!=='object')throw Error('bad_packet');
  if('j' in p)return p.j;
  if(typeof p.z!=='string'||p.z.length>MAX_UNPACKED)throw Error('bad_packet');
  return JSON.parse(new TextDecoder().decode(await through(fromB64(p.z),new DecompressionStream('gzip'),MAX_UNPACKED)));
}
const bytesOf=v=>JSON.stringify(v).length;

module.exports={nonPlain,plain,pack,unpack,bytesOf,toB64,fromB64,COMPRESS_ABOVE};
