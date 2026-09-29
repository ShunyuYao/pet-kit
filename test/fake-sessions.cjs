'use strict';
// Strict in-process stand-in for the host's `pet.sessions` bridge, modelled on
// demo/core/peer-session/manager.js (read it before changing anything here):
//
//   • validation: the host's own contracts.js is loaded when the host source is next to us
//     (PET_HOST_ROOT or ../../../), so plain-JSON / size / token rules are the real ones;
//   • per session record, a fixed 1 s budget window: 30 calls per lane and 512 KB in total.
//     Over budget the sender gets `backpressure`; an over-budget *incoming* latest message is
//     dropped and the receiver gets one `resync_required` per window;
//   • latest lane: at most 8 keys; sends are batched every 30 ms keeping the newest per key;
//     the receiver drops a latest message older than the last one it saw for that key;
//   • reliable lane: at most 1,024 messages per session, never lost, in order;
//   • one poll waiter at a time; a poll batch is at most 64 KB;
//   • transfers: ≤ 1 MiB, one at a time per session, ≤ 8 MB retained per session, the receiver
//     gives up after 10 s (asset_timeout);
//   • the link itself: latency range, random loss of latest messages, and optional bandwidth
//     (bytes/s per direction) with a FIFO queue, so a slow link queues messages up like TCP.
const path=require('node:path'),fs=require('node:fs'),{randomUUID}=require('node:crypto');

const LIMITS={latestBytes:60*1024,callsPerSecond:30,bytesPerSecond:512*1024,latestKeys:8,assetBytes:1024*1024,retainedAssetBytes:8*1024*1024,pollBytes:64*1024,reliable:1024,assetTimeoutMs:10000};
function hostContracts(){
  // PET_HOST_ROOT, else the nearest folder above us that holds the host source.
  const tries=process.env.PET_HOST_ROOT?[process.env.PET_HOST_ROOT]:Array.from({length:7},(_,i)=>path.resolve(__dirname,'../'.repeat(i+1)));
  for(const root of tries){const file=path.join(root,'demo/core/peer-session/contracts.js');if(fs.existsSync(file)){try{return require(file);}catch{return null;}}}
  return null;
}
const C=hostContracts();
const fail=code=>{throw Object.assign(Error(code),{code});};
function validateMessage(v){
  if(C){try{return C.message(C.target(v)[1]);}catch(e){fail(e.code||e.message);}}
  // Fallback when the host source is not around: the same checks, simplified.
  const plainish=x=>x===null||['string','boolean'].includes(typeof x)||(typeof x==='number'&&Number.isFinite(x))||(Array.isArray(x)&&x.every(plainish))||(typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype&&Object.values(x).every(plainish));
  const {to,...m}=v;if(!plainish(m.payload))fail('invalid_request');
  if(JSON.stringify(m).length>LIMITS.latestBytes)fail('quota_exceeded');return JSON.parse(JSON.stringify(m));
}

