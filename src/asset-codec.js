'use strict';
// Optional whole-appearance compression. Keep the actual transfer <=1MiB and
// bound decoded JSON separately; frame resolution must not become a wire limit.
const Wire=require('./wire.js');
const MAX_PACKED=1024*1024,MAX_RAW=4*1024*1024,MAX_B64=Math.ceil(MAX_PACKED/3)*4;
async function through(bytes,stream,max){
 const reader=new Blob([bytes]).stream().pipeThrough(stream).getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('asset_too_large');parts.push(value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 const out=new Uint8Array(size);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;
}
async function encode(value){
 const raw=new TextEncoder().encode(JSON.stringify(value));if(raw.length>MAX_RAW)throw Error('asset_too_large');
 let bytes=raw;
 if(raw.length>512&&typeof CompressionStream!=='undefined'){
  const packed=await through(raw,new CompressionStream('gzip'),MAX_PACKED);
  if(packed.length<raw.length)bytes=packed;
 }
 if(bytes.length>MAX_PACKED)throw Error('asset_too_large');return Wire.toB64(bytes);
}
async function decode(data){
 if(typeof data!=='string'||data.length>MAX_B64)throw Error('invalid_asset');
 let bytes=Wire.fromB64(data);if(bytes.length>MAX_PACKED)throw Error('asset_too_large');
 if(bytes[0]===0x1f&&bytes[1]===0x8b)bytes=await through(bytes,new DecompressionStream('gzip'),MAX_RAW);
 return JSON.parse(new TextDecoder().decode(bytes));
}
module.exports={encode,decode,MAX_PACKED,MAX_RAW};
