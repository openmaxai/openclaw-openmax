# openclaw-openmax 接入设计

状态：骨架已建，CWS 接线阻塞在 `@coco-xyz/cws-agent-sdk` 首次发布。
上游方案：OpenMax Agent Runtime 接入方案 v1（Howard 2026-07-17 已拍板）。

## 结论

openclaw-openmax 是一个 OpenClaw channel 插件（Category A 协议桥接），完全复用 openclaw-hxa-connect 的已验证结构：连接层交给共享 SDK，插件只做两件事——CWS 消息注入 OpenClaw 会话（inbound）、agent 回复送回 CWS（outbound）。不自建 session / 压缩，OpenClaw 自带。

## 与参考实现（openclaw-hxa-connect v2.7.0）的对应关系

| openclaw-hxa-connect | openclaw-openmax | 说明 |
|---|---|---|
| `@coco-xyz/hxa-connect-sdk` | `@coco-xyz/cws-agent-sdk` | 连接管理、鉴权、心跳、指数退避重连 |
| HXA Hub（WebSocket + webhook） | CWS Server（WebSocket） | MVP 不做 webhook 回退，CWS 侧无此形态 |
| `dispatchInbound()` → Channel Router | 同结构 | inbound 主干 |
| `routeOutboundMessage()` | 同结构 | outbound 主干，DM / 群会话路由 |
| thread / @mention / smart mode | MVP 不做 | 后续按 CWS conversation 语义决定 |
| 多账户（multi-account） | MVP 单账户 | 参考项目也是 v2.x 才加 |

## 语义映射（待 SDK API 定稿后确认）

| CWS 概念 | OpenClaw 概念 | 备注 |
|---|---|---|
| conversation（DM） | direct chat | |
| conversation（群） | channel chat | @mention / 全量接收策略待定 |
| inbox_seq / 消息游标 | — | 由 SDK 内部处理，插件不感知（需和 gavin 确认边界） |
| agent token 鉴权 | 插件配置 `agentToken` | sensitive 字段 |

## 关键不变式（沿自方案 §4/§6）

投递确认必须真实：只有消息确实进入 OpenClaw agent 可见上下文，才算送达成功；"返回成功但实际未送达"是最差失败模式。Category A 下这体现为：`dispatchInbound` 失败时必须让 SDK 层感知（不吞错），由 SDK 退避重投。

## 开放问题（阻塞项加粗）

1. **`cws-agent-sdk` API 形态未定**——inbound 订阅、send、ack 语义，等 gavin 的 SDK 仓库出接口后对齐；插件内所有 `TODO(sdk)` 即接线点。
2. CWS conversation ↔ OpenClaw chatType 映射：群会话是否需要 @mention 过滤（参考项目的 ThreadContext 缓冲模式可搬）。
3. 送达确认边界：seq ack 是 SDK 内部行为还是插件显式调用。
4. 仓库落位 github.com/coco-xyz/openclaw-openmax：建仓与 branch protection（main 需 PR approval + CI 全绿）待有权限的人操作。

## MVP 五步（对齐方案 §8）

1. ✅ 仓库初始化（本骨架：README / package.json / 插件清单 / index.ts / CI）
2. CWS 连接 + 鉴权（经 SDK）——阻塞在 SDK 发布
3. Inbound：CWS 消息 → OpenClaw 会话
4. Outbound：agent 回复 → CWS
5. 双向连通性测试
