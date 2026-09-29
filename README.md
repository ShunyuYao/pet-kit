# pet-kit

给桌宠 HTML 作品联机小游戏共用的「房间和传输」底座：座位、大厅、准备、房主设置、可靠事件通道、游戏状态流（自动压缩）、房主时钟、形象交换（只在大厅）、离开与关房、发送限额，以及每个客人的流量和状态延迟测量。

另有一个浏览器入口 `looks.js`（ES module）：读当前桌宠（2D 立绘 / 3D 布偶）、导入角色包 ZIP / 文件夹 / 图片、内置玩具形象、校验收到的形象、本地缓存。怎么把形象画出来、摆什么姿势，每款游戏自己做。

它不管玩法：状态里装什么、谁说了算、事件是什么意思、有人离开要不要换电脑、什么时候开局，都由游戏自己决定。

## 用法

```js
const {Room}=require('./vendor/pet-kit/index.js');
const room=Room.create(pet.sessions,{
  protocol:{id:'pet-bomb',version:1}, purpose:'bomb.look.v1', maxPlayers:4,
  prefs:{defaults:{team:null}, validate:cleanPrefs},        // 每个人自己的选项（客人 → 房主）
  settings:{defaults:{mode:'team'}, validate:cleanSettings}, // 房主的房间设置（房主 → 所有人）
  rates:{match:20, lobby:5, up:20},                         // 状态每秒几次
  budget:{guestBytesPerSec:15*1024},                        // 超了走 onBudget
  hostState:()=>({...}), guestState:()=>({...}),            // 游戏自己的状态
  onState(s,fromSlot){}, onEvent(e,fromSlot){},             // 收到状态 / 事件
  onLobby(lobby){}, onAsset(signature,asset,slot){}, onPeerLeft(slot,{reason,inMatch}){},
  onConnection(state){}, onClosed(reason){}, onError(err){}, onBudget(info){},
});
await room.start(profile, asset, prefs);   // profile: {name, signature, kind}
room.emit(event);                          // 客人 → 房主；房主 → 所有客人（带序号，重发到确认）
room.hostNow();                            // 对齐后的房主时钟（毫秒）
room.setMatch(true|false);                 // 房主：开局 / 回大厅（形象只在大厅传）
room.stats();                              // 每个客人的 bytesPerSec、stateAgeP95、rtt…
```

消息 key：客人 → 房主 `kit.hello`、`kit.ping`、`kit.up`；房主 → 客人 `kit.pong`、`kit.st`，共 5 个，游戏不再另开 key（宿主上限 8 个）。发送频率和字节数由 pet-kit 按宿主规则（每条通道每秒 30 次、512 KB）自己限住。

## 接进游戏

```bash
node ../pet-kit/scripts/vendor.cjs ../pet-bomb   # 把当前版本拷进 pet-bomb/vendor/pet-kit/
```

游戏的构建脚本调用 `require('../pet-kit/scripts/vendor.cjs').check(gameDir)`：游戏代码只能引用 `vendor/pet-kit/index.js`、`looks.js` 和测试用的 `testing/fake-sessions.cjs`，vendor 里的文件也不许在游戏里改，改了构建报错。

## 版本规则

- 修问题：升第三位，游戏可以直接升。
- 加能力：升第二位，旧的调用方式不变。
- 改了游戏的调用方式：升第一位，写清怎么改；旧写法再保留一个版本并在控制台提示。
- 0.x 期间入口还可能调整；水球和坦克都接上并跑稳后定为 1.0。
- 发布前把新版本放进每个用它的游戏，跑它们的规则、联机、浏览器测试，全部通过才发布。

## 测试

```bash
npm test
```

`test/fake-sessions.cjs` 是严格的模拟宿主：直接加载宿主源码里的 `contracts.js` 做校验（找不到时用简化版），并模拟每秒 30 次 / 512 KB 的固定窗口、latest 30 ms 合并、8 个 key、reliable 1024 条、每次收取 64 KB、形象一次一个且 10 秒超时，以及链路延迟、丢包和限速排队。游戏的联机测试也用它。

MIT License.
