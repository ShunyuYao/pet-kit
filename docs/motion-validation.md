# Motion 0.3.0 验证 / Validation

2026-10-14。用户授权将重复的联机运动呈现问题收敛到公共库，并逐个适配游戏。此版本沿用 0.2.1 的 Room 契约，新增独立 Motion 公共入口，不是宿主 SDK 新 API。

## 公共层

`PET_HOST_ROOT=<实际宿主> npm test` 首次 39 项中 37 项通过，2 项 vendor 测试仍断言旧版本而失败；更新版本契约后 `npm run test:vendor` 3/3 通过。运动 7 项测试涵盖批次收包、重复/乱序、有限推算、换局/长空窗、状态隔离、传送和容量/时钟。无缺依赖 SKIP。vendor 检查新增独立 motion.js 公共入口。

## 消费者

- 赛车 0.5.3：保留游戏原来的 150 ms 缓冲/100 ms 推算和自己的控制；仅抽走通用时间线。47 项规则/联网测试、产物检查、2D 与 3D 真实双宿主延迟收包路径通过。
- 颜料 0.1.1：转发原始位置必须连同原始采样时间；按来源分开缓存，显示位置不写回玩法状态。真实旧版延迟收包 P95 速度突变已复现；修复后同路复验和三人完整对局在游戏项目保存。
- 食堂 1.0.1：延迟只作用于对端显示；自己的动作不套远端缓冲。转向使推算失效时，由游戏限制视觉纠偏速度；工作台、食材和得分仍读权威状态。真实输入停步、全部食谱、协作交接、两锅、重开和退出通过。
- 矿工 0.6.1：按钩子模式/载物/局号重置，样本取关卡剩余时间的负值，绘制推算受矿区边界约束。真实抓取、共享计分、商店、炸药、自然到时、重新开局、换形象和退出通过。

以上记录来自隐藏的真实 Electron 宿主，实际 LAN/TLS 传输、真实 CDP 键盘、生产账号服务的隔离测试账号。180 ms 注入仅延迟真实 SDK poll，不替换消息或游戏结果。背景截图已检查。详细脚本和证据属于游戏仓库，不将玩法测试搬进 kit。

本轮不覆盖两台实体 Mac、公网拥塞、原生系统焦点或真实钥匙串；不声称所有联机卡顿都能由插值解决。其他固定旧版 kit 的游戏不会自动升级。未发布宿主安装包或改变插件市场兼容版本。

English: Core tests cover timestamp-based batching, bounded projection/history, lifecycle resets and immutable simulation values. Four games explicitly adopt the helper and retain game-owned authority/prediction/discrete rules. Real hidden Electron tests exercise production LAN sessions with delayed polling and actual input. Physical two-machine/public-network quality remains outside this run; consumers retain their own pinned versions and E2E evidence.
