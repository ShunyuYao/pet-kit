'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Room}=require('../src');
const {createHub}=require('./fake-sessions.cjs');
const protocol={id:'pet-kit-test',version:1},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function until(fn,label){for(let i=0;i<250;i++){if(fn())return;await sleep(10);}assert.fail(label);}
async function pair(t,options={}){
 const hub=createHub({latency:[1,2]}),sdks=[hub.host(),hub.guest()],sent=[[],[]],rooms=[];
 sdks.forEach((sdk,i)=>{const send=sdk.send;sdk.send=async packet=>{const result=await send(packet);sent[i].push(packet);return result;};});
 for(let i=0;i<2;i++)rooms.push(Room.create(sdks[i],{protocol,...options[i]}));
 t.after(()=>rooms.forEach(r=>r.dispose()));
 await rooms[0].start({name:'A',signature:'A'});await rooms[1].start({name:'B',signature:'B'});
 await until(()=>rooms[0].lobby().players.length===2&&rooms[1].mySlot()===1,'seats');
 return {hub,sdks,sent,rooms};
}
test('async state reaches application before callback completion, successful sends notify with the actual state',async t=>{
 const gate=deferred(),received=[],accepted=[];
 const p=await pair(t,{0:{hostState:async()=>{await gate.promise;return {serial:7};},onStateSent:s=>accepted.push(s)},1:{onState:async s=>{await sleep(15);received.push(s);}}});
 await sleep(100);assert(!p.sent[0].some(m=>m.type==='kit.st'));
 gate.resolve();await until(()=>received.length&&accepted.length,'async state');
 assert.deepEqual(received[0],{serial:7});assert.deepEqual(accepted[0],{serial:7});
});
test('disposing while async host state is pending prevents sending and sent notification',async t=>{
 const gate=deferred();let entered=false,accepted=0;
 const p=await pair(t,{0:{hostState:async()=>{entered=true;await gate.promise;return {n:1};},onStateSent:()=>accepted++}});
 await until(()=>entered,'state pending');p.rooms[0].dispose();gate.resolve();await sleep(100);
 assert(!p.sent[0].some(m=>m.type==='kit.st'));assert.equal(accepted,0);
});
test('epoch reset invalidates pending async state and reports reset before replacement state',async t=>{
 const gate=deferred(),resets=[],accepted=[];let entered=false,held=true;
 const p=await pair(t,{0:{hostState:async()=>{if(held){entered=true;await gate.promise;return {old:true};}return {old:false};},onReset:e=>resets.push(e),onStateSent:s=>accepted.push(s)}});
 await until(()=>entered,'pending state');p.hub.bounce(p.sdks[0]);
 await until(()=>resets.some(e=>e.reason==='epoch'),'epoch reported');held=false;gate.resolve();
 await until(()=>accepted.some(s=>s.old===false),'replacement state');assert(!accepted.some(s=>s.old));
});
test('undefined guest state preserves idle heartbeat control while acknowledged events still travel',async t=>{
 const events=[];let value;
 const p=await pair(t,{0:{onEvent:e=>events.push(e)},1:{guestState:()=>value}});
 await sleep(200);assert.equal(p.sent[1].filter(m=>m.type==='kit.up').length,0);
 value={input:3};await p.rooms[1].flushState();await until(()=>p.sent[1].some(m=>m.type==='kit.up'),'explicit state');
 value=undefined;p.rooms[1].emit({ready:true});await until(()=>events.some(e=>e.ready),'event despite suppressed state');
 assert.throws(()=>Room.create({}, {protocol,budget:{callsPerSecond:30}}),/invalid_call_budget/);
});
test('missing look receipt retries within a bound; acknowledged looks survive reconnect without resending',async t=>{
 const hub=createHub({latency:[1,2]}),sdks=[hub.host(),hub.guest()],got=[],errors=[];
 let offset=0,calls=0;const transfer=sdks[0].transfer;
 sdks[0].transfer=arg=>{calls++;return calls===1?Promise.resolve({transferId:'not-delivered'}):transfer(arg);};
 const rooms=sdks.map((sdk,i)=>Room.create(sdk,{protocol,now:()=>Date.now()+offset,onAsset:(sig)=>{if(i===1)got.push(sig);},onError:e=>errors.push(e.message)}));
 t.after(()=>rooms.forEach(r=>r.dispose()));
 await rooms[0].start({name:'A',signature:'A'},{body:'A'});await rooms[1].start({name:'B',signature:'B'});
 await until(()=>calls===1,'initial queued look');assert.deepEqual(got,[]);offset=9000;
 await until(()=>got.includes('A'),'missing receipt retries');
 await until(()=>rooms[0].stats().ownSentSignature==='A','explicit look receipt');
 hub.bounce(sdks[1]);offset+=9000;await sleep(1200);
 assert.equal(calls,2);assert.equal(got.length,1);assert.deepEqual(errors,[]);
});
test('multiplayer host reports session-wide resync without a sender before the next state',async t=>{
 const hub=createHub(),sdk=hub.host(),poll=sdk.poll,resets=[];let injected=false;
 sdk.poll=async arg=>{const batch=await poll(arg);if(!injected){injected=true;batch.events.unshift({type:'resync_required',reason:'delivery_failed'});}return batch;};
 const room=Room.create(sdk,{protocol,onReset:e=>resets.push(e)});t.after(()=>room.dispose());await room.start({name:'A',signature:'A'});
 await until(()=>injected,'real poll injection');await sleep(80);
 assert(resets.some(e=>e.reason==='delivery_failed'),'session-wide resync must reach the async codec even without a peer id');
});
test('rejected sends never notify success; a disposed pending SDK send cannot notify either',async t=>{
 const hub=createHub({latency:[1,2]}),sdks=[hub.host(),hub.guest()],gate=deferred(),sent=[];
 let held=false,rejected=false,serial=0;const send=sdks[0].send;
 sdks[0].send=async m=>{if(m.type==='kit.st'){if(!rejected){rejected=true;throw Object.assign(Error('backpressure'),{code:'backpressure'});}held=true;await gate.promise;}return send(m);};
 const rooms=[Room.create(sdks[0],{protocol,hostState:()=>({serial:++serial}),onStateSent:s=>sent.push(s)}),Room.create(sdks[1],{protocol})];t.after(()=>rooms.forEach(r=>r.dispose()));
 await rooms[0].start({name:'A',signature:'A'});await rooms[1].start({name:'B',signature:'B'});
 await until(()=>held,'actual SDK send pending');assert(rejected);assert.deepEqual(sent,[]);
 rooms[0].dispose();gate.resolve();await sleep(100);assert.deepEqual(sent,[]);
});
