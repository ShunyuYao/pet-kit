# pet-kit

给桌宠 HTML 作品联机小游戏共用的「房间和传输」底座：座位、大厅、准备、房主设置、可靠事件通道、游戏状态流（自动压缩）、房主时钟、形象交换（默认只在大厅，可选局内更新）、离开与关房、发送限额，以及每个客人的流量和状态延迟测量。

另有一个浏览器入口 `looks.js`（ES module）：读当前桌宠（2D 立绘 / 3D 布偶）、导入角色包 ZIP / 文件夹 / 图片、内置玩具形象、校验收到的形象、本地缓存。怎么把形象画出来、摆什么姿势，每款游戏自己做。

它不管玩法：状态里装什么、谁说了算、事件是什么意思、有人离开要不要换电脑、什么时候开局，都由游戏自己决定。

## 用法

```js
const {Room}=require('./vendor/pet-kit/index.js');
const room=Room.create(pet.sessions,{
  protocol:{id:'pet-bomb',version:1}, purpose:'bomb.look.v1', maxPlayers:4,
  appearancePolicy:'lobby',                               // 可选 continuous：局内也同步形象
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
room.setMatch(true|false);                 // 房主：开局 / 回大厅（形象传输遵循 appearancePolicy）
room.stats();                              // 每个客人的 bytesPerSec、stateAgeP95、rtt…
```

消息 key：客人 → 房主 `kit.hello`、`kit.ping`、`kit.up`；房主 → 客人 `kit.pong`、`kit.st`，共 5 个，游戏不再另开 key（宿主上限 8 个）。发送频率和字节数由 pet-kit 按宿主规则（每条通道每秒 30 次、512 KB）自己限住。

## 双人与多人宿主契约

Room 按 `getContext().maxPlayers` 选择宿主 API：缺省或 `2` 是双人会话，不发送 `to`，将没有 `from` 的事件映射为唯一对端；大于 `2` 保持既有星形房间的寻址方式。`opts.maxPlayers` 控制游戏允许的席位数，不能替代宿主 context 的能力声明。房主始终为席位 `0`，双人客人为 `1`。

`onState` / `onEvent` 的来源是席位；双人 `onAsset(signature, asset, slot)` 也明确返回 `0` 或 `1`。多人房主收到客人的素材时返回来源席位，多人客人收到房主转发的素材时仍返回 `null`，游戏按大厅中的 signature 对照玩家。

## 局内形象更新

`appearancePolicy` 默认 `lobby`，保留水球、坦克等现有行为；黄金矿工等需要同局换形象的游戏显式选择 `continuous`。调用 `setProfile(profile, asset)` 更新摘要和完整素材，signature 必须随素材变化，最长 256 个字符；素材保持 JSON 可序列化，单次上限及会话累计限额仍由宿主控制。较大的连续形象更新会占用网络带宽，应在真实网络上验证。

每个发送端同一时间仅传一个素材；传输中发生多次更换，当前传输结束后直接发送最新仍需要的素材。每个成功传输过的 signature 保留缓存，重连或切回旧形象不重复发送。`onAsset` 是素材入库通知，游戏应保存 signature → asset，并在 `onLobby` 的玩家 signature 改变时选用对应缓存，不能假设每次切换都会再次触发 `onAsset`。

`dispose()` 停止本地计时器、轮询及后续上传，忽略已在途异步回调；它不替代 `leave()` 的会话释放。主动退出应先调用 `leave()`，最终再 `dispose()`；宿主会负责中止已开启的会话传输。游戏窗口销毁也仍由宿主调用方生命周期回收。客人向房主上传同一形象最多尝试三次；房主向客人的转发失败后按既有两秒退避继续尝试。失败信息通过 `onError`/`stats().recent` 诊断，宿主的会话累计限额仍然生效。

## 接进游戏

```bash
node ../pet-kit/scripts/vendor.cjs ../pet-bomb   # 把当前版本拷进 pet-bomb/vendor/pet-kit/
```

导出同时写入 `VERSION.json`（版本及源码摘要）和独立校验器。游戏构建调用 `require('../vendor/pet-kit/verify.cjs').check(gameDir)`，只依赖本仓库固定副本，不需要同级目录的最新 pet-kit。游戏代码只能引用 `index.js`、`looks.js` 和测试用的 `testing/fake-sessions.cjs`；构建脚本可调用 `verify.cjs`。副本被修改或业务代码引用内部模块会使构建失败，必须回到 pet-kit 修改并重新导出。

## 版本规则

- 修问题：升第三位，游戏可以直接升。
- 加能力：升第二位，旧的调用方式不变。
- 改了游戏的调用方式：升第一位，写清怎么改；旧写法再保留一个版本并在控制台提示。
- 0.x 期间入口还可能调整；水球和坦克都接上并跑稳后定为 1.0。
- 发布前把新版本放进每个用它的游戏，跑它们的规则、联机、浏览器测试，全部通过才发布。

## 测试

```bash
PET_HOST_ROOT=/absolute/path/to/host npm test
```

`test/room-host.test.cjs` 必须显式提供实际宿主 `PET_HOST_ROOT`，通过真实 manager / shared SDK 验证双人席位、双向状态、事件与素材；缺少路径直接失败，不将跳过视为通过。该测试的双向底层传输线为内存连接，真实 Electron 和公网质量仍由游戏 E2E 验收。

`test/room-appearance.test.cjs` 验证默认大厅策略、连续换形象、在途更新、缓存重连与销毁边界。`test/vendor.test.cjs` 验证独立副本可校验，以及篡改与内部导入确实被拒绝；两者均纳入 `npm test`。

`test/fake-sessions.cjs` 是严格的模拟宿主：直接加载宿主源码里的 `contracts.js` 做校验（找不到时用简化版），并模拟每秒 30 次 / 512 KB 的固定窗口、latest 30 ms 合并、8 个 key、reliable 1024 条、每次收取 64 KB、形象一次一个且 10 秒超时，以及链路延迟、丢包和限速排队。游戏的联机测试也用它。

本轮候选范围及证据见 [0.2.0 验收记录](docs/internet-play-validation.md)。

MIT License.
