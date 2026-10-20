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

导出同时写入 `VERSION.json`（版本及源码摘要）和独立校验器。游戏构建调用 `require('../vendor/pet-kit/verify.cjs').check(gameDir)`，只依赖本仓库固定副本，不需要同级目录的最新 pet-kit。游戏代码只能引用 `index.js`、`looks.js`、`motion.js` 和测试用的 `testing/fake-sessions.cjs`；构建脚本可调用 `verify.cjs`。副本被修改或业务代码引用内部模块会使构建失败，必须回到 pet-kit 修改并重新导出。

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

### 0.2.1 异步游戏状态

`hostState`、`guestState` 与 `onState` 可返回 Promise，Room 串行等待；关闭、销毁或 epoch/resync 改变会废弃仍在准备的发送。`onStateSent(state)` 只在该状态被 SDK 接受且生命周期仍有效时调用，不能当作对端应用确认。游戏差分必须继续使用对端应用后的 ACK。

`onReset({reason,epoch})` 在处理新 epoch 或 resync 事件时通知游戏清理基线；通知先于该批状态应用。`flushState()` 请求按既有间隔和预算刷新，不绕过限速。`guestState` 显式返回 `undefined` 可抑制无变化的应用心跳，但事件重传/确认仍发送；默认 `null` 保留原速率。高频游戏可明确设 `budget.callsPerSecond`（1–28，默认25，预留宿主30次上限的余量）。

`pollGapMs` 默认40ms；实时游戏可以显式选0，继续使用 SDK 的1000ms长等待而不再增加轮询后的固定缓冲。消息仍遵守发送预算，不能换成空结果忙轮询的非正式 SDK。

形象仅在未收到签名确认且经过8秒时补传，最多再试两次；已经确认的签名跨重连保留缓存。`stats().ownSentSignature` 是当前形象的接收签名确认，不是仅排队成功。具名 `test:state` 验证异步/关闭/重置/空闲输入与素材补传，纳入 `npm test`。这些是内嵌游戏库能力，没有新增宿主 SDK 权限或方法。

`test/fake-sessions.cjs` 是严格的模拟宿主：直接加载宿主源码里的 `contracts.js` 做校验（找不到时用简化版），并模拟每秒 30 次 / 512 KB 的固定窗口、latest 30 ms 合并、8 个 key、reliable 1024 条、每次收取 64 KB、形象一次一个且 10 秒超时，以及链路延迟、丢包和限速排队。游戏的联机测试也用它。

本轮候选范围及证据见 [0.2.0 验收记录](docs/internet-play-validation.md)。

MIT License.

## 0.3.0 运动呈现 / Motion presentation

`Motion` 是独立的显示缓冲，不自动启用，也不依赖 Room。已有房间、权限和发送节奏保持原样。使用整包的 `require('./vendor/pet-kit/index.js').Motion`，或仅使用 `require('./vendor/pet-kit/motion.js')`，避免把不需要的房间代码打入游戏。

```js
const Motion = require('./vendor/pet-kit/motion.js');
const remote = Motion.create({
  delayMs: 150,
  interpolate: (a, b, f) => ({x: a.x + (b.x - a.x) * f}),
});
// 收到一个经过游戏校验的样本。sampleMs 是产生位置的模拟时钟。
remote.push({time: packet.sampleMs, key: packet.round, value: packet.pose}, performance.now());
// 每个绘制帧；只把结果交给绘图，不写回碰撞或计分状态。
const visualPose = remote.sample(performance.now());
```

- `time` 是有限的毫秒数，在同一 `key` 内严格递增。两次收到同一位置样本，必须保留同一个 `time`；转发者不能改成转发时刻。`receivedAt` 与 `sample(now)` 使用接收端同一个单调时钟。各玩家用独立缓冲，不把不同来源的时钟混在一起。
- `key` 使用稳定的原始值（如局号/阶段字符串）。换局、换轨、重新拥有控制权、暂停恢复、复活、传送等由游戏主动 `reset()` 或改变 `key`；游戏必须先拒绝旧局消息，再推入缓冲。库不知道局号的新旧顺序。
- 默认 `delayMs=100`、`capacity=32`、`resetAfterMs=1000`、`maxProjectionMs=0`。容量可设 2–512，空缓冲返回 `null`；一个样本只保持原位。超过一秒的收包空窗重设时间基线。暂停时游戏应停止采样或显式重置，不能靠重复的时间戳维持动画。
- `interpolate(a,b,f,spanMs)` 只描述连续字段。可选 `project(a,b,aheadMs,spanMs)` 仅在显式设置 `maxProjectionMs>0` 时启用，`aheadMs` 永远不超过该上限；到达上限后冻结。边界、角度、碰撞、回收位置等由游戏自己约束。`discontinuous(a,b,spanMs)` 返回 true 会直接选 b，禁止穿过传送或离散动作。
- 输入、历史和返回值隔离复制；只接收可 structuredClone 的值。重复/过期时间丢弃，队列有上限。`stats()` 返回 frames、dropped、resets、mode、lastSampleTime、lastReceived；mode 有 empty / buffering / interpolating / discontinuous / projecting / exhausted。这里没有网络 RTT、丢包率或玩法错误的推断。
- 自己操作的角色不应套远端缓冲延迟；本地预测、输入确认、回滚重演、服务器纠偏均归游戏处理。房间重连、实体生命周期与物理世界也仍归游戏。

接入顺序：先真实复现 → 给位置定义原始时间和生命周期 → 固定 vendor → 单独适配绘制层 → 验证自己/对方、普通/批次收包、动作边界及完整玩法 → 更新游戏产物、宿主清单和缓存。当前迁移赛车、颜料、食堂、矿工，其他游戏继续固定它们原有版本，不会因库更新自动改变行为。

English contract: Motion is an opt-in, transport-independent presentation buffer. Supply original simulation timestamps in milliseconds, keep them unchanged when relaying, and use one monotonic receiver clock for push/sample. Use separate buffers per clock/actor. The game owns authority, prediction, collisions, discontinuities and stale-generation rejection. Reset on lifecycle transitions. Values and callback arguments are cloned, history is bounded, duplicates are rejected, and extrapolation is disabled unless explicitly supplied and bounded. Never write sampled poses back into the simulation. The two CommonJS public imports above expose the same implementation. `npm run test:motion` belongs to `npm test`; game E2E remains mandatory.

## Appearance compression (0.3.1)

`Room.create(sdk, {assetCompression: true, ...})` opts a game into lossless gzip of the entire appearance envelope. The default remains legacy JSON. Updated rooms read both encodings; use the same pinned kit/artifact on all peers. `Assets.encode(value)` / `Assets.decode(base64)` expose the same bounded codec for a game to choose its image-quality budget before publishing a profile.

Actual transfer bytes remain at most 1 MiB. Decoded JSON is bounded to 4 MiB and decompression stops at that limit. Compression runs once per immutable appearance/signature without holding up state/input traffic. Superseded, closed or disposed encodes cannot publish stale assets. Games still own frame counts, image quality, profile validation and reaction semantics.

Verification: `PET_HOST_ROOT=/absolute/host npm test` covers the real host SDK size bound, legacy input, exact round trips and oversized/corrupt compressed input. The fix was triggered by full reaction sets exceeding 1 MiB when retaining clear frames; shrinking frame dimensions was masking that boundary.
