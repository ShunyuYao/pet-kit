'use strict';
// pet-kit contract tests. Everything goes through the public entry (src/index.js) over the strict
// fake host (test/fake-sessions.cjs), with real timers. Each test states the promise a game can
// rely on.
const test=require('node:test'),assert=require('node:assert/strict');
const {Room,Wire}=require('../src/index.js');
const {createHub}=require('./fake-sessions.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label,ms=5000){const until=Date.now()+ms;while(Date.now()<until){if(fn())return;await sleep(20);}throw Error('timeout: '+label);}
const PROTOCOL={id:'pet-kit-test',version:1};

// A tiny "game": the host streams a counter plus some padding; guests stream their own x.
function player(sdk,name,{pad=0,extra={},look=null}={}){
  const got={states:[],events:[],assets:new Map(),left:[],closed:null,errors:[],budget:[]};
  let n=0,x=0;
  const room=Room.create(sdk,{protocol:PROTOCOL,strict:true,
    prefs:{defaults:{team:null},validate:v=>({team:v.team===0||v.team===1?v.team:null})},
    settings:{defaults:{rounds:3},validate:v=>({rounds:[3,5].includes(v.rounds)?v.rounds:3})},
    hostState:()=>({n:++n,pad:'x'.repeat(pad)}),guestState:()=>({x:++x}),
    onState:(s,slot)=>got.states.push({s,slot,at:Date.now()}),onEvent:(e,from)=>got.events.push({e,from}),
    onAsset:(sig,a,slot)=>got.assets.set(sig,a),onPeerLeft:(slot,info)=>got.left.push({slot,info}),
    onClosed:r=>{got.closed=r;},onError:e=>got.errors.push(e.message),onBudget:b=>got.budget.push(b),...extra});
  return {room,got,name,sdk,start:()=>room.start({name,signature:'sig:'+name,kind:'toy'},look,null)};
}
const stopAll=list=>list.forEach(p=>p.room.dispose());

test('wire: plain() names the first non-JSON path in strict mode and cleans it otherwise',()=>{
  assert.throws(()=>Wire.plain({a:[1,{b:undefined}]},{strict:true}),/\$\.a\[1\]\.b is undefined/);
  assert.throws(()=>Wire.plain({n:NaN},{strict:true}),/\$\.n is NaN/);
  assert.deepEqual(Wire.plain({a:undefined,n:NaN,k:1}),{n:null,k:1});
});

test('wire: pack() gzips big messages, each decodes on its own, small ones stay plain',async()=>{
  const big={list:Array.from({length:400},(_,i)=>({i,name:'player'+(i%4)}))};
  const p=await Wire.pack(big);assert.ok(p.z&&p.z.length<JSON.stringify(big).length/3,'compressed well');
  assert.deepEqual(await Wire.unpack(p),big);
  assert.deepEqual(await Wire.pack({a:1}),{j:{a:1}});
});

test('seats: host is 0, guests get 1..3 in hello order, a fifth player is told the room is full',{timeout:20000},async()=>{
  const hub=createHub();const H=player(hub.host(),'房主'),G=[1,2,3,4].map(i=>player(hub.guest(),'客人'+i));
  try{
    await H.start();for(const g of G){await g.start();await sleep(150);}
    await waitFor(()=>G.slice(0,3).every(g=>g.room.mySlot()!==null),'three seated');
    assert.deepEqual(G.slice(0,3).map(g=>g.room.mySlot()),[1,2,3]);
    await waitFor(()=>G[3].got.closed==='room_full','fifth told full');
    await waitFor(()=>G.slice(0,3).every(g=>g.room.lobby().players.length===4),'everyone sees 4 players');
    assert.deepEqual(G[0].room.lobby().players.map(p=>p.name),['房主','客人1','客人2','客人3']);
    assert.ok(hub.usesHostContracts,'validated with the host\'s own contracts.js');
  }finally{stopAll([H,...G]);}
});

test('lobby: prefs and ready travel to everyone, settings are host-only',{timeout:20000},async()=>{
  const hub=createHub();const H=player(hub.host(),'房主'),A=player(hub.guest(),'甲'),B=player(hub.guest(),'乙');
  try{
    await H.start();await A.start();await B.start();
    A.room.setPrefs({team:1});A.room.setReady(true);H.room.setSettings({rounds:5});
    await waitFor(()=>{const p=B.room.lobby().players.find(x=>x.name==='甲');return p&&p.prefs.team===1&&p.ready&&B.room.lobby().settings.rounds===5;},'B sees A ready on team 1 and 5 rounds');
    assert.throws(()=>A.room.setSettings({rounds:3}),/host_only/);
    A.room.setPrefs({team:7});await waitFor(()=>H.room.lobby().players.find(x=>x.name==='甲').prefs.team===null,'invalid prefs are cleaned by the game validator');
  }finally{stopAll([H,A,B]);}
});

test('state stream: both directions, compressed when big, state age and bytes are measured',{timeout:20000},async()=>{
  const hub=createHub({latency:[20,40]});const H=player(hub.host(),'房主',{pad:3000}),A=player(hub.guest(),'甲');
  try{
    await H.start();await A.start();await waitFor(()=>A.room.mySlot()===1,'seated');H.room.setMatch(true);
    await sleep(2500);
    const hs=A.got.states.filter(x=>x.slot===0),gs=H.got.states.filter(x=>x.slot===1);
    assert.ok(hs.length>30&&gs.length>30,'≈20 Hz each way: '+hs.length+'/'+gs.length);
    assert.ok(hs.every((x,i)=>i===0||x.s.n>hs[i-1].s.n),'host states arrive in order (older ones dropped)');
    const st=H.room.stats().bySlot[1],gst=A.room.stats().bySlot[0];
    assert.ok(st.bytesPerSec>0&&st.bytesPerSec<20*3000/5,'3 KB of padding × 20 Hz compressed at least 5×: '+st.bytesPerSec+' B/s to the guest');
    assert.ok(gst.stateAgeP95!==null&&gst.stateAgeP95<150,'guest state age p95 '+gst.stateAgeP95);
    assert.equal(hub.stats.backpressure,0);
  }finally{stopAll([H,A]);}
});

test('events: exactly once, in order, both ways, under 25% loss',{timeout:30000},async()=>{
  const hub=createHub({latency:[5,60],loss:0.25});const H=player(hub.host(),'房主'),A=player(hub.guest(),'甲'),B=player(hub.guest(),'乙');
  try{
    await H.start();await A.start();await B.start();await waitFor(()=>A.room.mySlot()&&B.room.mySlot(),'seated');H.room.setMatch(true);
    for(let i=1;i<=60;i++){A.room.emit({k:'a',i});H.room.emit({k:'h',i});if(i%3===0)B.room.emit({k:'b',i});await sleep(25);}
    await waitFor(()=>H.got.events.filter(x=>x.e.k==='a').length>=60&&A.got.events.filter(x=>x.e.k==='h').length>=60&&B.got.events.filter(x=>x.e.k==='h').length>=60&&H.got.events.filter(x=>x.e.k==='b').length>=20,'all events delivered',15000);
    await sleep(500);
    const seq=(list,k)=>list.filter(x=>x.e.k===k).map(x=>x.e.i);
    assert.deepEqual(seq(H.got.events,'a'),Array.from({length:60},(_,i)=>i+1),'guest → host once, in order');
    assert.deepEqual(seq(A.got.events,'h'),Array.from({length:60},(_,i)=>i+1),'host → guest A once, in order');
    assert.deepEqual(seq(B.got.events,'h'),Array.from({length:60},(_,i)=>i+1),'host → guest B once, in order');
    assert.ok(H.got.events.filter(x=>x.e.k==='a').every(x=>x.from===A.room.mySlot()),'host learns the sender slot');
    assert.ok(hub.stats.dropped>20,'loss really happened: '+hub.stats.dropped);
  }finally{stopAll([H,A,B]);}
});

test('clock: a guest\'s host clock is within 25 ms of the host\'s',{timeout:20000},async()=>{
  const hub=createHub({latency:[20,50]});const H=player(hub.host(),'房主'),A=player(hub.guest(),'甲');
  try{
    await H.start();await A.start();await waitFor(()=>A.room.mySlot()===1,'seated');await sleep(3000);
    assert.ok(Math.abs(A.room.hostNow()-H.room.hostNow())<25,'offset error '+(A.room.hostNow()-H.room.hostNow()));
  }finally{stopAll([H,A]);}
});

test('looks: a look that arrives before its owner\'s hello is kept; the host relays looks in the lobby only',{timeout:30000},async()=>{
  const hub=createHub();const look=n=>({kind:'sprite',image:'data:image/png;base64,'+'A'.repeat(2000)+n});
  const H=player(hub.host(),'房主',{look:look('h')}),A=player(hub.guest(),'甲',{look:look('a')});
  try{
    // A's look goes out before A's first hello: start the transfer by hand, then start the room.
    await H.start();
    const early=hub.guest();const E=player(early,'早到',{look:look('e')});
    await early.join();
    await early.transfer({purpose:'kit.look.v1',contentType:'application/octet-stream',dataBase64:Wire.toB64(new TextEncoder().encode(JSON.stringify({v:1,signature:'sig:早到',asset:look('e')})))});
    await sleep(200);assert.ok(!H.got.assets.has('sig:早到'),'not accepted before the hello');
    await E.room.start({name:'早到',signature:'sig:早到',kind:'sprite'},look('e'));
    await waitFor(()=>H.got.assets.has('sig:早到'),'accepted once the hello names it');
    await A.start();
    await waitFor(()=>A.got.assets.has('sig:房主')&&A.got.assets.has('sig:早到'),'A receives the host\'s and the early guest\'s looks',8000);
    // During a match nothing is relayed: a new player's look waits for the lobby.
    H.room.setMatch(true);const transfers=hub.stats.transfers;
    const L=player(hub.guest(),'迟到',{look:look('l')});await L.start();
    await sleep(1500);
    assert.equal(hub.stats.transfers,transfers,'no look transfers during a match');
    assert.ok(H.room.lobby().players.find(p=>p.name==='迟到').waiting,'a seat taken during a match is waiting');
    H.room.setMatch(false);
    await waitFor(()=>A.got.assets.has('sig:迟到')&&L.got.assets.has('sig:甲'),'looks flow again in the lobby',8000);
    const n=hub.stats.transfers;await sleep(1200);assert.equal(hub.stats.transfers,n,'a look already delivered is not sent again');
    stopAll([L,E]);
  }finally{stopAll([H,A]);}
});

test('leaving: the host hears which seat left; the host leaving closes the room for guests',{timeout:20000},async()=>{
  const hub=createHub();const H=player(hub.host(),'房主'),A=player(hub.guest(),'甲'),B=player(hub.guest(),'乙');
  try{
    await H.start();await A.start();await B.start();await waitFor(()=>B.room.lobby().players.length===3&&A.room.mySlot()!==null,'lobby');
    const slotA=A.room.mySlot();H.room.setMatch(true);await A.room.leave();
    await waitFor(()=>H.got.left.length===1,'host hears');assert.deepEqual(H.got.left[0],{slot:slotA,info:{reason:'left',inMatch:true}});
    await waitFor(()=>B.room.lobby().players.length===2,'B\'s lobby drops A');
    await H.room.leave();await waitFor(()=>B.got.closed!==null,'B closed');
    assert.equal(B.room.connection(),'closed');
  }finally{stopAll([H,A,B]);}
});

test('budget: 4 players for 6 s never exceed 30 sends/s per channel; over-budget bytes are reported',{timeout:30000},async()=>{
  const hub=createHub({latency:[5,30]});
  const H=player(hub.host(),'房主',{pad:40000,extra:{compress:false,budget:{guestBytesPerSec:200*1024}}});
  const G=[1,2,3].map(i=>player(hub.guest(),'客人'+i));
  try{
    await H.start();for(const g of G)await g.start();await waitFor(()=>G.every(g=>g.room.mySlot()),'seated');
    H.room.setMatch(true);for(const g of G)g.room.setReady(true);
    const t0=Date.now();while(Date.now()-t0<6000){for(const g of G)g.room.emit({t:Date.now()});H.room.emit({t:Date.now()});await sleep(30);}
    assert.equal(hub.stats.backpressure,0,'no send refused');
    // Receive-side bunching (a busy event loop) can still make the host drop a few latest
    // messages with resync_required, as manager.js documents; events are repeated anyway.
    assert.ok(hub.stats.resync<=6,'receive-side resyncs '+hub.stats.resync);
    assert.ok(H.got.budget.length>0,'40 KB × 20 Hz uncompressed is reported against a 200 KB/s budget');
    for(const p of [H,...G])assert.deepEqual(p.got.errors,[],p.name+' errors');
  }finally{stopAll([H,...G]);}
});

test('slow link: at 1 Mbps / 100 ms a 10 KB state queues up without compression and stays fresh with it',{timeout:40000},async()=>{
  const run=async compress=>{
    const hub=createHub({latency:[45,55],bandwidth:125000});
    const H=player(hub.host(),'房主',{extra:{compress,hostState:()=>({list:Array.from({length:280},(_,i)=>({i,x:+(Math.sin(i+Date.now()/300)*10).toFixed(2),name:'actor'+i}))})}}),A=player(hub.guest(),'甲');
    try{await H.start();await A.start();await waitFor(()=>A.room.mySlot()===1,'seated');H.room.setMatch(true);await sleep(5000);return A.room.stats().bySlot[0].stateAgeP95;}
    finally{stopAll([H,A]);}
  };
  const raw=await run(false),zipped=await run(true);
  assert.ok(zipped<250,'compressed age p95 '+zipped);
  assert.ok(raw>2*zipped,'the control really queues: raw '+raw+' ms vs compressed '+zipped+' ms');
});

test('boundary: pet-kit source only requires its own files (never a game)',()=>{
  const fs=require('node:fs'),path=require('node:path');const dir=path.join(__dirname,'../src');
  for(const f of fs.readdirSync(dir))for(const m of fs.readFileSync(path.join(dir,f),'utf8').matchAll(/(?:require\(|from\s+)['"]([^'"]+)['"]/g))assert.match(m[1],/^\.\/[a-z-]+\.js$/,f+' imports '+m[1]);
});

test('reconnects never resend looks (the host bridge caps a session at 8 MB of transfers)',{timeout:40000},async()=>{
  const hub=createHub();const big=n=>({kind:'sprite',image:'data:image/png;base64,'+'Q'.repeat(400*1024)+n});
  const H=player(hub.host(),'房主',{look:big('h')}),A=player(hub.guest(),'甲',{look:big('a')}),B=player(hub.guest(),'乙',{look:big('b')});
  try{
    await H.start();await A.start();await B.start();
    await waitFor(()=>A.got.assets.size===2&&B.got.assets.size===2&&H.got.assets.size===2,'every look arrives once',15000);
    const n=hub.stats.transfers;assert.equal(n,6,'3 uploads + relays: each look reaches each other player once');
    for(let i=0;i<12;i++){hub.bounce(i%2?A.sdk:B.sdk);await sleep(250);}
    await sleep(1500);
    assert.equal(hub.stats.transfers,n,'12 reconnects, no transfer repeated');
    for(const p of [H,A,B])assert.notEqual(p.room.connection(),'closed');
  }finally{stopAll([H,A,B]);}
});
