'use strict';
// pet-kit room: the part of a LAN game that is the same in every game.
//
//   seats · lobby · ready · host settings · a reliable-over-latest event channel · the game's own
//   state stream (compressed) · host clock · avatar exchange (lobby only) · leave / close ·
//   send budgets · measurements (bytes per guest, state age, rtt)
//
// What stays in the game: what the state contains, who is authoritative for what, what the
// events mean, whether a computer player takes over a seat, when a match starts.
//
// Star topology (the host bridge's rule): the room host is slot 0; guests take slots 1..n-1 in
// the order their first hello arrives, and only ever talk to the host.
//
// Only the `latest` lane is used (`reliable` allows 1,024 messages per session). Latest
// messages can be coalesced or dropped, so events carry sequence numbers and are repeated
// until acknowledged. Keys (≤ 8 per session): guest → host  kit.hello · kit.ping · kit.up
//                                              host → guest kit.pong · kit.st
const Wire=require('./wire.js');

const VERSION='0.1.0';
const T={hello:'kit.hello',ping:'kit.ping',pong:'kit.pong',up:'kit.up',st:'kit.st'};
const HELLO_MS=1000,STALE_MS=3000,POLL_GAP=40,LOBBY_EVERY_MS=1000,CALLS_SOFT=25,BYTES_SOFT=480*1024; // host limits: 30 calls/lane and 512 KB per session per second
const MAX_EVENTS=200,MAX_EVENT_CHARS=24000,LOG_CAP=4000,AGE_SAMPLES=240;
const MAX_ASSET_B64=Math.ceil(1024*1024/3)*4;
const TRANSIENT=/backpressure|quota_exceeded|peer_offline|not_connected|session_closed/;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const KINDS=['doll3d','sprite','toy'];
function cleanProfile(p){
  if(!p||typeof p!=='object'||typeof p.signature!=='string'||!p.signature||p.signature.length>200)throw Error('invalid_profile');
  return {name:[...String(p.name||'玩家').replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g,'')].slice(0,16).join('')||'玩家',signature:p.signature,kind:KINDS.includes(p.kind)?p.kind:'toy'};
}
const pct=(arr,q)=>{if(!arr.length)return null;const s=arr.slice().sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(q*s.length))];};
const encodeAsset=v=>Wire.toB64(new TextEncoder().encode(JSON.stringify(v)));
const decodeAsset=s=>{if(typeof s!=='string'||s.length>MAX_ASSET_B64)throw Error('invalid_asset');return JSON.parse(new TextDecoder().decode(Wire.fromB64(s)));};

