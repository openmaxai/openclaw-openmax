import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import fs from "fs";
import os from "os";
import path from "path";

// Layer 1 (protocol) comes from the shared SDK: WS lifecycle, auth chain
// (api_key → JWT → ws-ticket), sync catch-up + inbox-ledger dedupe, and the
// DM/group access policy. This plugin is Layer 2: it implements
// InboundDelivery.deliver() (CWS message → OpenClaw agent session) and routes
// agent replies back through bridge.send(). Behavioral semantics are aligned
// with zylos-openmax — see docs/design.md.
import {
  CwsHttpClient,
  TokenManager,
  CwsAgentBridge,
  splitMessage,
} from "@openmaxai/openmax-agent-sdk";

// ─── Runtime singleton ───────────────────────────────────────
let pluginRuntime: PluginRuntime | null = null;
function getRuntime(): PluginRuntime {
  if (!pluginRuntime) throw new Error("OpenMax runtime not initialized");
  return pluginRuntime;
}

let _dataDirWarned = false;
function getDataDir(): string {
  const baseDir = getRuntime().dataDir;
  if (baseDir) return path.join(baseDir, "openmax");
  if (!_dataDirWarned) {
    console.warn("[openmax] runtime.dataDir is undefined, falling back to os.tmpdir()");
    _dataDirWarned = true;
  }
  return path.join(os.tmpdir(), "openclaw-openmax");
}

// ─── Types ───────────────────────────────────────────────────
// Access-policy semantics live in the SDK (decideInbound); this config is
// handed to it verbatim as orgConfig.access — see docs/design.md.
interface OpenMaxGroupConfig {
  name?: string;
  allowFrom?: string[];
  mode?: "mention" | "smart" | "silent";
}

interface OpenMaxAccessConfig {
  dmPolicy?: "owner" | "open" | "allowlist";
  dmAllowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, OpenMaxGroupConfig>;
}

interface OpenMaxChannelConfig {
  enabled?: boolean;
  coreUrl?: string;
  wsUrl?: string;
  agentToken?: string;
  agentId?: string;
  agentName?: string;
  orgId?: string;
  orgName?: string;
  contextMessages?: number;
  urgentQueueMode?: "steer" | "interrupt";
  access?: OpenMaxAccessConfig;
  owner?: { memberId?: string; name?: string };
}

function resolveOpenMaxConfig(cfg: any): OpenMaxChannelConfig {
  return cfg?.channels?.openmax ?? {};
}

const DEFAULT_CONTEXT_MESSAGES = 5;
const ACCOUNT_ID = "default"; // MVP is single-account; multi-account is a post-MVP alignment item

// ─── Small file-backed stores (StorageProvider + session + mentions) ─────────
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: any): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  } catch (err: any) {
    console.warn(`[openmax] write ${file} failed: ${err?.message}`);
  }
}

/** SDK StorageProvider backed by a single JSON kv file under dataDir. */
function fileStorage(file: string) {
  return {
    async get(key: string): Promise<string | null> {
      const kv = readJson(file) || {};
      return Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : null;
    },
    async set(key: string, value: string): Promise<void> {
      const kv = readJson(file) || {};
      kv[key] = value;
      writeJson(file, kv);
    },
  };
}

// ─── Outbound @mention canonicalization ──────────────────────
// Ported from zylos-openmax lib/mention.js (not yet in the SDK — flagged to be
// absorbed there). cws-fe highlights mentions purely by matching the literal
// text `@<exact display_name>` of a conversation participant, so we record the
// names we see inbound and canonicalize `@name` tokens on the way out.
const MAX_NAMES_PER_CONV = 200;
const normName = (s: unknown) => String(s ?? "").trim().toLowerCase();

function mentionRegistryPath(): string {
  return path.join(getDataDir(), "mention-registry.json");
}

function recordParticipants(conversationId: string, names: Array<string | undefined>): void {
  if (!conversationId) return;
  const list = names.map((n) => String(n ?? "").trim()).filter(Boolean);
  if (!list.length) return;
  const file = mentionRegistryPath();
  const reg = readJson(file) || {};
  const conv = reg[conversationId] || (reg[conversationId] = {});
  let changed = false;
  for (const name of list) {
    const key = normName(name);
    if (conv[key] !== name) {
      conv[key] = name;
      changed = true;
    }
  }
  if (!changed) return;
  const keys = Object.keys(conv);
  if (keys.length > MAX_NAMES_PER_CONV) {
    for (const k of keys.slice(0, keys.length - MAX_NAMES_PER_CONV)) delete conv[k];
  }
  writeJson(file, reg);
}

