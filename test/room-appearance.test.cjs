'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Room}=require('../src');
const {cleanProfile}=require('../src/room');
const {createHub}=require('./fake-sessions.cjs');
const protocol={id:'pet-kit-test',version:1};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await sleep(20);}assert.fail(label);}
function profile(signature){return {name:signature,signature,kind:'toy'};}
async function fixture(t,policy){
 const hub=createHub({latency:[2,5]}),sdks=[hub.host(),hub.guest()],received=[[],[]],errors=[],calls=[];
 const gates=new Map();
 sdks.forEach((sdk,side)=>{const transfer=sdk.transfer;sdk.transfer=async v=>{const value=JSON.parse(Buffer.from(v.dataBase64,'base64').toString());calls.push({side,signature:value.signature});const gate=gates.get(value.signature);if(gate)await gate.promise;return transfer(v);};});
 const rooms=sdks.map((sdk,side)=>Room.create(sdk,{protocol,maxPlayers:2,...(policy?{appearancePolicy:policy}:{}),onAsset:(signature,asset,slot)=>received[side].push({signature,asset,slot}),onError:e=>errors.push(e.message)}));
 t.after(()=>rooms.forEach(r=>r.dispose()));
 await rooms[0].start(profile('A'),{body:'A'});await rooms[1].start(profile('B'),{body:'B'});
 await until(()=>received.every(a=>a.length),'initial assets');
 return {hub,sdks,rooms,received,errors,calls,hold(sig){let resolve;const promise=new Promise(r=>{resolve=r;});gates.set(sig,{promise});return resolve;}};
}
test('profile signature accepts existing game signatures through 256 characters',()=>{
 assert.equal(cleanProfile(profile('s'.repeat(256))).signature.length,256);
 assert.throws(()=>cleanProfile(profile('s'.repeat(257))),/invalid_profile/);
 assert.throws(()=>Room.create({}, {protocol,appearancePolicy:'sometimes'}),/invalid_appearance_policy/);
});
test('default lobby policy defers new looks during a match and resumes in lobby',async t=>{
 const p=await fixture(t);p.rooms[0].setMatch(true);await until(()=>p.rooms[1].lobby().inMatch,'match');
 p.rooms[0].setProfile(profile('A1'),{body:'A1'});p.rooms[1].setProfile(profile('B1'),{body:'B1'});
 await sleep(500);assert.equal(p.calls.length,2);
 p.rooms[0].setMatch(false);await until(()=>p.received[0].some(a=>a.signature==='B1')&&p.received[1].some(a=>a.signature==='A1'),'lobby updates');assert.deepEqual(p.errors,[]);
});
test('continuous policy serializes in-flight updates and converges on newest profile on both sides',async t=>{
 const p=await fixture(t,'continuous');p.rooms[0].setMatch(true);await until(()=>p.rooms[1].lobby().inMatch,'match');
 const releaseA=p.hold('A1'),releaseB=p.hold('B1');
 p.rooms[0].setProfile(profile('A1'),{body:'A1'});p.rooms[1].setProfile(profile('B1'),{body:'B1'});
 await until(()=>p.calls.some(c=>c.signature==='A1')&&p.calls.some(c=>c.signature==='B1'),'both in flight');
 p.rooms[0].setProfile(profile('A2'),{body:'A2'});p.rooms[1].setProfile(profile('B2'),{body:'B2'});
 p.rooms[0].setProfile(profile('A3'),{body:'A3'});p.rooms[1].setProfile(profile('B3'),{body:'B3'});
 await until(()=>p.rooms[0].lobby().players.some(x=>x.signature==='B3'),'latest hello overtakes old transfer');
 releaseA();releaseB();
 await until(()=>p.received[0].some(a=>a.signature==='B3')&&p.received[1].some(a=>a.signature==='A3'),'latest updates');
 assert.equal(p.received[0].at(-1).asset.body,'B3');assert.equal(p.received[1].at(-1).asset.body,'A3');
 assert(!p.calls.some(c=>['A2','B2'].includes(c.signature)),'superseded unsent looks are coalesced');
 assert(p.received[0].some(a=>a.signature==='B1'),'successful superseded transfer remains cached for later reuse');
 const count=p.calls.length;p.hub.bounce(p.sdks[1]);await sleep(1250);assert.equal(p.calls.length,count,'reconnect keeps successful transfer cache');
 p.rooms[0].setProfile(profile('A1'),{body:'A1'});p.rooms[1].setProfile(profile('B1'),{body:'B1'});await sleep(500);assert.equal(p.calls.length,count,'returning to a known signature does not retransmit');
 assert.deepEqual(p.errors,[]);
});
test('dispose during transfer prevents follow-up uploads and all late asset callbacks',async t=>{
 const p=await fixture(t,'continuous'),release=p.hold('B1');p.rooms[1].setProfile(profile('B1'),{body:'B1'});
 await until(()=>p.calls.some(c=>c.signature==='B1'),'transfer started');
 p.rooms[1].setProfile(profile('B2'),{body:'B2'});p.rooms.forEach(r=>r.dispose());const count=p.calls.length,seen=p.received.map(x=>x.length);
 release();await sleep(500);assert.equal(p.calls.length,count);assert.deepEqual(p.received.map(x=>x.length),seen);assert.deepEqual(p.errors,[]);
});
test('dispose while start awaits context cannot join or start timers',async()=>{
 let release;const waiting=new Promise(r=>{release=r;});let joins=0;
 const room=Room.create({getContext:()=>waiting,join:async()=>{joins++;return {status:'connected',epoch:1};}},{protocol});
 const start=room.start(profile('A'),{body:'A'});room.dispose();release({role:'host',protocol,maxPlayers:2});
 await assert.rejects(start,/session_closed/);assert.equal(joins,0);
});
test('disposing while readTransfer is pending suppresses late rejection callbacks',async t=>{
 const p=await fixture(t,'continuous');let reading=false,reject;
 const read=p.sdks[0].readTransfer;p.sdks[0].readTransfer=()=>{reading=true;return new Promise((_,r)=>{reject=r;});};
 p.rooms[1].setProfile(profile('B1'),{body:'B1'});await until(()=>reading,'asset read pending');
 p.rooms[0].dispose();reject(Error('read_cancelled'));await sleep(100);assert.deepEqual(p.errors,[]);
 p.sdks[0].readTransfer=read;
});
test('dispose from the connected callback cannot restart Room timers or report successful start',async t=>{
 const set=global.setInterval,clear=global.clearInterval,created=[];
 global.setInterval=(...args)=>{const id=set(...args);created.push(id);return id;};
 t.after(()=>{global.setInterval=set;created.forEach(clear);});
 let room;room=Room.create({getContext:async()=>({role:'host',protocol,maxPlayers:2}),join:async()=>({status:'connected',epoch:1})},{protocol,onConnection:s=>{if(s==='connected')room.dispose();}});
 await assert.rejects(room.start(profile('A'),{body:'A'}),/session_closed/);
 assert.equal(created.length,0,'a synchronous connected listener may dispose the room');
});
test('reconnected peer is published online even when its next hello is unchanged',async t=>{
 const hub=createHub({latency:[2,5]}),sdks=[hub.host(),hub.guest()],lobbies=[];
 const rooms=sdks.map((sdk,side)=>Room.create(sdk,{protocol,onLobby:l=>{if(side===0)lobbies.push(l);}}));
 t.after(()=>rooms.forEach(r=>r.dispose()));
 await rooms[0].start(profile('A'),{body:'A'});await rooms[1].start(profile('B'),{body:'B'});
 await until(()=>rooms[0].lobby().players.length===2,'seated guest');
 hub.bounce(sdks[1]);
 await until(()=>lobbies.some(l=>l.players.some(p=>p.slot===1&&!p.online)),'offline callback');
 await sleep(150);
 assert.equal(rooms[0].lobby().players.find(p=>p.slot===1).online,true);
 assert.equal(lobbies.at(-1).players.find(p=>p.slot===1).online,true,'lobby callback must follow real online state');
});

test('compressed appearance codec preserves JSON, reads legacy assets, and bounds decoded size',async()=>{
 const C=require('../src/asset-codec'),{gzipSync}=require('node:zlib');
 const value={v:1,signature:'clear',asset:{frames:Array(96).fill('data:image/webp;base64,'+'A'.repeat(16000))}};
 const bytes=await C.encode(value);assert(Buffer.from(bytes,'base64').length<1024*1024);assert.deepEqual(await C.decode(bytes),value);
 assert.deepEqual(await C.decode(Buffer.from(JSON.stringify({old:true})).toString('base64')),{old:true});
 await assert.rejects(C.encode({oversized:'x'.repeat(C.MAX_RAW)}),/asset_too_large/);
 await assert.rejects(C.decode(gzipSync(Buffer.alloc(C.MAX_RAW+1,32)).toString('base64')),/asset_too_large/);
 await assert.rejects(C.decode(Buffer.alloc(C.MAX_PACKED+1).toString('base64')),/invalid_asset|asset_too_large/);
 await assert.rejects(C.decode('H4sIAA=='));
});
