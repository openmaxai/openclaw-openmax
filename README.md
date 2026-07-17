# openclaw-openmax

OpenMax (CWS) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — connects an OpenClaw agent to the OpenMax/CWS workspace over WebSocket.

Part of the OpenMax agent-runtime integration family (`openclaw-openmax`, `hermes-openmax`, `claude-openmax`, `codex-openmax`), built on the shared `@openmaxai/openmax-agent-sdk`.

> **Status: implemented on `@openmaxai/openmax-agent-sdk@0.1.0-alpha.0` (npm)**
> and load-tested against a local OpenClaw gateway. Pending: real-environment
> connectivity test against a CWS server (MVP step 5).

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
   git clone https://github.com/coco-xyz/openclaw-openmax.git openmax
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

## Design notes

See [docs/design.en.md](./docs/design.en.md) (English) / [docs/design.md](./docs/design.md) (Chinese) for the CWS ↔ OpenClaw semantic mapping, the zylos-openmax capability alignment matrix, and open questions.

Behavioral semantics (access policy, mention gating, group context, reconnect catch-up) are aligned with **zylos-openmax** (`zylos-coco-workspace`), the existing production CWS integration.

## License

MIT