function resolveMentions(text: string, conversationId: string): string {
  if (!text || !conversationId || !text.includes("@")) return text;
  const conv = (readJson(mentionRegistryPath()) || {})[conversationId];
  if (!conv) return text;
  // Longest name first so "Alice Wong" wins over "Alice".
  const names = (Object.values(conv) as string[]).sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("@" + esc, "gi"), "@" + name);
  }
  return out;
}

// ─── Inbound context building (aligned with zylos formatInboundForC4) ────────
// The consumer is an LLM reading raw text, not an XML parser: only `<`/`>` are
// neutralized so a sender can't forge a closing tag and break out of a block.
function escapeXml(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SMART_MODE_HINT = `<smart-mode>
Decide whether to respond. Do NOT reply if: the message is unrelated to you,
just casual chat, or doesn't need your input. Only reply when:
1) someone asks a question you can help with,
2) discussing technical topics you know well,
3) someone clearly needs assistance.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>`;

interface ContextBlocks {
  groupContext?: Array<{ senderName: string; content: string }>;
  quoted?: { sender: string; text: string };
  smartHint?: boolean;
}

function buildInboundBody(text: string, blocks: ContextBlocks): string {
  const parts: string[] = [];
  if (blocks.groupContext && blocks.groupContext.length > 0) {
    const lines = blocks.groupContext.map(
      (m) => `[${escapeXml(m.senderName)}]: ${escapeXml(m.content)}`,
    );
    parts.push(`<group-context>\n${lines.join("\n")}\n</group-context>`);
  }
  if (blocks.quoted) {
    parts.push(`<replying-to>\n[${escapeXml(blocks.quoted.sender)}]: ${escapeXml(blocks.quoted.text)}\n</replying-to>`);
  }
  if (blocks.smartHint) parts.push(SMART_MODE_HINT);
  parts.push(text);
  return parts.join("\n\n");
}

/** Label media messages so an image/file isn't delivered as an empty body.
 *  MVP: label only; attachment download is a post-MVP alignment item. */
function labelMedia(text: string, msgType: string, attachments: any[]): string {
  const first = Array.isArray(attachments) ? attachments[0] : null;
  const isImage = msgType === "image" || msgType === "agent_card";
  if (isImage) return `[image]${text ? " " + text : ""}`;
  if (first) return `[file${first.file_name ? ": " + first.file_name : ""}]${text ? " " + text : ""}`;
  return text;
}

// ─── System Member priority → OpenClaw queue mode ─────────────
// See docs/design.md "System Member priority handling". `queueModeOverride` is
// an internal-typed (but runtime-effective) reply option; the connectivity test
// pins the behavior.
export function resolveQueueModeOverride(
  priority: 1 | 2 | 3 | undefined,
  urgentQueueMode: "steer" | "interrupt" | undefined,
): "steer" | "interrupt" | undefined {
  if (priority === 1) return urgentQueueMode === "interrupt" ? "interrupt" : "steer";
  if (priority === 2) return "steer";
  return undefined;
}

/** `[SKIP]` is the smart-mode silence sentinel — never post it as a message. */
export function isSkipReply(text: string): boolean {
  return text.trim() === "[SKIP]";
}

// ─── Bridge state ────────────────────────────────────────────
interface BridgeState {
  bridge: any;
  http: any;
  orgConfig: any;
  memberNames: Map<string, string>;
}

let state: BridgeState | null = null;

// ─── Owner persistence (SDK onOwnerBind / onOwnerNameHint callbacks) ─────────
async function persistOwner(memberId: string, name: string): Promise<void> {
  const runtime = getRuntime();
  try {
    const cfg = await (runtime as any).config.loadConfig();
    const openmax = (((cfg.channels ||= {}) as any).openmax ||= {});
    openmax.owner = { memberId, ...(name ? { name } : {}) };
    await (runtime as any).config.writeConfigFile(cfg);
    console.log(`[openmax] owner persisted: member_id=${memberId} name="${name}"`);
  } catch (err: any) {
    console.error(`[openmax] owner persist failed: ${err?.message}`);
  }
}

// ─── Inbound: CWS → OpenClaw session ─────────────────────────
async function resolveMemberName(st: BridgeState, orgId: string, memberId: string): Promise<string | null> {
  if (!memberId) return null;
  const cached = st.memberNames.get(memberId);
  if (cached) return cached;
  try {
    const m = await st.http.getForOrg(orgId, st.http.apiPath(`/members/${memberId}`));
    const name = m?.display_name || m?.username || null;
    if (name) st.memberNames.set(memberId, name);
    return name;
  } catch {
    return null;
  }
}

async function fetchGroupContext(
  st: BridgeState,
  orgId: string,
  conversationId: string,
  beforeSeq: number | undefined,
  limit: number,
): Promise<Array<{ senderName: string; content: string }>> {
  try {
    const r = await st.http.getForOrg(orgId, st.http.apiPath(`/conversations/${conversationId}/messages`), {
      before_seq: beforeSeq,
      limit,
    });
    const rows: any[] = Array.isArray(r) ? r : r?.data || r?.messages || r?.items || [];
    // list-messages with before_seq returns newest→oldest; read chronologically.
    const asc = [...rows].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    return await Promise.all(
      asc.map(async (m) => ({
        senderName:
          m.sender_display_name ||
          m.senderName ||
          (await resolveMemberName(st, orgId, m.sender_id)) ||
          String(m.sender_id || "unknown"),
        content:
          m.content?.body?.text || (typeof m.content === "string" ? m.content : "") || m.content_text || "",
      })),
    );
  } catch {
    return [];
  }
}

async function fetchQuoted(
  st: BridgeState,
  orgId: string,
  conversationId: string,
  messageId: string,
): Promise<{ sender: string; text: string } | undefined> {
  try {
    const q = await st.http.getForOrg(
      orgId,
      st.http.apiPath(`/conversations/${conversationId}/messages/${messageId}`),
    );
    const text =
      q?.content?.body?.text ||
      (typeof q?.message?.content === "string" ? q.message.content : "") ||
      q?.message?.fallback_text ||
      "";
    if (!text) return undefined;
    const senderId = q?.message?.sender_id;
    const sender =
      q?.message?.sender_display_name || (await resolveMemberName(st, orgId, senderId)) || String(senderId || "unknown");
    return { sender, text };
  } catch {
    return undefined;
  }
}

/**
 * InboundDelivery.deliver — the SDK hands us a normalized InboundMessage after
 * dedupe → detail-fetch → access-policy. INVARIANT: return {ok:true} only once
 * the message genuinely entered the agent's visible context; on failure return
 * {ok:false} so the ledger/sync layer retries instead of silently dropping.
 */
async function deliverInbound(msg: any, _endpoint: string, priority?: 1 | 2 | 3): Promise<any> {
  const st = state;
  if (!st) return { ok: false, failureClass: "wake_failed", retryAfterMs: 5_000 };
  const core = getRuntime();
  const cfg = (core as any).config ? await (core as any).config.loadConfig() : {};
  const acct = resolveOpenMaxConfig(cfg);

  const isDm = msg.conversationType === "dm";
  const chatType = isDm ? "direct" : "channel";
  const groupName = msg.decision?.groupCfg?.name || msg.conversation?.name;
  const senderName = msg.senderDisplayName || msg.senderId || "unknown";

  // Record participant names for outbound @mention canonicalization.
  recordParticipants(msg.conversationId, [senderName]);

  // mode=silent: consume as context only — record it, never wake the agent.
  // (SDK semantics: decideInbound passes silent through with mode surfaced and
  // leaves the interpretation to the adapter; confirm with the SDK owner.)
  if (msg.decision?.mode === "silent") {
    return { ok: true };
  }

  // Context blocks (group history + quoted reply + smart hint).
  const blocks: ContextBlocks = {};
  if (!isDm) {
    blocks.groupContext = await fetchGroupContext(
      st,
      msg.orgId,
      msg.conversationId,
      msg.seq,
      acct.contextMessages ?? DEFAULT_CONTEXT_MESSAGES,
    );
    recordParticipants(msg.conversationId, blocks.groupContext.map((m) => m.senderName));
  }
  if (msg.parentMessageId && msg.conversationType !== "thread") {
    blocks.quoted = await fetchQuoted(st, msg.orgId, msg.conversationId, msg.parentMessageId);
  }
  blocks.smartHint = msg.decision?.mode === "smart" && !msg.decision?.mentioned;

  const rawText = labelMedia(msg.text || "", msg.type || "", msg.attachments || []);
  const content = buildInboundBody(rawText, blocks);

  const from = `openmax:${msg.senderId || "unknown"}`;
  const to = `openmax:${ACCOUNT_ID}`;

  const route = (core as any).channel.routing.resolveAgentRoute({
    channel: "openmax",
    from,
    chatType,
    groupSubject: isDm ? undefined : groupName || msg.conversationId,
    cfg,
  });

  const envelopeOptions = (core as any).channel.reply.resolveEnvelopeFormatOptions(cfg);
  const formattedBody = (core as any).channel.reply.formatAgentEnvelope({
    channel: "OpenMax",
    from: senderName,
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: content,
  });

  const ctxPayload = (core as any).channel.reply.finalizeInboundContext({
    Body: formattedBody,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: ACCOUNT_ID,
    ChatType: chatType,
    GroupSubject: isDm ? undefined : groupName || msg.conversationId,
    SenderName: senderName,
    SenderId: msg.senderId,
    Provider: "openmax" as const,
    Surface: "openmax" as const,
    MessageSid: msg.messageId,
    Timestamp: Date.now(),
    WasMentioned: msg.decision?.mentioned ?? true,
    CommandAuthorized: true,
    OriginatingChannel: "openmax" as const,
    OriginatingTo: to,
    ConversationLabel: isDm ? senderName : groupName || msg.conversationId,
  });

  const queueModeOverride = resolveQueueModeOverride(priority, acct.urgentQueueMode);

  try {
    await (core as any).channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          const text = typeof payload === "string" ? payload : (payload?.text ?? payload?.body ?? String(payload));
          if (!text?.trim() || isSkipReply(text)) return;
          await sendOutbound(st, msg.endpoint, text, { orgId: msg.orgId });
        },
        onError: (err: any, info: any) => {
          console.error(`[openmax] ${info?.kind ?? "unknown"} reply error:`, err);
        },
      },
      // Per-message queue-mode override carries the System Member priority into
      // the OpenClaw session (steer into the active turn / interrupt).
      replyOptions: queueModeOverride ? { queueModeOverride } : {},
    });
    return { ok: true, runtimeSession: route.sessionKey };
  } catch (err: any) {
    console.error(`[openmax] dispatch failed for msg=${msg.messageId}:`, err?.message || err);
    return { ok: false, failureClass: "wake_failed", retryAfterMs: 5_000 };
  }
}

