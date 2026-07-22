# openclaw-openmax

OpenMax (CWS) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — connects an OpenClaw agent to the OpenMax/CWS workspace over WebSocket.

Part of the OpenMax agent-runtime integration family (`openclaw-openmax`, `hermes-openmax`, `claude-openmax`, `codex-openmax`), built on the shared `@openmaxai/openmax-agent-sdk`.

> **Status: v1.1.0 — verified end-to-end against a live CWS environment** on
> `@openmaxai/openmax-agent-sdk@^1.0.0` (stable) — DM round-trip, owner
> auto-bind, group mention gating, smart mode, image/file attachments,
> reply chunking, and disconnect/sync recovery.

## Features

- 💬 **DM + group conversations** — with per-group access policy (`allowlist` / `open` / `disabled`)
- 🎯 **Mention gating** — `mention` (respond only when @-mentioned), `smart` (model decides, `[SKIP]` stays silent), or `silent` (context only); structured mentions plus text `@name` fallback
- 👤 **Owner auto-bind** — the first DM binds the sender as owner and persists it; owner @mentions bypass the group allowlist
- 🖼️ **Media** — inbound images/files are downloaded and fed to the model (`ctx.MediaPaths`), including media in quoted replies
- 🧵 **Context blocks** — group history, quoted replies, and smart-mode hints framed for the agent
- ⚡ **System Member priority** — urgent/high platform signals steer into (or optionally interrupt) a busy session
- 🔁 **No silent message loss** — SDK inbox-ledger dedupe + `/sync` catch-up across disconnects and restarts
- 📤 **Outbound** — @mention canonicalization, markdown auto-detect, 3000-char chunking; works from the gateway and the `openclaw message send` CLI

## Architecture

```
CWS Server
    │  WebSocket + REST (auth chain, heartbeat, reconnect, /sync catch-up,
    │  dedupe, access policy — via @openmaxai/openmax-agent-sdk CwsAgentBridge)
    │
openclaw-openmax (this plugin)
    │  inbound:  InboundDelivery.deliver() → group-context/quote/smart-hint blocks
    │            → OpenClaw Channel Router → Agent Session
    │            (System Member priority → per-message queue-mode override)
    │  outbound: agent reply → @mention canonicalization + chunking → bridge.send()
```

Same two-layer pattern as [openclaw-hxa-connect](https://github.com/coco-xyz/openclaw-hxa-connect): the SDK owns the protocol/connection, the plugin owns routing and policy.

## Installation

1. Clone into your OpenClaw extensions directory:
   ```bash
   cd ~/.openclaw/extensions
   git clone --branch v1.1.0 --depth 1 https://github.com/openmaxai/openclaw-openmax.git openmax
   cd openmax
   npm install
   ```

2. Add to `openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "openclaw-openmax": { "enabled": true }
       }
     },
     "channels": {
       "openmax": {
         "enabled": true,
         "coreUrl": "https://cws.example.com",
         "wsUrl": "wss://cws.example.com/ws",
         "agentToken": "agent_...",
         "agentName": "yourbot",
         "orgId": "your-org-id",
         "access": {
           "dmPolicy": "owner",
           "groupPolicy": "allowlist",
           "groups": {}
         }
       }
     }
   }
   ```

   > Plugins in `~/.openclaw/extensions/` are auto-discovered — do NOT add a
   > `path` field in `plugins.entries` (invalid key, breaks config validation).

3. Restart OpenClaw.

## Connecting to OpenMax (CWS)

The plugin needs four values from your CWS workspace: `coreUrl`, `wsUrl`, an
agent `agentToken` (api_key), and the `orgId`. Getting them takes two calls —
you need a **single-use invitation** (ID + token) from your org admin first:

```bash
CWS=https://cws.example.com

# 1. Register a new agent identity — returns identity_id + api_key (shown ONCE)
curl -s -X POST "$CWS/auth/register/agent" -H "Content-Type: application/json" -d '{}'

# 2. Exchange the api_key for an access token, then accept the invitation
ACCESS_TOKEN=$(curl -s -X POST "$CWS/auth/agent/token" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['access_token'])")
curl -s -X POST "$CWS/api/v1/invitations/<INVITATION_ID>/accept" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"token": "<INVITATION_TOKEN>"}'
# → {"data":{"member_id":"…","org_id":"…"}}
```

Put the `api_key` (as `agentToken`) and `org_id` (as `orgId`) into
`channels.openmax`, restart, and watch the logs for:

```
[openmax] [token] exchange ok org=<org_id>
[openmax] [ticket] org=<org_id> requesting ws-ticket
[openmax] [ws] org=<org_id> open
```

Then DM the agent from the CWS workspace — the **first DM auto-binds the sender
as owner** (`dmPolicy: owner`) and the agent replies in the conversation. Group
behavior is opt-in: add each group to `access.groups` with a `mode`
(`mention` / `smart` / `silent`); without an entry, only owner @mentions get
through (`groupPolicy: allowlist`).

Full walkthrough (including environments behind Cloudflare Access, e.g.
cws-int) in [docs/onboarding.md](./docs/onboarding.md).

## Design notes

See [docs/design.en.md](./docs/design.en.md) (English) / [docs/design.md](./docs/design.md) (Chinese) for the CWS ↔ OpenClaw semantic mapping, the zylos-openmax capability alignment matrix, and open questions.

Behavioral semantics (access policy, mention gating, group context, reconnect catch-up) are aligned with **zylos-openmax** (`zylos-coco-workspace`), the existing production CWS integration.

## License

MIT
