# openclaw-openmax Integration Design

Status: implemented and verified end-to-end against a live CWS environment (cws-int); SDK = npm `@openmaxai/openmax-agent-sdk@^1.0.0`.
Upstream plan: OpenMax Agent Runtime Integration Plan v1 (approved by Howard, 2026-07-17).
中文版: [design.md](./design.md)

## Conclusion

openclaw-openmax is an OpenClaw channel plugin (Category A protocol bridge). Its structure reuses openclaw-hxa-connect (plugin shape, channel registration, gateway lifecycle), while its **behavioral semantics align with zylos-openmax** (repo `coco-workspace/zylos-coco-workspace`) — in particular the group-conversation access policy, @mention gating, and group-context injection are ported item by item from that proven implementation. The connection layer belongs to the shared SDK; the plugin does exactly two things: inbound (CWS message → OpenClaw agent session) and outbound (agent reply → CWS).

## Two reference implementations

| Reference | What we borrow |
|---|---|
| openclaw-hxa-connect v2.7.0 | OpenClaw plugin skeleton: registerChannel, gateway.startAccount, outbound.sendText, multi-account structure |
| zylos-openmax (zylos-coco-workspace) | All CWS-side behavior: policy filtering, group-conversation handling, message formatting, media, reconnect catch-up |

## Group-conversation handling (ported from zylos-openmax `comm-bridge.js`)

### Access policy (aligned with shouldHandleMessage, item by item)

