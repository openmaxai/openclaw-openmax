# OpenMax Agent Onboarding — OpenClaw (openclaw-openmax)

The OpenClaw counterpart of the zylos-openmax onboarding prompt. Differences
from the zylos flow: installation is an OpenClaw plugin (no `zylos add`, no
interactive configure), configuration is JSON in `openclaw.json`, and agent
registration is an explicit curl step (the plugin has no auto-register).

> **cws-int only**: the environment sits behind Cloudflare Access, so every
> curl below carries the CF-Access header pair, and the gateway process needs
> the `COCO_CF_ACCESS_*` env vars (injected via `env.vars`). **Production has
> no CF-Access — omit all CF headers and the `env.vars` block there.**

## Step 1: Install the plugin

```bash
# Normal install (auto-discovered from the extensions dir):
mkdir -p ~/.openclaw/extensions
git clone https://github.com/coco-xyz/openclaw-openmax.git openmax
cd openmax && npm install

# Local development alternative: skip the clone and point config at a checkout
# via plugins.load.paths (see Step 3).
```

## Step 2: Register the agent and accept the invitation

Every onboarding needs a **fresh single-use invitation** (ID + token) issued by
the org admin. Values below are placeholders.

```bash
CWS=https://cws-int.coco.xyz
CF_ARGS=(-H "CF-Access-Client-Id: <CF_ID>" -H "CF-Access-Client-Secret: <CF_SECRET>")   # cws-int only

# 2a. Register a new agent identity — returns identity_id + api_key (shown once)
curl -s -X POST "$CWS/auth/register/agent" "${CF_ARGS[@]}" \
  -H "Content-Type: application/json" -d '{}'
# → {"data":{"identity_id":"…","api_key":"cwsk_…"}}

# 2b. Exchange the api_key for an identity-only access token
ACCESS_TOKEN=$(curl -s -X POST "$CWS/auth/agent/token" "${CF_ARGS[@]}" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['access_token'])")

# 2c. Accept the invitation (binds the agent into the org; owner applied automatically)
curl -s -X POST "$CWS/api/v1/invitations/<INVITATION_ID>/accept" "${CF_ARGS[@]}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"token": "<INVITATION_TOKEN>"}'
# → {"data":{"member_id":"…","org_id":"…","role_slug":"…"}}
```

## Step 3: Configure openclaw.json

```json5
{
  // cws-int only — production omits this block entirely
  "env": {
    "vars": {
      "COCO_CF_ACCESS_CLIENT_ID": "<CF_ID>",
      "COCO_CF_ACCESS_CLIENT_SECRET": "<CF_SECRET>"
    }
  },
  "plugins": {
    // dev checkout only; not needed for an extensions-dir install
    // "load": { "paths": ["/path/to/openclaw-openmax"] },
    "entries": { "openclaw-openmax": { "enabled": true } }
  },
  "channels": {
    "openmax": {
      "enabled": true,
      "coreUrl": "https://cws-int.coco.xyz",
      "wsUrl": "wss://cws-int.coco.xyz/ws",
      "agentToken": "<API_KEY from 2a>",
      "agentId": "<member_id from 2c>",       // optional; auto-filled from token exchange
      "agentName": "<display name>",           // optional; hydrated from cws-core
      "orgId": "<org_id from 2c>",
      "access": { "dmPolicy": "owner", "groupPolicy": "allowlist", "groups": {} }
    }
  }
}
```

## Step 4: Restart and verify

```bash
openclaw gateway restart
openclaw logs        # or: journalctl --user -u openclaw-gateway.service -f
```

Expected log sequence:

```
[openmax] [token] exchange ok org=…
[openmax] [default] self display_name ready before connect ("<name>")
[openmax] [ticket] org=default got ws-ticket, connecting…
[openmax] [ws] org=default open (org_id=…)
```

Then DM the agent from cws-fe — the first DM auto-binds the sender as owner
(`dmPolicy: owner`), persists it into `openclaw.json`, and the agent replies in
the conversation.

> Note: the owner persist triggers an OpenClaw config-change gateway restart on
> the very first DM. Messages arriving in that window are recovered by the
> /sync catch-up (cursor seeded from the inbox-ledger watermark).
