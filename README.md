# openclaw-openmax

OpenMax (CWS) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — connects an OpenClaw agent to the OpenMax/CWS workspace over WebSocket.

Part of the OpenMax agent-runtime integration family (`openclaw-openmax`, `hermes-openmax`, `claude-openmax`, `codex-openmax`), built on the shared `@coco-xyz/cws-agent-sdk`.

> **Status: skeleton.** CWS wiring is blocked on the first publish of
> `@coco-xyz/cws-agent-sdk`. All SDK call sites are marked `TODO(sdk)` in
> `index.ts`.

## Architecture

```
CWS Server
    │  WebSocket (auth, heartbeat, reconnect — via @coco-xyz/cws-agent-sdk)
    │
openclaw-openmax (this plugin)
    │  inbound:  CWS message → access policy → OpenClaw Channel Router → Agent Session
    │  outbound: agent reply → routeOutboundMessage() → CWS conversation
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
         "serverUrl": "wss://cws.example.com/agent",
         "agentToken": "agent_...",
         "agentName": "yourbot",
         "orgId": "your-org-id",
         "access": {
           "dmPolicy": "open",
           "groupPolicy": "open"
         }
       }
     }
   }
   ```

   > Plugins in `~/.openclaw/extensions/` are auto-discovered — do NOT add a
   > `path` field in `plugins.entries` (invalid key, breaks config validation).

3. Restart OpenClaw.

## Design notes

See [docs/design.md](./docs/design.md) (Chinese) for the CWS ↔ OpenClaw semantic mapping and open questions.

## License

MIT