- **DM**: `dmPolicy` = `owner` (default) / `open` / `allowlist`. In `owner` mode the first-ever DM auto-binds the sender as owner; non-owner senders are rejected with a polite notice.
- **Group**: `groupPolicy` = `allowlist` (default) / `open` / `disabled`. Allowlist is keyed by `access.groups[conversationId]`; **an owner @mention bypasses the allowlist gate**.
- **Per-group config**: `groups[convId] = { name, mode, allowFrom }`. Empty `allowFrom` or `*` means everyone; the owner is exempt from `allowFrom`.
- **Response mode**: `mode` = `mention` (default — respond only when @mentioned) / `smart` (receive all messages, inject a `<smart-mode>` hint so the model decides; replying `[SKIP]` stays silent — the outbound path intercepts it and sends nothing) / `silent` (context only, never wakes the agent; semantics confirmed via SDK issue #7). When directly @mentioned, the smart hint is NOT injected — answer directly.
- **Dual-path mention detection**: structured `mentions[]` (`entity_id`) plus a text fallback `@<selfName>(?![\w-])`. The server often returns raw text without a structured mentions array; without the fallback the mention gate never fires in practice.
- **Reject notices** (sent by the SDK orchestrator): in groups, reply with a refusal only when the sender actually @mentioned us (otherwise stay silent — replying to background traffic is spam); DM rejections always notify; **sync-replay frames and AGENT senders never get notices** (avoids spamming stale apologies after a fix, and agent-to-agent reject ping-pong).
- **Self-echo**: drop messages where `sender_id == self.member_id`.
- **System Members**: `sender_type=SYSTEM` (approval center, scheduler, and other platform signals) bypasses all policy gates and carries a priority (urgent/high/normal) mapped onto delivery priority.

### Context building (aligned with formatInboundForC4)

- **Group context**: fetch the N messages (default 5) before the current message's seq (`before_seq`), sort ascending, resolve each sender's display name (process-level cache), wrap in a `<group-context>` block.
- **Quoted reply**: when `parent_id` is present, fetch the quoted message and wrap it in `<replying-to>`; quoted attachments download in the same parallel batch as the current message into `ctx.MediaPaths`, and a caption-less quoted image/file is represented by an `[image]` / `[file: name]` label inside the block (otherwise the whole quote would drop).
- **Threads** (post-MVP, not implemented): the zylos reference behavior wraps history in `<thread-context>` with the root tagged `<thread-root>`, taking precedence over the quote block; the current implementation only routes thread conversations by endpoint and builds no thread-context block.
- **Media**: attachments carry `attachments[].artifact_id` (**must be the cws-as artifact_id, NOT the media_id** — using the wrong one leaves the FE spinner loading forever; zylos side hit this). Resolve the presigned URL, download through `saveMediaBuffer` into an OpenClaw media root, and hand the files to the model via **`ctx.MediaPaths`** (OpenClaw never reads a path mentioned in the body text); the body carries only the `[image]` / `[file: name]` caption, which doubles as the fallback when a download fails.
- **Structural-breakout guard**: user text embedded in XML-tagged blocks escapes only `<` / `>` (enough to block a literal `</current-message>` breakout; `&` and quotes stay verbatim for readability).

### Conversation type and state

- WS frames don't carry the conversation type; fetch `GET /conversations/{id}` once via REST and cache it.
- Message dedup: the SDK message-id deduper (count-based, most recent 5000 ids) plus the inbox-ledger reserve/commit (ack only on genuine delivery).
- **Seq persistence + reconnect catch-up**: persist a per-org `sync_seq` cursor (keyed by org_id); after reconnect, `POST /sync` (page size 100, per-sweep cap 2000; overflow resumes on the next reconnect), and the SDK seeds a missing/stale cursor from the ledger watermark. This is what makes "messages are never silently lost" true.

## Outbound (aligned with zylos send.js)

- Idempotency: every message gets a `client_msg_id` (server de-dupes within a 5-minute window). Long text splits into ≤3000-char chunks (paragraph → newline → hard cut), each chunk with its own `client_msg_id`; `parent_id` only on the first chunk.
- Types: agent text uses `AGENT_TEXT`; a markdown heuristic picks the `content_type`.
- **Mention canonicalization**: cws-fe highlights mentions purely by matching the literal text `@<exact display_name>`. Inbound processing records participant display names per conversation (cap 200, persisted registry); outbound rewrites `@name` tokens to the exact recorded name (longest-first).
- `[SKIP]` sentinel: in smart mode the model outputs `[SKIP]` to stay silent; outbound intercepts it as a no-op.
- Media (post-MVP, not implemented): the zylos reference behavior is a `[MEDIA:image|file]<path>` prefix → upload via cws-as → attachment carries `artifact_id`, `file_name`, `content_type` (never drop the MIME — the FE can't render without it).

## Capability alignment matrix (zylos-openmax → openclaw-openmax)

| zylos-openmax capability | Lands in | Notes |
|---|---|---|
| WS connect / heartbeat / exponential backoff | SDK | SDK responsibility per plan §2 |
| api_key → JWT → ws-ticket auth chain | SDK | On 4003 session-expired, invalidate only the token cache; the sync cursor is kept |
| Seq persistence + /sync reconnect catch-up | **SDK (confirmed)** | SyncEngine + inbox-ledger; cursor persisted via loadSession/saveSession callbacks into plugin storage |
| Message dedup | **SDK (confirmed)** | message-id deduper (count-based) + inbox-ledger reserve/commit; ack only on genuine delivery |
| client_msg_id idempotency | SDK | |
| Conversation / member-name lookup + cache | SDK (conversation) + plugin (member names) | The orchestrator fetches the conversation; member-name resolution reads `InboundMessage.message` in the plugin |
| DM/group access policy + owner auto-bind | **SDK `decideInbound`** + plugin persistence | Decision rides on InboundMessage; auto-bind persisted by the plugin via `onOwnerBind`; group mode includes `silent`; same-owner sibling-agent DM exemption |
| mention/smart mode + `[SKIP]` | SDK decides + plugin executes | `decision.mode/mentioned` come from the SDK; smart-hint injection and `[SKIP]` interception stay in the plugin |
| Group-context / quote blocks | Plugin | Thread-context block is post-MVP (endpoint routing only) |
| Media download/upload (artifact_id) | Plugin + SDK (as capability) | Inbound implemented (`ctx.MediaPaths`); outbound `[MEDIA:]` upload post-MVP |
| Reject notices (incl. do-not-disturb rules) | **SDK orchestrator** | On a policy drop carrying a userNotice, the SDK posts the AGENT_TEXT refusal |
| System Member priority | Plugin | Mapped onto OpenClaw QueueMode — see the System Member priority section |
| Outbound mention canonicalization registry | **SDK `createMentionRegistry`** (absorbed per issue #8) | The plugin injects a StorageProvider and calls it on inbound (record names) / outbound (canonicalize) |
| Markdown detection + 3000-char chunking | Plugin | OpenClaw `textChunkLimit` covers part of it |
| Multi-org (one WS per org; one org going terminal doesn't kill the rest) | Plugin multi-account | MVP is single-account; alignment item post-MVP (hxa-connect accounts structure is ready to reuse) |
| TM/KB/AS/Comm/Core CLIs + skill layer | SDK full scope | Plugin registers agent tools following hxa-connect's `registerTools` pattern |

## System Member priority handling (from OpenClaw source exploration)

zylos-side semantics: messages from SYSTEM senders carry a priority (urgent/high/normal), mapped to c4-receive's 1/2/3 scale so platform signals (e.g. "approval unblocked") are **processed ahead of normal chat** — it affects queue ordering only; it never interrupts in-flight work.

OpenClaw-side facts (from source, not guesses):

- **No per-message priority queue.** The internal command queue does have foreground(1)/normal(0)/background(-1) levels, but they are derived from the run trigger (`user`/`manual` → foreground, `cron`/`heartbeat` → background); all channel inbound messages are trigger=`user`, and plugins cannot adjust the level per message (`resolveEmbeddedRunSessionQueuePriority`, lane-runtime.ts).
- The real mechanism is **QueueMode** (`src/auto-reply/reply/queue/`): it decides what happens to a new message while the agent is mid-run. Four modes — `steer` (**default**: inject into the active turn, the message immediately enters the agent's visible context) / `followup` (queue until the current run finishes) / `collect` (coalesce/buffer) / `interrupt` (clear the session lane + abort the active run, handle immediately). Resolution order: inlineMode (per message) > persisted session setting > per-channel config > global config > default `steer`.
- **Per-message override hook**: `replyOptions.queueModeOverride`. From the plugin's `dispatchReplyWithBufferedBlockDispatcher` call, replyOptions passes through the whole chain verbatim, and `dispatchFromConfig`'s signature is the Internal type that includes this field, so it takes effect at runtime. **Caveat**: the field is declared on `InternalReplySessionOptions` (get-reply.types.ts), not on the public plugin-boundary type — "works at runtime, not promised by the type surface". Pin the behavior with the connectivity test and watch OpenClaw upgrades.

**Adopted mapping**:

| SYSTEM priority | Plugin action | Effect |
|---|---|---|
| normal / absent | No override | Respect the operator-configured QueueMode |
| high | `queueModeOverride: "steer"` | Even if the channel is configured followup/collect (e.g. to avoid disturbing long tasks), platform signals still enter the current turn's context immediately |
| urgent | `queueModeOverride: "steer"` (default); `"interrupt"` behind a config flag | interrupt aborts the in-flight run — more aggressive than zylos's "jump the queue" semantics, so killing work is off by default and left as a config option |

Since the default QueueMode is already steer, platform signals are naturally unblocked in the idle/default case; this mapping is a backstop for when the operator has changed the queue policy. zylos-style queue-jumping (front insertion into the followup queue) exists inside OpenClaw (`EnqueueFollowupRunOptions.position: "front"`) but is not exposed to plugins — we don't rely on it.

## Key invariant (from plan §4/§6)

Delivery confirmation must be truthful: a message counts as delivered only when it actually entered the OpenClaw agent's visible context; "returned success but never delivered" is the worst failure mode. A `dispatchInbound` failure must be surfaced to the SDK / catch-up layer (never swallowed).

## Open questions (blockers in bold)

1. ~~SDK interface and ownership boundary~~ **Resolved**: [openmaxai/openmax-agent-sdk](https://github.com/openmaxai/openmax-agent-sdk) provides the InboundMessage (with senderType + priority), the `decideInbound` policy, sync/ledger cursor recovery (issues #4/#5), and `createMentionRegistry` (issue #8); the sections and capability matrix in this document are the authoritative description of the current split.
2. Repo home github.com/openmaxai/openclaw-openmax: repo creation + main branch protection (PR approval + green CI required) needs someone with permissions.
3. `queueModeOverride` is an OpenClaw-internal type field (works at runtime): the connectivity test must cover it (decision: no OpenClaw issue — the behavior is pinned by our test).

## MVP in five steps (per plan §8)

1. ✅ Repo init (README / package.json / plugin manifest / index.ts / CI)
2. ✅ CWS connection + auth — via the SDK `CwsAgentBridge` (dependency: npm `@openmaxai/openmax-agent-sdk@^1.0.0`, stable)
3. ✅ Inbound: SDK policy filter → group-context/quote/smart-hint blocks → OpenClaw session (incl. priority → queueModeOverride mapping; silent mode records context only)
4. ✅ Outbound: `[SKIP]` interception → mention canonicalization → `splitMessage(3000)` chunking → bridge.send (parent_id on the first chunk only)
5. ✅ Bidirectional connectivity test — verified on cws-int: DM round-trip, owner auto-bind persistence, group gating (allowlist / @bypass / smart / `[SKIP]`), image + file attachments, reply chunking, disconnect + /sync catch-up with cursor recovery; queueModeOverride still needs a platform SYSTEM-message scenario

Post-MVP alignment items: multi-account, full thread support, outbound media (`[MEDIA:]` prefix upload; inbound media is DONE — current + quoted attachments download in parallel into `ctx.MediaPaths`), agent tools (tm/kb/as). Silent-mode semantics were confirmed as context-only via SDK issue #7.
