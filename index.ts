import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { randomUUID } from "crypto";
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
  const runtime = getRuntime() as any;
  // runtime.state.resolveStateDir() is the supported persistent-state surface;
  // dataDir is kept as a fallback for older OpenClaw builds. tmpdir is a last
  // resort only — it would lose the inbox-ledger dedupe state on reboot.
  const baseDir = runtime.state?.resolveStateDir?.() || runtime.dataDir;
  if (baseDir) return path.join(baseDir, "plugins", "openclaw-openmax");
  if (!_dataDirWarned) {
    console.warn("[openmax] no persistent state dir available, falling back to os.tmpdir()");
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
  } catch (err: any) {
    // A corrupt (vs absent) store must be loud: losing kv.json silently resets
    // the inbox ledger and JWT cache, which replays already-ACKed messages.
    if (err?.code !== "ENOENT") {
      console.error(`[openmax] read ${file} failed (treating as empty): ${err?.message}`);
    }
    return null;
  }
}

function writeJson(file: string, value: any): void {
  try {
    // 0700/0600 — kv.json holds cached JWT/refresh tokens. tmp+rename keeps a
    // crash mid-write from truncating the ledger/token store.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err: any) {
    console.error(`[openmax] write ${file} failed: ${err?.message}`);
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
const MAX_TRACKED_CONVS = 500;
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
  // Also bound the number of tracked conversations (drop oldest insertion).
  const convIds = Object.keys(reg);
  if (convIds.length > MAX_TRACKED_CONVS) {
    for (const id of convIds.slice(0, convIds.length - MAX_TRACKED_CONVS)) delete reg[id];
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
    // Replacer function: a display name containing `$&`/`$'` must not expand
    // as a replacement pattern and splice message text into the output.
    out = out.replace(new RegExp("@" + esc, "gi"), () => "@" + name);
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
 *  MVP: label only; attachment download is a post-MVP alignment item.
 *  `text` must already be escaped by the caller; file_name is escaped here. */
function labelMedia(text: string, msgType: string, attachments: any[]): string {
  const first = Array.isArray(attachments) ? attachments[0] : null;
  const isImage = msgType === "image" || msgType === "agent_card";
  if (isImage) return `[image]${text ? " " + text : ""}`;
  if (first) {
    const fileName = first.file_name ? escapeXml(String(first.file_name).replace(/[\r\n]+/g, " ")) : "";
    return `[file${fileName ? ": " + fileName : ""}]${text ? " " + text : ""}`;
  }
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
  const runtime = getRuntime() as any;
  try {
    // loadConfig()/current() return the LIVE shared config snapshot — clone
    // before mutating so a failed write can't corrupt other consumers.
    const loaded = runtime.config.current?.() ?? (await runtime.config.loadConfig());
    const cfg = structuredClone(loaded ?? {});
    const openmax = ((cfg.channels ||= {}).openmax ||= {});
    openmax.owner = { memberId, ...(name ? { name } : {}) };
    await runtime.config.writeConfigFile(cfg);
    console.log(`[openmax] owner persisted: member_id=${memberId} name="${name}"`);
  } catch (err: any) {
    console.error(`[openmax] owner persist failed: ${err?.message}`);
  }
}

// ─── Inbound: CWS → OpenClaw session ─────────────────────────
// The SDK http client has no request timeout; context fetches degrade to their
// fallback instead of stalling the org's delivery pipeline on a hung request.
const CONTEXT_FETCH_TIMEOUT_MS = 8_000;
function withTimeout<T>(p: Promise<T>, fallback: T, ms = CONTEXT_FETCH_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms);
      (t as any).unref?.();
    }),
  ]);
}

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
  // config.current() is the sanctioned cached-snapshot accessor; loadConfig()
  // is kept as a fallback for older OpenClaw builds (it is deprecated, not gone).
  const cfg = (core as any).config.current?.() ?? (await (core as any).config.loadConfig());
  const acct = resolveOpenMaxConfig(cfg);

  const isDm = msg.conversationType === "dm";
  const chatType = isDm ? "direct" : "channel";
  const groupName = msg.decision?.groupCfg?.name || msg.conversation?.name;
  const senderName = msg.senderDisplayName || msg.senderId || "unknown";

  // Record participant names for outbound @mention canonicalization.
  recordParticipants(msg.conversationId, [senderName]);

  // mode=silent: consume without waking the agent — only the sender name (already
  // recorded above) is captured; history is re-fetched from CWS on the next
  // non-silent delivery, so nothing is lost. (SDK semantics: decideInbound passes
  // silent through with mode surfaced and leaves interpretation to the adapter;
  // confirm with the SDK owner.) ok:true is the intended ACK here.
  if (msg.decision?.mode === "silent") {
    return { ok: true };
  }

  // Context blocks (group history + quoted reply + smart hint).
  const blocks: ContextBlocks = {};
  if (!isDm) {
    blocks.groupContext = await withTimeout(
      fetchGroupContext(st, msg.orgId, msg.conversationId, msg.seq, acct.contextMessages ?? DEFAULT_CONTEXT_MESSAGES),
      [],
    );
    recordParticipants(msg.conversationId, blocks.groupContext.map((m) => m.senderName));
  }
  if (msg.parentMessageId && msg.conversationType !== "thread") {
    blocks.quoted = await withTimeout(
      fetchQuoted(st, msg.orgId, msg.conversationId, msg.parentMessageId),
      undefined,
    );
  }
  blocks.smartHint = msg.decision?.mode === "smart" && !msg.decision?.mentioned;

  // Escape the sender-controlled text BEFORE the plugin-generated media label is
  // prepended — a message body must not be able to forge <group-context>/<replying-to>
  // framing (zylos escapes the current message the same way).
  const rawText = labelMedia(escapeXml(msg.text || ""), msg.type || "", msg.attachments || []);
  const content = buildInboundBody(rawText, blocks);

  const from = `openmax:${msg.senderId || "unknown"}`;
  const to = `openmax:${ACCOUNT_ID}`;

  // peer drives per-conversation session isolation (buildAgentSessionKey);
  // without it every conversation collapses into the agent's main session.
  const route = (core as any).channel.routing.resolveAgentRoute({
    cfg,
    channel: "openmax",
    accountId: ACCOUNT_ID,
    peer: isDm
      ? { kind: "direct" as const, id: msg.senderId || msg.conversationId }
      : { kind: "group" as const, id: msg.conversationId },
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

  // Priority is read from message metadata, which a non-system sender could
  // forge; only genuine System Members may escalate queue handling (interrupt
  // would abort the agent's in-flight work).
  const queueModeOverride =
    msg.senderType === "SYSTEM" ? resolveQueueModeOverride(priority, acct.urgentQueueMode) : undefined;

  try {
    await (core as any).channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        // Reply-failure semantics (matches zylos): the ACK point is "message
        // entered the agent session" — a later failure sending the agent's
        // reply back to CWS is logged, but must NOT re-run the inbound (that
        // would make the agent process the same message twice and re-post
        // already-sent chunks).
        deliver: async (payload: any) => {
          const text = typeof payload === "string" ? payload : (payload?.text ?? payload?.body ?? String(payload));
          if (!text?.trim() || isSkipReply(text)) return;
          try {
            await sendOutbound(st, msg.endpoint, text, { orgId: msg.orgId });
          } catch (err: any) {
            console.error(`[openmax] reply send failed for msg=${msg.messageId}:`, err?.message || err);
          }
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
  // parent_id only on the first chunk: bridge.send falls back to the endpoint's
  // own |reply:/|parent: suffixes, so later chunks must go to a stripped
  // endpoint (keep |thread: — it drives conversation routing).
  const strippedEndpoint = endpoint
    .split("|")
    .filter((seg, i) => i === 0 || seg.startsWith("thread:"))
    .join("|");
  let firstId = "";
  for (let i = 0; i < chunks.length; i++) {
    const res = await st.bridge.send(i === 0 ? endpoint : strippedEndpoint, chunks[i], {
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

/** Stable per-install device id — cws-comm keys /sync cursors per device. */
function stableDeviceId(dataDir: string): string {
  const file = path.join(dataDir, "device-id");
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch {
    /* first run */
  }
  const v = `openclaw-openmax-${randomUUID()}`;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, v + "\n", { mode: 0o600 });
  } catch {
    /* non-persistent id still works for this process */
  }
  return v;
}

async function startBridge(acct: OpenMaxChannelConfig, log: any): Promise<BridgeState> {
  // The SDK http client logs full RPC responses (incl. the token-exchange
  // response carrying JWT + refresh token) unless COCO_RPC_LOG=0. Default it
  // off; an operator can still opt in explicitly.
  if (!process.env.COCO_RPC_LOG) process.env.COCO_RPC_LOG = "0";

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
    // NOTE the SDK signature is (orgId, memberId).
    onMemberId: (_orgId: string, memberId: string) => {
      if (memberId) orgConfig.self.member_id = memberId;
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
    ws: { baseUrl: acct.wsUrl, deviceId: stableDeviceId(dataDir), clientVersion: "0.1.0" },
    orgConfigs: [orgConfig],
    providers: {
      storage,
      logger,
      inbound: { deliver: deliverInbound },
    },
    callbacks: {
      // Session-cursor recovery: the SDK persists the ledger watermark
      // (kv.json, on every record) but only writes sync_seq on the periodic
      // ack tick, and bridge.stop() doesn't flush it — so a restart shortly
      // after a delivery finds no cursor and the SDK's first-connect
      // seek-to-inbox-end SKIPS messages that arrived while we were down
      // (observed live: owner's message lost across the owner-bind config
      // restart). Seed the cursor from the ledger's acked_seq. NOTE: the
      // `inbox-<slug>.json` storage key is SDK-internal — remove this once the
      // SDK flushes the cursor on stop (reported upstream).
      loadSession: (slug: string) => {
        const session = readJson(sessionFile(slug));
        if (session?.sync_seq) return session;
        try {
          const kv = readJson(path.join(dataDir, "kv.json")) || {};
          const ledger = JSON.parse(kv[`inbox-${slug}.json`] || "null");
          if (ledger?.acked_seq > 0) {
            console.log(`[openmax] seeding sync_seq=${ledger.acked_seq} from inbox-ledger watermark`);
            return { ...(session || {}), sync_seq: ledger.acked_seq };
          }
        } catch {
          /* no ledger state — genuine first connect */
        }
        return session || {};
      },
      saveSession: (slug: string, partial: any) => {
        writeJson(sessionFile(slug), { ...(readJson(sessionFile(slug)) || {}), ...partial });
      },
      // Self-name hydration barrier: fetch the authoritative display_name so
      // text "@Name" mention detection matches what cws-fe renders. Without
      // this the SDK never reaches nameReady and burns retry backoff per
      // (re)connect.
      syncSelf: async (oc: any) => {
        const memberId = oc?.self?.member_id;
        if (!memberId) return { nameReady: false, reason: "no member_id yet" };
        try {
          const m = await http.getForOrg(oc.org_id, http.apiPath(`/members/${memberId}`));
          const name = m?.display_name || m?.username;
          if (!name) return { nameReady: false, reason: "member has no display_name" };
          oc.self = { ...(oc.self || {}), display_name: name, name };
          return { nameReady: true };
        } catch (err: any) {
          return { nameReady: false, reason: err?.message || "self fetch failed" };
        }
      },
      // member_id write-back backfill source for the hydrator.
      loadConfig: () => ({ orgs: { [ACCOUNT_ID]: orgConfig } }),
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

  // state must be live before start(): inbound frames can arrive as soon as the
  // WS opens, and deliverInbound reads the module singleton.
  const st: BridgeState = { bridge, http, orgConfig, memberNames: new Map() };
  state = st;
  try {
    await bridge.start();
  } catch (err) {
    await stopBridge(st);
    throw err;
  }
  return st;
}

/** Tear down a bridge. With a target, only clears the module singleton when it
 *  still points at that bridge — an old gateway invocation's teardown must not
 *  kill a newer bridge that already replaced it (restart race). */
async function stopBridge(target?: BridgeState): Promise<void> {
  const st = target ?? state;
  if (!st) return;
  if (state === st) state = null;
  try {
    await st.bridge.stop();
  } catch {
    /* stopping a half-started bridge must not throw out of the gateway */
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
      // [SKIP] sentinel: signal non-delivery via an empty messageId result
      // (channel-specific extras belong in meta per OutboundDeliveryResult).
      if (isSkipReply(params.text)) return { channel: "openmax" as const, messageId: "", meta: { skipped: true } };
      const acct = resolveOpenMaxConfig(params.cfg);
      const { messageId, chunks } = await sendOutbound(st, params.to, params.text, {
        orgId: acct.orgId,
        replyTo: params.replyToId,
      });
      return { channel: "openmax" as const, messageId, meta: { chunks } };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const acct = resolveOpenMaxConfig(ctx.cfg);
      ctx.setStatus?.({ accountId: ctx.accountId || ACCOUNT_ID });
      let st: BridgeState | null = null;
      if (acct.coreUrl && acct.wsUrl && acct.agentToken && acct.orgId) {
        try {
          st = await startBridge(acct, ctx.log);
          ctx.log?.info?.("openmax: bridge started");
        } catch (err: any) {
          // startBridge already tore down its own half-started bridge.
          ctx.log?.error?.(`openmax: bridge start failed: ${err?.message}`);
        }
      } else {
        ctx.log?.warn?.("openmax: coreUrl/wsUrl/agentToken/orgId not fully configured, account idle");
      }
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) return resolve();
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // Tear down only the bridge THIS invocation started (restart-race safe).
      if (st) await stopBridge(st);
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
