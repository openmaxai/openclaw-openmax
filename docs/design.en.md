# openclaw-openmax Integration Design

Status: skeleton committed; CWS wiring blocked on the first publish of `@coco-xyz/cws-agent-sdk`.
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
- **Response mode**: `mode` = `mention` (default — respond only when @mentioned) / `smart` (receive all messages, inject a `<smart-mode>` hint so the model decides; replying `[SKIP]` stays silent — the outbound path intercepts it and sends nothing). When directly @mentioned, the smart hint is NOT injected — answer directly.
- **Dual-path mention detection**: structured `mentions[]` (`entity_id`) plus a text fallback `@<selfName>(?![\w-])`. The server often returns raw text without a structured mentions array; without the fallback the mention gate never fires in practice.
- **Reject notices**: in groups, reply with a refusal only when the sender actually @mentioned us (otherwise stay silent — replying to background traffic is spam); DM rejections always notify; **sync-replay frames and AGENT senders never get notices** (avoids spamming stale apologies after a fix, and agent-to-agent reject ping-pong).
- **Self-echo**: drop messages where `sender_id == self.member_id`.
- **System Members**: `sender_type=SYSTEM` (approval center, scheduler, and other platform signals) bypasses all policy gates and carries a priority (urgent/high/normal) mapped onto delivery priority.

### Context building (aligned with formatInboundForC4)

- **Group context**: fetch the N messages (default 5) before the current message's seq (`before_seq`), sort ascending, resolve each sender's display name (process-level cache), wrap in a `<group-context>` block.
- **Quoted reply**: when `parent_id` is present, fetch the quoted message and wrap it in `<replying-to>`; quoted media must be downloaded and its local path appended (a caption-less quoted image would otherwise drop the whole quote).
- **Threads**: when `thread_id` is present, wrap history in `<thread-context>` with the root message tagged `<thread-root>`; thread context takes precedence over the quote block.
- **Media**: attachments carry `attachments[].artifact_id` (**must be the cws-as artifact_id, NOT the media_id** — using the wrong one leaves the FE spinner loading forever; zylos side hit this). Resolve to a URL, download locally, label the body `[image]` / `[file: name]`, and append `---- image/file: <local path>`.
- **Structural-breakout guard**: user text embedded in XML-tagged blocks escapes only `<` / `>` (enough to block a literal `</current-message>` breakout; `&` and quotes stay verbatim for readability).

### Conversation type and state

- WS frames don't carry the conversation type; fetch `GET /conversations/{id}` once via REST and cache it.
- Message dedup: 5-minute TTL.
- **Seq persistence + reconnect catch-up**: persist `last_seq` per account; after reconnect, `POST /sync` (page size 100, per-sweep cap 2000; overflow resumes on the next reconnect). This is what makes "messages are never silently lost" true.

## Outbound (aligned with zylos send.js)

- Idempotency: every message gets a `client_msg_id` (server de-dupes within a 5-minute window). Long text splits into ≤3000-char chunks (paragraph → newline → hard cut), each chunk with its own `client_msg_id`; `parent_id` only on the first chunk.
- Types: agent text uses `AGENT_TEXT`; a markdown heuristic picks the `content_type`.
- **Mention canonicalization**: cws-fe highlights mentions purely by matching the literal text `@<exact display_name>`. Inbound processing records participant display names per conversation (cap 200, persisted registry); outbound rewrites `@name` tokens to the exact recorded name (longest-first).
- `[SKIP]` sentinel: in smart mode the model outputs `[SKIP]` to stay silent; outbound intercepts it as a no-op.
- Media: `[MEDIA:image|file]<path>` prefix → upload via cws-as → attachment carries `artifact_id`, `file_name`, `content_type` (never drop the MIME — the FE can't render without it).

## Capability alignment matrix (zylos-openmax → openclaw-openmax)

| zylos-openmax capability | Lands in | Notes |
|---|---|---|
| WS connect / heartbeat / exponential backoff | SDK | SDK responsibility per plan §2 |
| api_key → JWT → ws-ticket auth chain | SDK | On 4003 session-expired, invalidate only the token cache; keep last_seq |
| Seq persistence + /sync reconnect catch-up | SDK (to confirm) | If the SDK doesn't own it, the plugin must; open question #1 |
| Message dedup (5-min TTL) | SDK or plugin | Decide together with sync ownership |
| client_msg_id idempotency | SDK | |
| Conversation / member-name lookup + cache | Plugin | REST via SDK client |
| DM/group access policy + owner auto-bind | Plugin | See group-conversation section |
| mention/smart mode + `[SKIP]` | Plugin | hxa-connect already ships the same smart mode; shell reusable |
| Group-context / quote / thread blocks | Plugin | |
| Media download/upload (artifact_id) | Plugin + SDK (as capability) | Howard approved SDK scope incl. tm/kb/as CLIs |
| Reject notices (incl. do-not-disturb rules) | Plugin | |
| System Member priority | Plugin | Whether OpenClaw sessions accept a priority concept: to investigate |
| Outbound mention canonicalization registry | Plugin | |
| Markdown detection + 3000-char chunking | Plugin | OpenClaw `textChunkLimit` covers part of it |
| Multi-org (one WS per org; one org going terminal doesn't kill the rest) | Plugin multi-account | MVP is single-account; alignment item post-MVP (hxa-connect accounts structure is ready to reuse) |
| TM/KB/AS/Comm/Core CLIs + skill layer | SDK full scope | Plugin registers agent tools following hxa-connect's `registerTools` pattern |

## Key invariant (from plan §4/§6)

Delivery confirmation must be truthful: a message counts as delivered only when it actually entered the OpenClaw agent's visible context; "returned success but never delivered" is the worst failure mode. A `dispatchInbound` failure must be surfaced to the SDK / catch-up layer (never swallowed).

## Open questions (blockers in bold)

1. **`cws-agent-sdk` API shape undecided** — especially whether seq persistence, /sync catch-up, and dedup live in the SDK or the plugin; align once gavin's interface lands. All `TODO(sdk)` markers in the plugin are the wiring points.
2. How System Member priority maps onto OpenClaw sessions (does OpenClaw have a message-priority concept).
3. Repo home github.com/coco-xyz/openclaw-openmax: repo creation + main branch protection (PR approval + green CI required) needs someone with permissions.

## MVP in five steps (per plan §8)

1. ✅ Repo init (this skeleton: README / package.json / plugin manifest / index.ts / CI)
2. CWS connection + auth (via SDK) — blocked on SDK publish
3. Inbound: CWS message → policy filter → context building → OpenClaw session
4. Outbound: agent reply → canonicalization/chunking → CWS
5. Bidirectional connectivity test

Post-MVP alignment items: multi-account, full thread support, media send/receive, smart mode, agent tools (tm/kb/as).
