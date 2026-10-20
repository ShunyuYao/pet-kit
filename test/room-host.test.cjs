'use strict';
// Real host manager + shared SDK. Only the duplex wire is linked in-process;
// session validation, batching, polls and asset transfers are production modules.
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{EventEmitter}=require('node:events'),{randomUUID,createHash}=require('node:crypto');
const {Room}=require('../src');
assert(process.env.PET_HOST_ROOT,'PET_HOST_ROOT must point to the actual host checkout (no SKIP)');
const {createSessionManager}=require(path.join(process.env.PET_HOST_ROOT,'demo/core/peer-session/manager'));
const {createSharedSdk}=require(path.join(process.env.PET_HOST_ROOT,'demo/core/plugin-runtime/shared-sdk'));
const protocol={id:'kit-real-host',version:2},artifactHash='a'.repeat(64);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await sleep(20);}assert.fail(label);}
function pair(t){
  const managers=[createSessionManager(),createSessionManager()],channels=[new EventEmitter(),new EventEmitter()];
  let dead=false;channels.forEach((ch,i)=>{ch.peer=(i?'b':'c').repeat(64);ch.snapshot=()=>({state:dead?'closed':'ready'});ch.send=async payload=>{if(dead)throw Error('disconnected');await Promise.resolve();channels[1-i].emit('message',{payload:structuredClone(payload)});return {status:'peer_received',seq:1};};ch.transfer=async(bytes,{id,contentType})=>{channels[1-i].emit('asset',{id,bytes:Buffer.from(bytes),contentType,digest:createHash('sha256').update(bytes).digest('hex')});return {status:'peer_received'};};ch.close=reason=>{if(dead)return;dead=true;channels.forEach(c=>c.emit('closed',reason));};});
  const invitationId=randomUUID(),calls=[];
  const sdks=managers.map((manager,i)=>{
    const handle=manager.issue({invitationId,artifactHash,protocol,accountScope:'test',expiresAt:Date.now()+60000,role:i?'guest':'host',peer:{fingerprint:channels[i].peer,displayName:'Peer'}});
    const bridge=createSharedSdk({peerSessions:manager}),caller=bridge.createCaller({kind:'work',context:'work',id:randomUUID(),isActive:()=>true,grants:new Set(['sessions:connect'])});
    manager.bind(caller,handle,{artifactHash,accountScope:'test',interaction:{players:2,transport:'lan',protocol}});manager.attach(handle,channels[i]);
    const sdk={};for(const method of ['getContext','join','send','poll','transfer','readTransfer','leave'])sdk[method]=arg=>{if(method==='send'||method==='transfer')calls.push({side:i,method,arg});return bridge.invoke(caller,'sessions',method,arg===undefined?[]:[arg]);};return sdk;
  });
  t.after(()=>managers.forEach(m=>m.dispose()));return {sdks,calls};
}
test('two-player Room interoperates with real manager/SDK without room targets or event from',async t=>{
  const p=pair(t),seen=[{state:[],event:[],asset:[]},{state:[],event:[],asset:[]}],errors=[];
  const rooms=p.sdks.map((sdk,i)=>Room.create(sdk,{protocol,maxPlayers:2,appearancePolicy:'continuous',hostState:()=>({n:42}),guestState:()=>({fire:3}),onState:(v,slot)=>seen[i].state.push({v,slot}),onEvent:(v,slot)=>seen[i].event.push({v,slot}),onAsset:(sig,v,slot)=>seen[i].asset.push({sig,v,slot}),onError:e=>errors.push(e.message)}));
  t.after(()=>rooms.forEach(r=>r.dispose()));
  await rooms[0].start({name:'A',kind:'toy',signature:'A'},{look:'A'});await rooms[1].start({name:'B',kind:'toy',signature:'B'},{look:'B'});
  await until(()=>rooms[1].mySlot()===1&&seen.every(s=>s.state.length&&s.asset.length),'both seats, states and assets must arrive');
  rooms[0].emit({shop:'ack'});rooms[1].emit({shop:'buy'});
  await until(()=>seen.every(s=>s.event.length),'bidirectional acknowledged events');
  assert.equal(seen[0].asset[0].slot,1);assert.equal(seen[1].asset[0].slot,0);
  assert.equal(seen[0].state[0].slot,1);assert.equal(seen[1].state[0].slot,0);
  assert(p.calls.every(c=>!Object.hasOwn(c.arg,'to')),'two-player SDK rejects room addressing');
  assert.deepEqual(errors,[]);
});

test('opt-in appearance compression delivers a clear multi-action asset beyond 1MiB JSON through the real bounded SDK',async t=>{
 const {sdks,calls}=pair(t),received=[],errors=[];
 const asset={frames:Array.from({length:96},(_,i)=>'data:image/webp;base64,'+Buffer.alloc(14000,i).toString('base64'))};
 assert(Buffer.byteLength(JSON.stringify(asset))>1024*1024);
 const rooms=sdks.map((sdk,i)=>Room.create(sdk,{protocol,maxPlayers:2,assetCompression:true,onAsset:(sig,a)=>received.push({sig,a}),onError:e=>errors.push(e.message)}));t.after(()=>rooms.forEach(r=>r.dispose()));
 await rooms[0].start({signature:'clear-A'},{body:'A'});await rooms[1].start({signature:'clear-B'},asset);
 await until(()=>received.some(r=>r.sig==='clear-B'),'full clear appearance reaches peer');
 assert.deepEqual(received.find(r=>r.sig==='clear-B').a,asset);assert.deepEqual(errors,[]);
 assert(calls.filter(c=>c.method==='transfer').every(c=>Buffer.from(c.arg.dataBase64,'base64').length<=1024*1024));
});
