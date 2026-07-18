# openclaw-openmax 接入设计

状态：已实现并在真实 CWS 环境（cws-int）端到端验证（SDK=npm `@openmaxai/openmax-agent-sdk@0.1.0-alpha.2`）。
上游方案：OpenMax Agent Runtime 接入方案 v1（Howard 2026-07-17 已拍板）。
English version: [design.en.md](./design.en.md)

## 结论

openclaw-openmax 是一个 OpenClaw channel 插件（Category A 协议桥接），结构复用 openclaw-hxa-connect（插件形态、channel 注册、gateway 生命周期），**行为语义对齐 zylos-openmax**（仓库 `coco-workspace/zylos-coco-workspace`）——尤其群会话的准入策略、@提及门控、群上下文注入，逐条照搬其已验证做法。连接层交给共享 SDK，插件只做 inbound（CWS 消息注入 OpenClaw 会话）和 outbound（agent 回复送回 CWS）。

## 两侧参考实现

| 参考 | 借什么 |
|---|---|
| openclaw-hxa-connect v2.7.0 | OpenClaw 插件骨架：registerChannel、gateway.startAccount、outbound.sendText、多账户结构 |
| zylos-openmax（zylos-coco-workspace） | CWS 侧全部行为语义：策略过滤、群会话处理、消息格式、媒体、断线补拉 |

## 群会话处理（照搬 zylos-openmax `comm-bridge.js`）

### 准入策略（shouldHandleMessage 逐条对齐）

- **DM**：`dmPolicy` = `owner`（默认）/ `open` / `allowlist`。`owner` 模式下首条 DM 自动绑定发送者为 owner；非 owner 拒绝并回复礼貌拒绝语。
- **群**：`groupPolicy` = `allowlist`（默认）/ `open` / `disabled`。allowlist 按 `access.groups[conversationId]` 判定；**owner 的 @提及可绕过 allowlist 门**。
- **每群配置**：`groups[convId] = { name, mode, allowFrom }`。`allowFrom` 空或含 `*` 即全员；owner 豁免 allowFrom。
- **响应模式**：`mode` = `mention`（默认，只响应 @我）/ `smart`（收全部消息，注入 `<smart-mode>` 提示让模型自判，回复 `[SKIP]` 即静默——outbound 侧拦截不真发）。被直接 @ 时不注入 smart 提示，直接答。
- **@检测双路**：结构化 `mentions[]`（`entity_id`）+ 文本兜底 `@<selfName>(?![\w-])`（服务端常只给原始文本，无兜底则 mention 门形同虚设）。
- **拒绝通知**：群内只有发送者确实 @了我们才回拒绝语（否则静默，避免刷屏）；DM 拒绝总是通知；**sync 补拉帧和 AGENT 发送者一律不回**（防止翻旧账刷屏和 agent 间拒绝语乒乓）。
- **自回声**：`sender_id == self.member_id` 直接丢弃。
- **System Member**：`sender_type=SYSTEM`（审批中心、调度器等平台信号）绕过全部策略门，且带 priority（urgent/high/normal）映射到投递优先级。

### 上下文构建（formatInboundForC4 对齐）

- **群上下文**：取当前消息 `before_seq` 前 N 条（默认 5），升序排列，逐条解析发送者显示名（进程内缓存），包成 `<group-context>` 块。
- **引用回复**：`parent_id` 存在时拉取被引消息包成 `<replying-to>`；被引媒体要下载并附本地路径（否则空文本引用整块丢失）。
- **thread**：`thread_id` 存在时包 `<thread-context>`，根消息标 `<thread-root>`；thread 优先于引用块。
- **媒体**：附件取 `attachments[].artifact_id`（**必须是 cws-as 的 artifact_id，不是 media_id**——用错 FE 永远转圈，zylos 侧踩过），解析 URL 下载到本地，正文标 `[image]`/`[file: name]`，尾缀 `---- image/file: <本地路径>`。
- **防结构逃逸**：用户文本进 XML 块前只转义 `<`/`>`（够挡 `</current-message>` 逃逸，不escape `&`/引号保持原文可读）。

### 会话类型与状态

- WS 帧不带会话类型，REST 拉 `GET /conversations/{id}` 一次并缓存。
- 消息去重：TTL 5 分钟。
- **seq 持久化 + 断线补拉**：每账户记 `last_seq`，重连后 `POST /sync`（页 100，单次上限 2000，超出下次重连续拉）。这是"消息不真丢"的关键。

## Outbound（对齐 zylos send.js）

