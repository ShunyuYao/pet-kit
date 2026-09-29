// Minimal read-only ZIP reader for character packs. Reads the central directory
// and inflates only the entries asked for, so a 40 MB pack with thousands of
// animation frames costs a few hundred KB. No network, no workers (CSP-safe).
const EOCD=0x06054b50,CEN=0x02014b50,LOC=0x04034b50;
const bytes=async(blob,a,b)=>new Uint8Array(await blob.slice(a,b).arrayBuffer());
const utf8=new TextDecoder();
export async function openZip(blob){
  if(!(blob instanceof Blob))throw Error('zip_invalid');
  const tailStart=Math.max(0,blob.size-65557),tail=await bytes(blob,tailStart,blob.size),dv=new DataView(tail.buffer);
  let at=-1;for(let i=tail.length-22;i>=0;i--)if(dv.getUint32(i,true)===EOCD){at=i;break;}
  if(at<0)throw Error('zip_invalid');
  const count=dv.getUint16(at+10,true),size=dv.getUint32(at+12,true),offset=dv.getUint32(at+16,true);
  if(size===0xffffffff||offset===0xffffffff||count===0xffff)throw Error('zip64_unsupported');
  if(count>20000||offset+size>blob.size)throw Error('zip_invalid');
  const dir=await bytes(blob,offset,offset+size),cd=new DataView(dir.buffer),entries=new Map();
  for(let p=0,n=0;n<count;n++){
    if(p+46>dir.length||cd.getUint32(p,true)!==CEN)throw Error('zip_invalid');
    const method=cd.getUint16(p+10,true),csize=cd.getUint32(p+20,true),usize=cd.getUint32(p+24,true),nlen=cd.getUint16(p+28,true),xlen=cd.getUint16(p+30,true),clen=cd.getUint16(p+32,true),local=cd.getUint32(p+42,true),flags=cd.getUint16(p+8,true);
    const name=utf8.decode(dir.subarray(p+46,p+46+nlen));p+=46+nlen+xlen+clen;
    // Reject traversal and absolute paths outright; they are never legitimate in a pack.
    if(!name||name.endsWith('/')||name.startsWith('/')||name.split('/').includes('..')||name.includes('\\'))continue;
    entries.set(name,{method,csize,usize,local,encrypted:!!(flags&1)});
  }
  async function read(name,limit=8*1024*1024){
    const e=entries.get(name);if(!e)throw Error('zip_entry_missing:'+name);
    if(e.encrypted)throw Error('zip_encrypted');if(e.usize>limit)throw Error('zip_entry_too_large:'+name);
    const head=await bytes(blob,e.local,e.local+30),hv=new DataView(head.buffer);
    if(hv.getUint32(0,true)!==LOC)throw Error('zip_invalid');
    const start=e.local+30+hv.getUint16(26,true)+hv.getUint16(28,true),raw=await bytes(blob,start,start+e.csize);
    if(e.method===0)return raw;
    if(e.method!==8)throw Error('zip_method_unsupported');
    const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const out=new Uint8Array(await new Response(stream).arrayBuffer());
    if(out.length!==e.usize)throw Error('zip_invalid');return out;
  }
  return {names:()=>[...entries.keys()],has:n=>entries.has(n),read};
}
// Same interface over a picked folder (<input webkitdirectory>).
export function openFolder(files){
  const map=new Map();
  for(const f of files){const parts=(f.webkitRelativePath||f.name).split('/');parts.shift();const name=parts.join('/')||f.name;if(!name.split('/').includes('..'))map.set(name,f);}
  return {names:()=>[...map.keys()],has:n=>map.has(n),async read(n,limit=8*1024*1024){const f=map.get(n);if(!f)throw Error('zip_entry_missing:'+n);if(f.size>limit)throw Error('zip_entry_too_large:'+n);return new Uint8Array(await f.arrayBuffer());}};
}