function createHub({latency=[5,40],loss=0,bandwidth=null,seed=7,protocol={id:'pet-kit-test',version:1}}={}){
  let s=seed>>>0||1;const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};
  const ends=new Map();let hostEnd=null;
  const stats={sent:0,delivered:0,dropped:0,coalesced:0,backpressure:0,resync:0,maxBytes:0,reliable:0,transfers:0,links:{}};
  const linkStats=k=>stats.links[k]||(stats.links[k]={bytes:0,messages:0,firstAt:0,lastAt:0});
  // One record per (endpoint, remote) pair, like the host's session record.
  function record(owner,remote){
    const key=owner.id+'>'+remote.id;let r=owner.records.get(remote.id);
    if(!r){r={key,owner,remote,budget:null,incoming:null,latest:new Map(),latestKeys:new Set(),recvLatest:new Map(),latestSeq:0,flush:null,reliable:0,transferring:false,assetBytes:0,freeAt:0,lastAt:0};owner.records.set(remote.id,r);}
    return r;
  }
  function charge(r,lane,bytes,incoming){
    const name=incoming?'incoming':'budget';let b=r[name];const t=Date.now();
    if(!b||t-b.since>=1000)b=r[name]={since:t,reliable:0,latest:0,bytes:0,resync:false};
    if(b[lane]>=LIMITS.callsPerSecond||b.bytes+bytes>LIMITS.bytesPerSecond){
      if(incoming&&lane==='latest'){if(!b.resync){b.resync=true;stats.resync++;r.owner.push({type:'resync_required',reason:'backpressure',from:r.remote.id});}return false;}
      stats.backpressure++;fail('backpressure');
    }
    b[lane]++;b.bytes+=bytes;return true;
  }
  // The wire: FIFO per direction, serialisation delay from bandwidth, then latency.
  function transmit(r,bytes,onArrive,{lossy=false}={}){
    const t=Date.now(),start=Math.max(t,r.freeAt),dur=bandwidth?bytes/bandwidth*1000:0;r.freeAt=start+dur;
    const at=Math.max(r.lastAt,start+dur+latency[0]+rnd()*(latency[1]-latency[0]));r.lastAt=at;
    const ls=linkStats(r.key);ls.bytes+=bytes;ls.messages++;if(!ls.firstAt)ls.firstAt=t;ls.lastAt=t;
    if(lossy&&loss&&rnd()<loss){stats.dropped++;return at;}
    setTimeout(()=>{if(ends.has(r.remote.id)&&ends.has(r.owner.id))onArrive();},Math.max(0,at-t));return at;
  }
  function receive(r,m,seq){
    const inbound=record(r.remote,r.owner),target=r.remote,bytes=JSON.stringify(m).length;
    if(m.lane==='latest'){
      if(!inbound.recvLatest.has(m.key)&&inbound.recvLatest.size>=LIMITS.latestKeys){target.push({type:'error',reason:'latest_keys',from:r.owner.id});return;}
      if(!charge(inbound,'latest',bytes,true))return;
      if(seq<=(inbound.recvLatest.get(m.key)||0))return;inbound.recvLatest.set(m.key,seq);
    }else charge(inbound,'reliable',bytes,true);
    stats.delivered++;target.push({type:'message',seq,from:r.owner.id,message:{lane:m.lane,...(m.key?{key:m.key}:{}),type:m.type,payload:m.payload}});
  }
  function endpoint(role){
    const id=randomUUID(),q=[];let waiter=null,cursor=0,state='waiting',joined=false;
    const e={id,role,q,epoch:1,records:new Map(),blobs:new Map(),push(ev){q.push({...ev,cursor:++cursor0});if(waiter){const w=waiter;waiter=null;w();}}};
    let cursor0=0;ends.set(id,e);if(role==='host')hostEnd=e;
    const peersOf=()=>role==='host'?[...ends.values()].filter(x=>x.role==='guest'&&x.joined):hostEnd?[hostEnd]:[];
    const sdk={
      async getContext(){return {invitationId:randomUUID(),role,protocol:{...protocol},peer:{sessionPeerId:id},maxPlayers:4};},
      async join(){
        joined=true;e.joined=true;
        if(role==='guest'&&hostEnd){state='connected';hostEnd.push({type:'peer_joined',from:id});hostEnd.push({type:'connected',from:id,epoch:1});e.push({type:'connected',epoch:1});}
        if(role==='host')state='connected';
        return {status:role==='host'?'waiting':'connected',epoch:1,limits:{...LIMITS},peerStatus:role==='host'?'waiting':'online'};
      },
      async send(v){
        if(!joined)fail('not_connected');
        const m=validateMessage(v),bytes=JSON.stringify(m).length;stats.maxBytes=Math.max(stats.maxBytes,bytes);
        const to=v.to;let targets;
        if(role==='guest'){if(to!==undefined)fail('invalid_request');targets=hostEnd?[hostEnd]:[];}
        else if(to==='*')targets=peersOf();else{const t=ends.get(to);if(!t)fail('peer_offline');targets=[t];}
        let seq=0;
        for(const t of targets){
          const r=record(e,t);
          if(m.lane==='reliable'){
            if(r.reliable>=LIMITS.reliable){stats.backpressure++;fail('backpressure');}
            charge(r,'reliable',bytes,false);r.reliable++;stats.reliable++;seq=r.reliable;const sq=seq;
            transmit(r,bytes,()=>receive(r,m,sq));continue;
          }
          if(!r.latestKeys.has(m.key)&&r.latestKeys.size>=LIMITS.latestKeys){stats.backpressure++;fail('backpressure');}
          charge(r,'latest',bytes,false);r.latestKeys.add(m.key);seq=++r.latestSeq;
          if(r.latest.has(m.key))stats.coalesced++;r.latest.set(m.key,{m,seq});
          if(!r.flush)r.flush=setTimeout(()=>{r.flush=null;const batch=[...r.latest.values()];r.latest.clear();
            for(const it of batch)transmit(r,JSON.stringify(it.m).length,()=>receive(r,it.m,it.seq),{lossy:true});},30);
        }
        stats.sent++;return {status:'queued',seq};
      },
      async poll({cursor:from=0,waitMs=0}={}){
        if(waiter)fail('backpressure');
        const ready=()=>q.length&&q[q.length-1].cursor>from;
        if(!ready()&&waitMs&&state!=='closed')await new Promise(r=>{waiter=r;setTimeout(()=>{if(waiter===r){waiter=null;r();}},waitMs);});
        const events=[];let bytes=256,next=from;
        for(const ev of q){if(ev.cursor<=from)continue;const b=JSON.stringify(ev).length;if(bytes+b>LIMITS.pollBytes&&events.length)break;events.push(ev);bytes+=b;next=ev.cursor;}
        while(q.length&&q[0].cursor<=next-200)q.shift();
        return {cursor:next,events,transportState:state,epoch:e.epoch};
      },
      async transfer(v){
        if(!joined)fail('not_connected');
        const {to,...rest}=v;if(C){try{C.transfer(rest);}catch(err){fail(err.code||err.message);}}
        const size=Math.floor(rest.dataBase64.length*3/4);if(size>LIMITS.assetBytes)fail('invalid_request');
        const target=role==='guest'?hostEnd:ends.get(to);if(!target)fail('peer_offline');
        const r=record(e,target);
        if(r.transferring||r.assetBytes+size>LIMITS.retainedAssetBytes){stats.backpressure++;fail('backpressure');}
        r.transferring=true;const transferId=randomUUID();stats.transfers++;
        try{
          const t0=Date.now();
          await new Promise((resolve,reject)=>{const at=transmit(r,size,()=>{
            target.blobs.set(transferId,{transferId,purpose:rest.purpose,contentType:rest.contentType,dataBase64:rest.dataBase64,byteLength:size,sha256:'0'.repeat(64)});
            target.push({type:'transfer',from:id,transferId,purpose:rest.purpose,contentType:rest.contentType,byteLength:size});resolve();});
            if(at-t0>LIMITS.assetTimeoutMs)setTimeout(()=>reject(Object.assign(Error('asset_timeout'),{code:'asset_timeout'})),LIMITS.assetTimeoutMs);});
          r.assetBytes+=size;return {transferId,sha256:'0'.repeat(64),byteLength:size};
        }finally{r.transferring=false;}
      },
      async readTransfer({transferId}){const b=e.blobs.get(transferId);if(!b)fail('transfer_unavailable');return {...b};},
      async leave(){
        state='closed';ends.delete(id);
        if(role==='guest')hostEnd?.push({type:'peer_left',from:id});
        else for(const g of ends.values()){g.push({type:'closed',reason:'peer_left'});g.close?.();}
        return {released:true,peerAcknowledged:true};
      },
    };
    e.close=()=>{state='closed';};sdk.__id=id;
    return sdk;
  }
  function linkRates(){
    const out={};for(const [k,v] of Object.entries(stats.links)){const sec=Math.max(1,(v.lastAt-v.firstAt)/1000);out[k]={bytesPerSec:Math.round(v.bytes/sec),messagesPerSec:+(v.messages/sec).toFixed(1)};}return out;
  }
  // A guest's connection drops and comes back (new epoch), like a Wi-Fi hiccup.
  function bounce(sdk){const e=ends.get(sdk.__id);if(!e||!hostEnd)return;e.epoch++;hostEnd.push({type:'disconnected',from:e.id});e.push({type:'connected',epoch:e.epoch});hostEnd.push({type:'connected',from:e.id,epoch:e.epoch});}
  return {host:()=>endpoint('host'),guest:()=>endpoint('guest'),bounce,stats,linkRates,LIMITS,usesHostContracts:!!C};
}
module.exports={createHub,LIMITS};