function create(sdk,opts={}){
  const {protocol,purpose='kit.look.v1',maxPlayers=4,now=()=>Date.now(),strict=false,compress=true,
    rates={match:20,lobby:5,up:20},budget={guestBytesPerSec:null},
    prefs:prefsSpec={defaults:{},validate:v=>v||{}},settings:settingsSpec={defaults:{},validate:v=>v||{}},
    hostState=()=>null,guestState=()=>null,
    onState=()=>{},onEvent=()=>{},onLobby=()=>{},onAsset=()=>{},onPeerLeft=()=>{},onConnection=()=>{},onClosed=()=>{},onError=()=>{},onBudget=()=>{}}=opts;
  if(!protocol||typeof protocol.id!=='string')throw Error('protocol_required');
  let context=null,host=false,connection='waiting',closed=false,disposed=false,closeReason='',cursor=0,epoch=0;
  let profile=null,asset=null,myPrefs=prefsSpec.validate({...prefsSpec.defaults}),ready=false,settings=settingsSpec.validate({...settingsSpec.defaults}),inMatch=false;
  const timers=[],recent=[];
  const note=(type,reason)=>{recent.push({t:Math.round(now()),type,reason});if(recent.length>40)recent.shift();};
  const fail=e=>{note('error',e?.message||String(e));try{onError(e instanceof Error?e:Error(String(e)));}catch{}};
  const status=s=>{if(connection!==s){connection=s;onConnection(s);}};

  // ---------- sending: plain JSON, per-destination call count, bytes metering ----------
  // State / event traffic per destination. Look transfers are counted apart (lookBytes): they
  // happen in the lobby only and are not part of the per-guest state budget.
  const meters=new Map(); // destination slot → {calls:[t...], bytes:[[t,n]...]}
  let lookBytes=0;
  const meter=slot=>{let m=meters.get(slot);if(!m){m={calls:[],bytes:[]};meters.set(slot,m);}return m;};
  function spend(slot,n){const m=meter(slot),t=now();m.calls.push(t);m.bytes.push([t,n]);while(m.calls.length&&t-m.calls[0]>=1000)m.calls.shift();while(m.bytes.length&&t-m.bytes[0][0]>=5000)m.bytes.shift();}
  const callsLeft=slot=>{const m=meter(slot),t=now();while(m.calls.length&&t-m.calls[0]>=1000)m.calls.shift();return CALLS_SOFT-m.calls.length;};
  // Bytes already sent to `slot` in the last second (the host's window is 1 s).
  const bytesLastSec=slot=>{const m=meter(slot),t=now();let n=0;for(const [at,b] of m.bytes)if(t-at<1000)n+=b;return n;};
  const bytesPerSec=slot=>{const m=meter(slot),t=now();while(m.bytes.length&&t-m.bytes[0][0]>=5000)m.bytes.shift();if(!m.bytes.length)return 0;const span=Math.max(1000,t-m.bytes[0][0]);return Math.round(m.bytes.reduce((a,b)=>a+b[1],0)/span*1000);};
  async function send(type,payload,key,to,slots){
    if(closed||disposed)throw Error('session_closed');
    const clean=Wire.plain(payload,{strict,label:type});const bytes=Wire.bytesOf(clean);
    try{const r=await sdk.send({...(to?{to}:{}),type,payload:clean,lane:'latest',key});for(const s of slots)spend(s,bytes);return r;}
    catch(e){note('send_error',type+': '+e.message);throw e;}
  }

  // ---------- events (both directions) ----------
  const log=[];let gseq=0;                 // host: [{g,o,e}]
  let outbox=[],qseq=0,lastG=0;            // guest
  function emit(e){
    const clean=Wire.plain(e,{strict,label:'event'});
    if(host){log.push({g:++gseq,o:0,e:clean});if(log.length>LOG_CAP)log.splice(0,log.length-LOG_CAP);}
    else{outbox.push({q:++qseq,e:clean});if(outbox.length>LOG_CAP)outbox.splice(0,outbox.length-LOG_CAP);}
  }
  function packEvents(list){let out=[],chars=2;for(const x of list){const n=JSON.stringify(x).length+1;if(out.length>=MAX_EVENTS||chars+n>MAX_EVENT_CHARS)break;out.push(x);chars+=n;}return out;}

  // ---------- measurements ----------
  const ages=new Map(); // slot (host: guest slot; guest: 0) → samples
  const addAge=(slot,v)=>{if(!Number.isFinite(v))return;const a=ages.get(slot)||[];a.push(Math.max(0,v));if(a.length>AGE_SAMPLES)a.shift();ages.set(slot,a);};

  // =========================== HOST ===========================
  const peers=new Map(); // sessionPeerId → peer
  let lobbySerial=0,lastSt=0,lastLobbySent=0,sentSerial=-1,sendingSt=false,uploading=false,uploadAfter=0;
  const payloads=new Map(); // signature → base64 look
  function peer(id){let p=peers.get(id);if(!p){p={id,slot:null,online:true,lastHeard:now(),profile:null,prefs:prefsSpec.validate({...prefsSpec.defaults}),ready:false,have:new Set(),sent:new Set(),pending:null,lastQ:0,gack:0,waiting:false,told:false,full:false};peers.set(id,p);}return p;}
  const seated=()=>[...peers.values()].filter(p=>p.slot!==null&&p.profile);
  function hostLobby(){
    const me={slot:0,name:profile.name,signature:profile.signature,kind:profile.kind,prefs:myPrefs,ready,online:true,waiting:false};
    const list=[me,...seated().map(p=>({slot:p.slot,name:p.profile.name,signature:p.profile.signature,kind:p.profile.kind,prefs:p.prefs,ready:p.ready,online:p.online,waiting:p.waiting}))];
    return {players:list.sort((a,b)=>a.slot-b.slot),settings,inMatch,serial:lobbySerial,looks:[...payloads.keys()].slice(0,8)};
  }
  const changed=()=>{lobbySerial++;try{onLobby(api.lobby());}catch(e){fail(e);}};
  function freeSlot(){const taken=new Set([...peers.values()].map(p=>p.slot));for(let n=1;n<maxPlayers;n++)if(!taken.has(n))return n;return null;}
  function acceptPending(p){
    const v=p.pending;if(!v||p.profile?.signature!==v.signature)return;p.pending=null;
    payloads.set(v.signature,v.data);for(const q of peers.values())if(q!==p)q.sent.delete(v.signature);
    try{onAsset(v.signature,v.asset,p.slot);}catch(e){fail(e);}
  }
  function dropPeer(id,reason){
    const p=peers.get(id);if(!p)return;peers.delete(id);ages.delete(p.slot);meters.delete(p.slot);
    if(p.slot!==null&&p.profile){try{onPeerLeft(p.slot,{reason,inMatch});}catch(e){fail(e);}changed();}
  }
  async function hostPublish(){
    const t=now(),gap=1000/(inMatch?rates.match:rates.lobby);
    if(sendingSt||t-lastSt<gap||closed)return;
    const list=[...peers.values()].filter(p=>p.slot!==null&&p.online);if(!list.length)return;
    if(list.some(p=>callsLeft(p.slot)<=0))return;
    lastSt=t;sendingSt=true;
    try{
      const minAck=Math.min(...list.map(p=>p.gack));
      const acks={};for(const p of peers.values())if(p.slot!==null)acks[p.slot]=p.lastQ;
      const k={v:VERSION,t:Math.round(t),m:inMatch,acks,ev:JSON.stringify(packEvents(log.filter(x=>x.g>minAck)))};
      if(lobbySerial!==sentSerial||t-lastLobbySent>=LOBBY_EVERY_MS){k.lob=hostLobby();sentSerial=lobbySerial;lastLobbySent=t;}
      const env={k,s:hostState()};
      const packet=await Wire.pack(Wire.plain(env,{strict,label:'hostState'}),{compress});
      const size=Wire.bytesOf(packet);
      if(list.some(p=>bytesLastSec(p.slot)+size>BYTES_SOFT)){note('skip_bytes',size);onBudget({slot:null,bytesPerSec:Math.max(...list.map(p=>bytesLastSec(p.slot))),limit:BYTES_SOFT,lastMessage:size});return;}
      await send(T.st,packet,'st','*',list.map(p=>p.slot));
      const per=Wire.bytesOf(packet);
      if(budget.guestBytesPerSec&&inMatch)for(const p of list){const b=bytesPerSec(p.slot);if(b>budget.guestBytesPerSec){note('budget',p.slot+':'+b);onBudget({slot:p.slot,bytesPerSec:b,limit:budget.guestBytesPerSec,lastMessage:per});}}
    }catch(e){if(!TRANSIENT.test(e.message))fail(e);}finally{sendingSt=false;}
    // Forget events every online guest has.
    const minAck=Math.min(...list.map(p=>p.gack));while(log.length&&log[0].g<=minAck)log.shift();
  }
  function hostUpload(){
    if(closed||uploading||inMatch||now()<uploadAfter)return;
    const own=ownPayload();if(own)payloads.set(profile.signature,own);
    const need=new Set(hostLobby().players.map(p=>p.signature));
    for(const p of peers.values()){
      if(!p.online||p.slot===null)continue;
      const next=[...need].find(sig=>sig!==p.profile?.signature&&!p.sent.has(sig)&&!p.have.has(sig)&&payloads.has(sig));if(!next)continue;
      uploading=true;
      sdk.transfer({to:p.id,purpose,contentType:'application/octet-stream',dataBase64:payloads.get(next)})
        .then(()=>{p.sent.add(next);lookBytes+=payloads.get(next).length;}).catch(e=>{uploadAfter=now()+2000;note('transfer_error',e.message);if(!TRANSIENT.test(e.message)&&!/asset_timeout/.test(e.message))fail(e);}).finally(()=>{uploading=false;});
      return;
    }
  }
  async function hostEvent(e){
    const from=e.from;
    if(e.type==='closed'){end(e.reason||'closed');return;}
    if(!from)return;
    if(e.type==='peer_left'){dropPeer(from,'left');return;}
    if(e.type==='disconnected'){const p=peers.get(from);if(p&&p.online){p.online=false;if(p.profile)changed();}return;}
    if(e.type==='connected'||e.type==='peer_joined'){const p=peer(from);p.online=true;p.lastHeard=now();return;}
    if(e.type==='resync_required'){note('resync',e.reason);return;}
    if(e.type==='transfer'){
      if(e.purpose!==purpose)return;
      const data=await sdk.readTransfer({transferId:e.transferId});
      const value=decodeAsset(data.dataBase64);if(!value||value.v!==1||typeof value.signature!=='string')throw Error('invalid_asset');
      const p=peer(from);p.lastHeard=now();
      // Only the look the guest declared as its own; it may arrive before its hello.
      p.pending={signature:value.signature,data:data.dataBase64,asset:value.asset};acceptPending(p);return;
    }
    if(e.type!=='message')return;
    const {type,payload:v}=e.message,p=peer(from);p.lastHeard=now();
    if(!p.online){p.online=true;if(p.profile)changed();}
    if(!v||typeof v!=='object')return;
    if(type===T.hello){
      let prof;try{prof=cleanProfile(v.profile);}catch{return;}
      if(p.slot===null){const n=freeSlot();if(n===null){if(!p.full){p.full=true;send(T.pong,{full:true},'pong',from,[]).catch(()=>{});}return;}p.slot=n;p.waiting=inMatch;}
      let pr;try{pr=prefsSpec.validate({...prefsSpec.defaults,...(v.prefs||{})});}catch{pr=p.prefs;}
      const before=JSON.stringify([p.profile,p.prefs,p.ready]);
      p.profile=prof;p.prefs=pr;p.ready=!!v.ready;
      p.have=new Set(Array.isArray(v.have)?v.have.filter(s=>typeof s==='string').slice(0,8):[]);
      acceptPending(p);
      if(before!==JSON.stringify([p.profile,p.prefs,p.ready]))changed();
      if(!p.told){p.told=true;send(T.pong,{slot:p.slot,h:Math.round(now())},'pong',from,[p.slot]).catch(()=>{p.told=false;});}
      return;
    }
    // Latest messages with the same key coalesce within 30 ms, so every pong repeats what the
    // guest must know (its seat, or that the room is full) instead of sending it once.
    if(type===T.ping){send(T.pong,{c:v.c,h:Math.round(now()),slot:p.slot,...(p.full?{full:true}:{})},'pong',from,p.slot===null?[]:[p.slot]).catch(()=>{});return;}
    if(type===T.up&&p.slot!==null){
      let env;try{env=await Wire.unpack(v);}catch{return;}
      const k=env&&env.k;if(!k)return;
      if(Number.isSafeInteger(k.gack))p.gack=Math.max(p.gack,Math.min(k.gack,gseq));
      if(Number.isFinite(k.t))addAge(p.slot,now()-k.t);
      let evs=[];try{evs=JSON.parse(k.ev||'[]');}catch{}
      for(const x of Array.isArray(evs)?evs:[]){if(!x||!Number.isSafeInteger(x.q)||x.q<=p.lastQ)continue;p.lastQ=x.q;try{onEvent(x.e,p.slot);}catch(err){fail(err);}}
      if(env.s!==undefined&&env.s!==null){try{onState(env.s,p.slot);}catch(err){fail(err);}}
    }
  }

  // =========================== GUEST ===========================
  let mySlot=null,full=false,lastHello=0,lastPing=0,pings=0,sendingUp=false,lastUp=0,sentSignature='',transferJob=null,guestUploadAfter=0;
  let remoteLobby={players:[],settings,inMatch:false,serial:-1},clock=[];let offset=0,rtt=null;
  const knownAssets=new Set();
  const hostNow=()=>host?now():now()+offset;
  async function guestSend(){
    const t=now();if(connection!=='connected'||closed)return;
    if(profile&&t-lastHello>=HELLO_MS&&callsLeft(0)>2){lastHello=t;send(T.hello,{profile,prefs:myPrefs,ready,have:[...knownAssets].slice(0,8),kv:VERSION},'hello',undefined,[0]).catch(e=>{if(!TRANSIENT.test(e.message))fail(e);});}
    const pingGap=pings<6||mySlot===null?400:2000; // fast until seated: the seat rides on every pong
    if(t-lastPing>=pingGap&&callsLeft(0)>2){lastPing=t;pings++;send(T.ping,{c:Math.round(t)},'ping',undefined,[0]).catch(()=>{});}
    if(mySlot===null||sendingUp||t-lastUp<1000/rates.up||callsLeft(0)<=0)return;
    lastUp=t;sendingUp=true;
    try{
      const env={k:{t:Math.round(hostNow()),gack:lastG,ev:JSON.stringify(packEvents(outbox))},s:guestState()};
      const packet=await Wire.pack(Wire.plain(env,{strict,label:'guestState'}),{compress});
      if(bytesLastSec(0)+Wire.bytesOf(packet)>BYTES_SOFT){note('skip_bytes',Wire.bytesOf(packet));return;}
      await send(T.up,packet,'up',undefined,[0]);
    }catch(e){if(!TRANSIENT.test(e.message))fail(e);}finally{sendingUp=false;}
  }
  async function guestEvent(e){
    if(e.type==='closed'){end(e.reason||'closed');return;}
    if(e.type==='resync_required'){note('resync',e.reason);return;}
    if(e.type==='transfer'){
      if(e.purpose!==purpose)return;
      const data=await sdk.readTransfer({transferId:e.transferId});
      const value=decodeAsset(data.dataBase64);if(!value||value.v!==1||typeof value.signature!=='string')throw Error('invalid_asset');
      knownAssets.add(value.signature);try{onAsset(value.signature,value.asset,null);}catch(err){fail(err);}return;
    }
    if(e.type!=='message')return;
    const {type,payload:v}=e.message;if(!v||typeof v!=='object')return;
    if(type===T.pong){
      if(v.full){full=true;end('room_full');return;}
      if(Number.isInteger(v.slot)&&v.slot>0&&v.slot<maxPlayers&&v.slot!==mySlot)mySlot=v.slot;
      if(Number.isFinite(v.c)&&Number.isFinite(v.h)){const r=Math.max(0,now()-v.c);clock.push({r,o:v.h+r/2-now()});if(clock.length>8)clock.shift();const best=clock.reduce((a,b)=>b.r<a.r?b:a);offset=best.o;rtt=rtt===null?r:rtt*0.7+r*0.3;}
      return;
    }
    if(type!==T.st)return;
    let env;try{env=await Wire.unpack(v);}catch{return;}
    const k=env&&env.k;if(!k)return;
    if(Number.isFinite(k.t))addAge(0,hostNow()-k.t);
    if(k.lob&&k.lob.serial!==remoteLobby.serial){remoteLobby=k.lob;settings=k.lob.settings;inMatch=!!k.lob.inMatch;try{onLobby(api.lobby());}catch(err){fail(err);}}
    inMatch=!!k.m;
    if(k.acks&&Number.isSafeInteger(k.acks[mySlot])){const a=k.acks[mySlot];outbox=outbox.filter(x=>x.q>a);}
    let evs=[];try{evs=JSON.parse(k.ev||'[]');}catch{}
    for(const x of Array.isArray(evs)?evs:[]){if(!x||!Number.isSafeInteger(x.g)||x.g<=lastG)continue;
      if(x.g!==lastG+1){note('event_gap',lastG+'→'+x.g);}
      lastG=x.g;try{onEvent(x.e,x.o);}catch(err){fail(err);}}
    if(env.s!==undefined&&env.s!==null){try{onState(env.s,0);}catch(err){fail(err);}}
  }
  // A look is sent only while the host's lobby says it does not have it yet, at most 3 times per
  // look: reconnects never resend it (the host keeps every look for the whole session, and the
  // host bridge caps what a session may ever transfer at 8 MB).
  const attempts=new Map();
  function guestUpload(){
    if(transferJob||!asset||inMatch||connection!=='connected'||closed||now()<guestUploadAfter||mySlot===null)return;
    const signature=profile.signature;
    if(sentSignature===signature||(remoteLobby.looks||[]).includes(signature)||(attempts.get(signature)||0)>=3)return;
    if(remoteLobby.serial<0)return; // wait for the host's first lobby
    const payload=ownPayload();if(!payload){sentSignature=signature;return;}
    attempts.set(signature,(attempts.get(signature)||0)+1);
    transferJob=sdk.transfer({purpose,contentType:'application/octet-stream',dataBase64:payload})
      .then(()=>{sentSignature=signature;lookBytes+=payload.length;}).catch(e=>{guestUploadAfter=now()+3000;note('transfer_error',e.message);if(!TRANSIENT.test(e.message)&&!/asset_timeout/.test(e.message))fail(e);}).finally(()=>{transferJob=null;});
  }

  // =========================== both ===========================
  let ownCache={signature:null,asset:null,data:null};
  function ownPayload(){
    if(!asset||!profile)return null;
    if(ownCache.signature===profile.signature&&ownCache.asset===asset)return ownCache.data;
    let data=encodeAsset({v:1,signature:profile.signature,asset});if(data.length>MAX_ASSET_B64){fail(Error('asset_too_large'));data=null;}
    ownCache={signature:profile.signature,asset,data};return data;
  }
  function end(reason='closed'){if(closed)return;closed=true;closeReason=reason;timers.forEach(clearInterval);status('closed');try{onClosed(reason);}catch(e){fail(e);}}
  async function poll(){
    let lastPoll=0;
    while(!disposed&&!closed){
      try{
        const wait=lastPoll+POLL_GAP-now();if(wait>0)await pause(wait);lastPoll=now();
        const b=await sdk.poll({cursor,waitMs:1000});if(disposed||closed)break;
        if(b.epoch!==epoch)epoch=b.epoch; // a reconnect: looks are NOT resent (see guestUpload)
        for(const e of b.events){if(e.type!=='message')note(e.type,e.reason);try{await(host?hostEvent(e):guestEvent(e));}catch(err){fail(err);}if(closed)break;}
        cursor=b.cursor;
        if(b.transportState==='closed'){end(closeReason||'closed');break;}
        if(!closed)status(b.transportState);
      }catch(e){if(/session_closed|caller_disposed|permission_denied|permission_revoked|account_changed/.test(e.message)){end(e.message);break;}status('reconnecting');fail(e);await pause(350);}
    }
  }
  const api={
    VERSION,
    async start(localProfile,localAsset,localPrefs){
      if(context)throw Error('already_started');
      context=await sdk.getContext();if(!context)throw Error('no_invitation');
      if(context.protocol?.id!==protocol.id||context.protocol?.version!==protocol.version)throw Error('protocol_mismatch');
      host=context.role==='host';profile=cleanProfile(localProfile);asset=localAsset||null;
      if(localPrefs)myPrefs=prefsSpec.validate({...prefsSpec.defaults,...localPrefs});
      if(host)mySlot=0;
      const joined=await sdk.join();epoch=joined.epoch;status(joined.status==='connected'?'connected':'waiting');void poll();
      if(host){timers.push(setInterval(()=>void hostPublish(),10),setInterval(hostUpload,200),
        setInterval(()=>{for(const p of peers.values())if(p.online&&now()-p.lastHeard>STALE_MS){p.online=false;if(p.profile)changed();}},500));changed();}
      else timers.push(setInterval(()=>void guestSend(),10),setInterval(guestUpload,200));
      return {role:context.role};
    },
    isHost:()=>host,
    mySlot:()=>mySlot,
    connection:()=>connection,
    closeReason:()=>closeReason,
    hostNow,
    lobby(){
      const l=host?hostLobby():remoteLobby;
      return {players:l.players.map(p=>({...p,you:p.slot===mySlot})),settings:host?settings:l.settings,inMatch:host?inMatch:!!l.inMatch,full,host};
    },
    setProfile(p,a){profile=cleanProfile(p);asset=a||null;sentSignature='';lastHello=0;if(host)changed();},
    setPrefs(p){myPrefs=prefsSpec.validate({...myPrefs,...p});lastHello=0;if(host)changed();},
    setReady(v){ready=!!v;lastHello=0;if(host)changed();},
    setSettings(s){if(!host)throw Error('host_only');settings=settingsSpec.validate({...settings,...s});changed();},
    // Host: the match has started (true) or returned to the lobby (false). Looks travel only in
    // the lobby; seats taken during a match are marked `waiting`.
    setMatch(v){if(!host)throw Error('host_only');inMatch=!!v;if(!inMatch)for(const p of peers.values())p.waiting=false;changed();},
    // Host: seats a waiting player into the match (the game decides when).
    seat(slot){for(const p of peers.values())if(p.slot===slot&&p.waiting){p.waiting=false;changed();}},
    emit,
    async leave(){try{await sdk.leave();}catch{}finally{end('left');}},
    dispose(){disposed=true;timers.forEach(clearInterval);},
    stats(){
      const bySlot={};for(const [slot] of meters)bySlot[slot]={bytesPerSec:bytesPerSec(slot)};
      for(const [slot,a] of ages){bySlot[slot]=bySlot[slot]||{};bySlot[slot].stateAgeP50=pct(a,0.5);bySlot[slot].stateAgeP95=pct(a,0.95);bySlot[slot].samples=a.length;}
      return {version:VERSION,role:context?.role,connection,closed,mySlot,rtt:rtt===null?null:Math.round(rtt),offset:Math.round(offset),lookBytes,
        outbox:outbox.length,log:log.length,gseq,lastG,bySlot,peers:[...peers.values()].map(p=>({slot:p.slot,online:p.online,gack:p.gack,lastQ:p.lastQ,sent:p.sent.size})),recent:recent.slice()};
    },
  };
  return api;
}
module.exports={create,VERSION,cleanProfile};
