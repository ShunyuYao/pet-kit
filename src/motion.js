'use strict';
// Pure presentation buffer. Time is the sample's simulation clock (milliseconds),
// never the forwarding/arrival timestamp. No Room, DOM, simulation or input ownership.
function create({delayMs=100,maxProjectionMs=0,capacity=32,resetAfterMs=1000,
 interpolate=(a,b,f)=>f<1?a:b,project=null,discontinuous=()=>false}={}){
 for(const [k,v] of Object.entries({delayMs,maxProjectionMs,resetAfterMs}))if(!Number.isFinite(v)||v<0)throw Error('invalid_motion_'+k);
 if(!Number.isInteger(capacity)||capacity<2||capacity>512)throw Error('invalid_motion_capacity');
 if(typeof interpolate!=='function'||typeof discontinuous!=='function'||project!==null&&typeof project!=='function')throw Error('invalid_motion_adapter');
 let frames=[],key,offset=null,lastReceived=-Infinity,lastTime=-Infinity,dropped=0,mode='empty',resets=0;
 const copy=v=>structuredClone(v);
 function reset(){frames=[];key=undefined;offset=null;lastReceived=-Infinity;lastTime=-Infinity;mode='empty';resets++;}
 function push({time,value,key:nextKey}={},receivedAt){
  if(!Number.isFinite(time)||!Number.isFinite(receivedAt))throw Error('invalid_motion_time');
  if(nextKey!==key||receivedAt-lastReceived>resetAfterMs){reset();key=nextKey;}
  const last=frames.at(-1);
  if(last&&time<=last.time){dropped++;return false;}
  const snapshot=copy(value); // callers may mutate their simulation after returning
  lastReceived=receivedAt;offset=Math.min(offset??Infinity,receivedAt-time);
  frames.push({time,value:snapshot});if(frames.length>capacity)frames.shift();return true;
 }
 function sample(now){
  if(!Number.isFinite(now))throw Error('invalid_motion_time');
  if(!frames.length){mode='empty';return null;}
  const first=frames[0],last=frames.at(-1),time=Math.max(lastTime,now-offset-delayMs);lastTime=time;
  if(time<=first.time||frames.length===1){mode='buffering';return copy(first.value);}
  let a=frames.at(-2),b=last;
  for(let i=1;i<frames.length;i++)if(frames[i].time>=time){a=frames[i-1];b=frames[i];break;}
  // Callbacks receive copies too; a mutating game adapter cannot poison history.
  const av=copy(a.value),bv=copy(b.value),span=b.time-a.time;
  if(discontinuous(av,bv,span)){mode='discontinuous';return copy(b.value);}
  if(time<=b.time){mode='interpolating';return copy(interpolate(av,bv,(time-a.time)/span,span));}
  const ahead=time-b.time;mode=ahead>maxProjectionMs?'exhausted':'projecting';
  return project&&maxProjectionMs>0?copy(project(av,bv,Math.min(ahead,maxProjectionMs),span)):copy(b.value);
 }
 return {push,sample,reset,stats:()=>({frames:frames.length,dropped,resets,mode,lastSampleTime:frames.at(-1)?.time??null,lastReceived:Number.isFinite(lastReceived)?lastReceived:null})};
}
module.exports={create};