- 幂等：每条消息 `client_msg_id`（服务端 5 分钟窗口去重），长文按 3000 字符分块（段落→换行→硬切），每块独立 `client_msg_id`，`parent_id` 只挂第一块。
- 类型：agent 文本用 `AGENT_TEXT`；markdown 启发式检测决定 `content_type`。
- **@提及规范化**：cws-fe 高亮纯靠文本 `@<精确 display_name>` 匹配。inbound 时记录会话参与者显示名（每会话上限 200，落盘 registry），outbound 时把 `@name` 规范化为记录的精确名（长名优先）。
- `[SKIP]` 哨兵：smart 模式模型决定静默时输出 `[SKIP]`，outbound 拦截为 no-op。
- 媒体：`[MEDIA:image|file]<path>` 前缀 → 经 cws-as 上传 → 附件挂 `artifact_id`、`file_name`、`content_type`（MIME 不能丢，丢了 FE 渲不出）。

## 能力对齐矩阵（zylos-openmax → openclaw-openmax 落位）

| zylos-openmax 能力 | 落位 | 备注 |
|---|---|---|
| WS 连接/心跳/指数退避 | SDK | 方案 §2 SDK 职责 |
| api_key → JWT → ws-ticket 鉴权链 | SDK | 4003 过期只作废 token 缓存，保留 last_seq |
| seq 持久化 + /sync 断线补拉 | **SDK（已确认）** | SyncEngine + inbox-ledger；游标经 loadSession/saveSession 回调落插件存储 |
| 消息去重（TTL 5min） | **SDK（已确认）** | inbox-ledger reserve/commit，真实送达才 ack |
| client_msg_id 幂等 | SDK | |
| 会话/成员名查询 + 缓存 | SDK（会话）+ 插件（成员名） | orchestrator 自动 fetch conversation；成员名解析读 `InboundMessage.message` 自行补 |
| DM/群准入策略 + owner 自动绑定 | **SDK `decideInbound`** + 插件持久化 | decision 随 InboundMessage 下发；auto-bind 经 `onOwnerBind` 回调由插件写 config；群 mode 含 `silent`；同 owner sibling-agent DM 豁免 |
| mention/smart 模式 + `[SKIP]` | SDK 判定 + 插件执行 | `decision.mode/mentioned` SDK 给出；smartHint 注入与 `[SKIP]` 拦截归插件 |
| 群上下文 / 引用 / thread 块 | 插件 | |
| 媒体下载/上传（artifact_id） | 插件 + SDK（as 能力） | Howard 拍板 SDK 含 tm/kb/as CLI |
| 拒绝通知（含免打扰规则） | 插件 | |
| System Member priority | 插件 | 映射到 OpenClaw QueueMode，见§System Member priority 承接 |
| outbound @提及规范化 registry | **SDK `createMentionRegistry`**（issue #8 已收编） | 插件注入 StorageProvider 并在 inbound 记名/outbound 规范化时调用 |
| markdown 检测 + 3000 分块 | 插件 | OpenClaw `textChunkLimit` 承接一部分 |
| 多 org（一 org 一 WS，单 org 熔断不连坐） | 插件 multi-account | MVP 单账户；对齐项，MVP 后补（hxa-connect accounts 结构现成） |
| TM/KB/AS/Comm/Core CLI + 技能层 | SDK 全面范围 | 插件按 hxa-connect `registerTools` 模式注册 agent tools |

## System Member priority 承接（OpenClaw 源码探索结论）

zylos 侧语义：SYSTEM 发送者消息带 priority（urgent/high/normal），映射到 c4-receive 的 1/2/3 优先级，让平台信号（如审批解锁）**排在普通聊天前面处理**——只影响排队顺序，不打断进行中的任务。

OpenClaw 侧事实（源码结论，非猜测）：

- **没有 per-message 优先级队列**。内部 command-queue 确有 foreground(1)/normal(0)/background(-1) 三档，但由 trigger 决定（`user`/`manual`→foreground，`cron`/`heartbeat`→background），channel inbound 一律 trigger=`user`，插件无法按消息调档（`resolveEmbeddedRunSessionQueuePriority`，lane-runtime.ts）。
- 真正的承接机制是 **QueueMode**（`src/auto-reply/reply/queue/`）：决定"agent 正忙时新消息怎么处理"，四种——`steer`（**默认**：注入进行中的 turn，消息立即进 agent 可见上下文）/ `followup`（当前 run 结束后排队执行）/ `collect`（合并缓冲）/ `interrupt`（清空 session lane + abort 当前 run，立即处理）。解析优先级：inlineMode（每消息）> session 持久化 > 每 channel 配置 > 全局配置 > 默认 `steer`。
- **每消息覆盖入口**：`replyOptions.queueModeOverride`。从插件调用的 `dispatchReplyWithBufferedBlockDispatcher` 起 replyOptions 全链路原样透传，`dispatchFromConfig` 的签名就是含该字段的 Internal 类型，运行时生效。**注意**：该字段定义在 `InternalReplySessionOptions`（get-reply.types.ts），插件边界的公开类型没有它——属"运行时可用、类型面未承诺"，要靠连通性测试锁行为，OpenClaw 升级时留意。

