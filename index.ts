import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// CWS connectivity (WebSocket, auth, heartbeat, reconnect) is provided by
// @coco-xyz/cws-agent-sdk. The SDK is not published yet; all call sites
// below are marked with `TODO(sdk)` and this plugin does not connect until
// the dependency lands.

// ─── Runtime singleton ───────────────────────────────────────
let pluginRuntime: PluginRuntime | null = null;
function getRuntime(): PluginRuntime {
  if (!pluginRuntime) throw new Error("OpenMax runtime not initialized");
  return pluginRuntime;
}

// ─── Types ───────────────────────────────────────────────────
interface OpenMaxAccessConfig {
  dmPolicy?: "open" | "allowlist";
  dmAllowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
}

interface OpenMaxChannelConfig {
  enabled?: boolean;
  serverUrl?: string;
  agentToken?: string;
  agentId?: string;
  agentName?: string;
  orgId?: string;
  access?: OpenMaxAccessConfig;
}

function resolveOpenMaxConfig(cfg: any): OpenMaxChannelConfig {
  return cfg?.channels?.openmax ?? {};
}

// ─── Outbound: OpenClaw → CWS ────────────────────────────────
async function routeOutboundMessage(
  _acct: OpenMaxChannelConfig,
  _to: string,
  _text: string,
  _opts?: { replyTo?: string },
): Promise<{ messageId: string }> {
  // TODO(sdk): resolve target (DM vs conversation) and send via cws-agent-sdk.
  throw new Error("openmax: outbound not wired yet (waiting on @coco-xyz/cws-agent-sdk)");
}

// ─── Inbound: CWS → OpenClaw ─────────────────────────────────
async function connectAccount(
  _acct: OpenMaxChannelConfig,
  _cfg: any,
  log: any,
  _abortSignal?: AbortSignal,
): Promise<void> {
  // TODO(sdk): open CWS WebSocket via cws-agent-sdk, subscribe to inbound
  // messages, apply access policy, then dispatch into the OpenClaw channel
  // router so messages reach the agent session (dispatchInbound pattern from
  // openclaw-hxa-connect).
  log?.warn?.("openmax: CWS connection not wired yet (waiting on @coco-xyz/cws-agent-sdk)");
}

// ─── Channel plugin ──────────────────────────────────────────
const openMaxChannel = {
  id: "openmax" as const,
  meta: {
    id: "openmax" as const,
    label: "OpenMax",
    selectionLabel: "OpenMax (CWS)",
    docsPath: "/channels/openmax",
    docsLabel: "openmax",
    blurb: "Agent messaging via OpenMax/CWS over WebSocket.",
    aliases: ["openmax", "cws"],
    order: 91,
  },
  capabilities: {
    chatTypes: ["direct" as const, "channel" as const],
    polls: false,
    threads: false,
    media: false,
    reactions: false,
    edit: false,
    reply: true,
  },
  config: {
    listAccountIds: (_cfg: any) => ["default"],
    resolveAccount: (cfg: any, accountId?: string) => {
      const acct = resolveOpenMaxConfig(cfg);
      return {
        accountId: accountId || "default",
        enabled: acct.enabled !== false,
        configured: !!(acct.serverUrl && acct.agentToken),
        config: acct,
      };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 8000,
    sendText: async (params: { cfg: any; to: string; text: string; replyToId?: string }) => {
      const acct = resolveOpenMaxConfig(params.cfg);
      const result = await routeOutboundMessage(acct, params.to, params.text, {
        replyTo: params.replyToId,
      });
      return { channel: "openmax" as const, ...result };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const acct = resolveOpenMaxConfig(ctx.cfg);
      ctx.setStatus?.({ accountId: ctx.accountId || "default" });
      if (acct.serverUrl && acct.agentToken) {
        await connectAccount(acct, ctx.cfg, ctx.log, ctx.abortSignal);
      } else {
        ctx.log?.warn?.("openmax: serverUrl/agentToken not configured, account idle");
      }
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) return resolve();
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stopAccount: async (_ctx: any) => {
      // TODO(sdk): close the CWS WebSocket connection.
    },
  },
};

// ─── Plugin entry ────────────────────────────────────────────
const plugin = {
  id: "openclaw-openmax",
  name: "OpenMax",
  description: "Agent messaging via OpenMax/CWS (WebSocket)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;
    api.registerChannel({ plugin: openMaxChannel });
    api.logger.info("openmax: plugin loaded (skeleton — CWS wiring pending cws-agent-sdk)");
  },
};

export default plugin;