// ─── Outbound: OpenClaw → CWS ────────────────────────────────
async function sendOutbound(
  st: BridgeState,
  endpoint: string,
  text: string,
  opts: { orgId?: string; replyTo?: string } = {},
): Promise<{ messageId: string; chunks: number }> {
  const conversationId = endpoint.split("|")[0];
  const canonical = resolveMentions(text, conversationId);
  const chunks: string[] = splitMessage(canonical);
  let firstId = "";
  for (let i = 0; i < chunks.length; i++) {
    // parent_id only on the first chunk to avoid duplicate threading.
    const res = await st.bridge.send(endpoint, chunks[i], {
      orgId: opts.orgId,
      ...(i === 0 && opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    if (i === 0) firstId = res?.messageId || "";
  }
  return { messageId: firstId, chunks: chunks.length };
}

// ─── Bridge lifecycle ────────────────────────────────────────
function buildOrgConfig(acct: OpenMaxChannelConfig): any {
  return {
    slug: ACCOUNT_ID,
    org_id: acct.orgId,
    ...(acct.orgName ? { org_name: acct.orgName } : {}),
    self: {
      ...(acct.agentId ? { member_id: acct.agentId } : {}),
      ...(acct.agentName ? { display_name: acct.agentName, name: acct.agentName } : {}),
    },
    owner: acct.owner?.memberId ? { member_id: acct.owner.memberId, name: acct.owner.name || "" } : {},
    access: acct.access || {},
  };
}

async function startBridge(acct: OpenMaxChannelConfig, log: any): Promise<void> {
  const dataDir = getDataDir();
  const storage = fileStorage(path.join(dataDir, "kv.json"));
  const logger = {
    info: (...a: any[]) => log?.info?.(a.join(" ")),
    log: (...a: any[]) => log?.info?.(a.join(" ")),
    warn: (...a: any[]) => log?.warn?.(a.join(" ")),
    error: (...a: any[]) => log?.error?.(a.join(" ")),
  };

  const orgConfig = buildOrgConfig(acct);

  const tokenManager = new TokenManager({
    apiKey: acct.agentToken,
    coreUrl: acct.coreUrl,
    storage,
    resolveDefaultOrgId: () => acct.orgId || "",
    // cws-core writes the agent's member_id back on token exchange; keep the
    // live orgConfig in sync so the self-echo / @-mention gates work.
    onMemberId: (memberId: string) => {
      orgConfig.self.member_id = memberId;
    },
    logger,
  });

  const http = new CwsHttpClient({
    baseUrl: acct.coreUrl,
    apiKey: acct.agentToken,
    tokenManager,
    resolveDefaultOrgId: () => acct.orgId || "",
    logger,
  });

  const sessionFile = (slug: string) => path.join(dataDir, `session-${slug}.json`);

  const bridge = new CwsAgentBridge({
    http,
    tokenManager,
    ws: { baseUrl: acct.wsUrl },
    orgConfigs: [orgConfig],
    providers: {
      storage,
      logger,
      inbound: { deliver: deliverInbound },
    },
    callbacks: {
      loadSession: (slug: string) => readJson(sessionFile(slug)) || {},
      saveSession: (slug: string, partial: any) => {
        writeJson(sessionFile(slug), { ...(readJson(sessionFile(slug)) || {}), ...partial });
      },
      onOwnerBind: (_slug: string, memberId: string, displayName: string) => {
        orgConfig.owner = { member_id: memberId, name: displayName || "" };
        void persistOwner(memberId, displayName);
      },
      onOwnerNameHint: (_slug: string, name: string) => {
        orgConfig.owner.name = name;
        void persistOwner(orgConfig.owner.member_id, name);
      },
      onOrgTerminated: (org: any, code: number, reason: string) => {
        log?.error?.(`openmax: org ${org?.slug} terminated code=${code} reason="${reason || ""}"`);
      },
    },
    reporters: { version: "0.1.0" },
  });

  state = { bridge, http, orgConfig, memberNames: new Map() };
  await bridge.start();
}

async function stopBridge(): Promise<void> {
  const st = state;
  state = null;
  if (st) {
    try {
      await st.bridge.stop();
    } catch {
      /* stopping a half-started bridge must not throw out of the gateway */
    }
  }
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
  messaging: {
    targetResolver: {
      hint: 'Use a conversation id, optionally with routing suffixes: "<convId>[|reply:<msgId>]"',
      looksLikeId: (raw: string): boolean => !!raw.trim(),
    },
  },
  config: {
    listAccountIds: (_cfg: any) => [ACCOUNT_ID],
    resolveAccount: (cfg: any, accountId?: string) => {
      const acct = resolveOpenMaxConfig(cfg);
      return {
        accountId: accountId || ACCOUNT_ID,
        enabled: acct.enabled !== false,
        configured: !!(acct.coreUrl && acct.wsUrl && acct.agentToken && acct.orgId),
        config: acct,
      };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 8000,
    sendText: async (params: { cfg: any; to: string; text: string; replyToId?: string }) => {
      const st = state;
      if (!st) throw new Error("openmax: bridge not connected");
      if (isSkipReply(params.text)) return { channel: "openmax" as const, messageId: "", skipped: true };
      const acct = resolveOpenMaxConfig(params.cfg);
      const result = await sendOutbound(st, params.to, params.text, {
        orgId: acct.orgId,
        replyTo: params.replyToId,
      });
      return { channel: "openmax" as const, ...result };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const acct = resolveOpenMaxConfig(ctx.cfg);
      ctx.setStatus?.({ accountId: ctx.accountId || ACCOUNT_ID });
      if (acct.coreUrl && acct.wsUrl && acct.agentToken && acct.orgId) {
        try {
          await startBridge(acct, ctx.log);
          ctx.log?.info?.("openmax: bridge started");
        } catch (err: any) {
          ctx.log?.error?.(`openmax: bridge start failed: ${err?.message}`);
        }
      } else {
        ctx.log?.warn?.("openmax: coreUrl/wsUrl/agentToken/orgId not fully configured, account idle");
      }
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) return resolve();
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await stopBridge();
    },
    stopAccount: async (_ctx: any) => {
      await stopBridge();
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
    api.logger.info("openmax: plugin loaded (SDK-backed, single account)");
  },
};

export default plugin;