**采纳的映射**：

| SYSTEM priority | 插件动作 | 效果 |
|---|---|---|
| normal / 无 | 不覆盖 | 尊重 operator 配置的 QueueMode |
| high | `queueModeOverride: "steer"` | 即使该 channel 被配成 followup/collect（如避免打扰长任务），平台信号也立刻进当前 turn 上下文 |
| urgent | `queueModeOverride: "steer"`（默认）；`"interrupt"` 可配置开启 | interrupt 会 abort 进行中的 run——比 zylos 的"排队靠前"语义更激进，是否值得杀任务默认关闭，留配置项 |

默认 QueueMode 本来就是 steer，所以空闲/默认场景下平台信号天然不被阻塞；这套映射只在 operator 改过队列策略时兜底。zylos 的"队列插队"（followup 队列 front 插入）OpenClaw 内部有（`EnqueueFollowupRunOptions.position: "front"`）但未暴露给插件，不依赖。

## 关键不变式（沿自方案 §4/§6）

投递确认必须真实：只有消息确实进入 OpenClaw agent 可见上下文，才算送达成功；"返回成功但实际未送达"是最差失败模式。`dispatchInbound` 失败必须让 SDK/补拉层感知（不吞错）。

## 开放问题（阻塞项加粗）

1. **SDK 已评审通过**（[openmaxai/openmax-agent-sdk](https://github.com/openmaxai/openmax-agent-sdk) PR#1，全量抽取 +11k 行含 orchestrator/schemas/fixtures）——上一轮 4 个确认点结论：① `InboundMessage` 必带 `senderType`(HUMAN/AGENT/SYSTEM)，`priority`(1/2/3) 作为 `deliver(msg, endpoint, priority)` 第三参传入，QueueMode 映射输入齐了；② outbound：client_msg_id/markdown 检测/`splitMessage(3000)` 均在 SDK（分块需插件自行调用），媒体 `uploadMedia` 返回 artifactId、附件组装归插件；③ access policy 归 SDK `decideInbound`（纯函数），decision（mode/mentioned/groupCfg/bindOwnerHint）随 InboundMessage 下发，群 mode 新增 `silent`，另有同 owner 的 sibling-agent DM 豁免；owner auto-bind 改为 `onOwnerBind` 回调、插件负责持久化；④ last_seq/ledger/dedup/token 持久化全走 StorageProvider + loadSession/saveSession。@提及规范化 registry 已被 SDK 收编（issue #8 → `createMentionRegistry`），插件改用 SDK 实现。SDK issue #4/#5（游标恢复/gap 下界）已修，插件侧 workaround 已移除。
2. 仓库落位 github.com/openmaxai/openclaw-openmax：建仓 + main 分支保护（PR approval + CI 全绿）待有权限的人操作。
3. `queueModeOverride` 是 OpenClaw 内部类型字段（运行时可用）：连通性测试须覆盖（已拍板不给 OpenClaw 提 issue，靠测试锁行为）。

## MVP 五步（对齐方案 §8）

1. ✅ 仓库初始化（README / package.json / 插件清单 / index.ts / CI）
2. ✅ CWS 连接 + 鉴权——经 SDK `CwsAgentBridge`（依赖 npm `@openmaxai/openmax-agent-sdk`，跟随 alpha 线）
3. ✅ Inbound：SDK 策略过滤 → 群上下文/引用/smart-hint 块 → OpenClaw 会话（含 priority → queueModeOverride 映射、silent 模式只记上下文）
4. ✅ Outbound：`[SKIP]` 拦截 → @提及规范化 → `splitMessage(3000)` 分块 → bridge.send（parent_id 只挂首块）
5. ✅ 双向连通性测试——cws-int 实测：DM 往返、owner auto-bind 持久化、群门控（allowlist/@绕过/smart/[SKIP]）、图片与文件附件、长文分块、断线 /sync 补拉与游标恢复；queueModeOverride 待平台 SYSTEM 消息场景

MVP 后对齐项：多账户、thread 完整支持、outbound 媒体（`[MEDIA:]` 前缀上传；inbound 媒体已实现——current+quoted 附件并行下载进 `ctx.MediaPaths`）、agent tools（tm/kb/as）。silent 语义已由 SDK issue #7 确认为上下文-only。
