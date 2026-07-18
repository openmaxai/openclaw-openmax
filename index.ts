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
  AsService,
  CommService,
  CwsAgentBridge,
  CwsHttpClient,
  TokenManager,
  createMentionRegistry,
  parseEndpoint,
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
// SDK createMentionRegistry (absorbed there per issue #8): records the display
// names seen inbound and canonicalizes `@name` tokens on outbound so cws-fe's
// literal-display-name matcher highlights them. Backed by the plugin's kv store.
let _mentionRegistry: any = null;
function getMentionRegistry(): any {
  if (!_mentionRegistry) {
    _mentionRegistry = createMentionRegistry({
      storage: fileStorage(path.join(getDataDir(), "kv.json")),
      log: (...a: any[]) => console.log("[openmax]", ...a),
    });
  }
  return _mentionRegistry;
}

async function recordParticipants(conversationId: string, names: Array<string | undefined>): Promise<void> {
  try {
    await getMentionRegistry().recordParticipants(conversationId, names.filter(Boolean) as string[]);
  } catch {
    /* best-effort: registry failures must never break message handling */
  }
}

async function resolveMentions(text: string, conversationId: string): Promise<string> {
  try {
    return await getMentionRegistry().resolveMentions(text, conversationId);
  } catch {
    return text;
  }
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
  quoted?: { sender: string; text: string; attachments?: any[] };
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

/** Body caption for media messages so an image/file isn't delivered as an
 *  empty body. The actual attachment bytes reach the model via ctx.MediaPaths
 *  (downloadAttachments); when a download fails, this label is the fallback.
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

// ─── Inbound media (attachments → local files the model can see) ─────────────
// OpenClaw feeds images to the model via ctx.MediaPaths — LOCAL file paths that
// must live under its allowed media roots; a path mentioned in the body text is
// never read. Files are saved through core.channel.media.saveMediaBuffer so
// they land in an allowed root (<configDir>/media/inbound) and are covered by
// the gateway's media TTL cleanup.
const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // OpenClaw's inline-image cap per agent turn
const MEDIA_FETCH_TIMEOUT_MS = 30_000;

interface DownloadedMedia {
  path: string;
  mime: string;
}

const MAX_ATTACHMENTS_PER_MESSAGE = 8;

async function downloadAttachments(st: BridgeState, core: any, attachments: any[]): Promise<DownloadedMedia[]> {
  // Downloads run in parallel (each self-guarded by timeout + catch) so N slow
  // or unavailable attachments cost one timeout window, not N — a serial loop
  // here would stall the org's delivery pipeline for minutes.
  const list = (attachments || []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const results = await Promise.all(
    list.map(async (att): Promise<DownloadedMedia | null> => {
      const artifactId = att?.artifact_id; // NOT media_id — /artifacts/resolve only accepts artifact ids
      if (!artifactId) return null;
      if (att.size_bytes && att.size_bytes > MEDIA_MAX_BYTES) {
        console.warn(`[openmax] attachment ${att.file_name || artifactId} exceeds ${MEDIA_MAX_BYTES}B, label only`);
        return null;
      }
      try {
        return await withTimeout<DownloadedMedia | null>(
          (async () => {
            const { url, contentType } = await st.as.getMediaUrl(artifactId);
            if (!url) return null;
            const buf = await st.http.getBytes(url);
            const saved = await core.channel.media.saveMediaBuffer(
              buf,
              att.content_type || contentType || "",
              "inbound",
              MEDIA_MAX_BYTES,
              att.file_name,
            );
            return saved?.path ? { path: saved.path, mime: saved.contentType || att.content_type || "" } : null;
          })(),
          null,
          MEDIA_FETCH_TIMEOUT_MS,
        );
      } catch (err: any) {
        // Degrade to the [image]/[file] label — a failed download must never
        // block message delivery.
        console.warn(`[openmax] attachment download failed (${att.file_name || artifactId}): ${err?.message}`);
        return null;
      }
    }),
  );
  return results.filter((m): m is DownloadedMedia => m !== null);
}

// ─── Bridge state ────────────────────────────────────────────
interface BridgeState {
  bridge: any;
  http: any;
  as: any;
  comm: any;
  orgConfig: any;
  memberNames: Map<string, string>;
}

let state: BridgeState | null = null;

// REST-only stack for processes without a running gateway bridge (e.g.
// `openclaw message send` runs the plugin in a fresh CLI process). Outbound is
// stateless REST, so it must not depend on the WS bridge singleton. Shares the
// on-disk token cache with the gateway (atomic writes).
interface RestStack {
  http: any;
  comm: any;
  key: string;
}

let restStack: RestStack | null = null;

function getRestStack(acct: OpenMaxChannelConfig): RestStack {
  const key = `${acct.coreUrl}|${acct.orgId}|${acct.agentToken?.slice(0, 12)}`;
  if (restStack?.key === key) return restStack;
  if (!process.env.COCO_RPC_LOG) process.env.COCO_RPC_LOG = "0";
  const storage = fileStorage(path.join(getDataDir(), "kv.json"));
  const tokenManager = new TokenManager({
    apiKey: acct.agentToken,
    coreUrl: acct.coreUrl,
    storage,
    resolveDefaultOrgId: () => acct.orgId || "",
  });
  const http = new CwsHttpClient({
    baseUrl: acct.coreUrl,
    apiKey: acct.agentToken,
    tokenManager,
    resolveDefaultOrgId: () => acct.orgId || "",
  });
  restStack = { http, comm: new CommService(http), key };
  return restStack;
}

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

const MAX_MEMBER_NAME_CACHE = 500;

async function resolveMemberName(st: BridgeState, orgId: string, memberId: string): Promise<string | null> {
  if (!memberId) return null;
  const cached = st.memberNames.get(memberId);
  if (cached) return cached;
  try {
    const m = await st.http.getForOrg(orgId, st.http.apiPath(`/members/${memberId}`));
    const name = m?.display_name || m?.username || null;
    if (name) {
      // Bound the cache: a long-running gateway in a high-churn workspace must
      // not grow it forever. Insertion-order eviction (Map preserves order).
      if (st.memberNames.size >= MAX_MEMBER_NAME_CACHE) {
        const oldest = st.memberNames.keys().next().value;
        if (oldest !== undefined) st.memberNames.delete(oldest);
      }
      st.memberNames.set(memberId, name);
    }
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
): Promise<{ sender: string; text: string; attachments: any[] } | undefined> {
  try {
    const q = await st.http.getForOrg(
      orgId,
      st.http.apiPath(`/conversations/${conversationId}/messages/${messageId}`),
    );
    const structured = q?.content && typeof q.content === "object" ? q.content : {};
    let text =
      structured.body?.text ||
      (typeof q?.message?.content === "string" ? q.message.content : "") ||
      q?.message?.fallback_text ||
      "";
    const attachments: any[] = Array.isArray(structured.attachments) ? structured.attachments : [];
    // A caption-less quoted image/file would otherwise drop the whole quote.
    // Build the label UNESCAPED here — buildInboundBody escapes the quoted text
    // exactly once (labelMedia pre-escapes file_name, which would double-escape
    // if escapeXml ever grows beyond </>).
    if (!text && attachments.length > 0) {
      const qType = (q?.message?.type || "").toLowerCase();
      const isImage = qType === "image" || qType === "agent_card";
      const fileName = String(attachments[0]?.file_name || "").replace(/[\r\n]+/g, " ");
      text = isImage ? "[image]" : `[file${fileName ? ": " + fileName : ""}]`;
    }
    if (!text) return undefined;
    const senderId = q?.message?.sender_id;
    const sender =
      q?.message?.sender_display_name || (await resolveMemberName(st, orgId, senderId)) || String(senderId || "unknown");
    return { sender, text, attachments };
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
  void recordParticipants(msg.conversationId, [senderName]);

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
    void recordParticipants(msg.conversationId, blocks.groupContext.map((m) => m.senderName));
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

  // Download inbound media (current message + quoted, one parallel batch) so
  // the vision model can actually see it — the [image] label is only a caption.
  const media = await downloadAttachments(st, core, [
    ...(msg.attachments || []),
    ...(blocks.quoted?.attachments || []),
  ]);

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
    // MediaPaths is how OpenClaw feeds images to the model (collected per turn,
    // image/* entries are inlined as base64). MediaUrls falls back to the local
    // path by core convention; the single-value fields serve legacy consumers.
    ...(media.length > 0
      ? {
          MediaPaths: media.map((m) => m.path),
          MediaUrls: media.map((m) => m.path),
          MediaTypes: media.map((m) => m.mime),
          MediaPath: media[0].path,
          MediaType: media[0].mime,
        }
      : {}),
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
            await sendOutbound(st, msg.endpoint, text);
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
  sender: { comm: any },
  endpoint: string,
  text: string,
  opts: { replyTo?: string } = {},
): Promise<{ messageId: string; chunks: number }> {
  const ep = parseEndpoint(endpoint); // throws on an invalid endpoint
  // A thread is its own conversation — send into it; else the parent conversation.
  const conversationId = ep.threadConversationId || ep.conversationId;
  const replyTo = opts.replyTo || ep.replyTo || ep.parentMessageId;
  const canonical = await resolveMentions(text, conversationId);
  const chunks: string[] = splitMessage(canonical);
  let firstId = "";
  for (let i = 0; i < chunks.length; i++) {
    // CommService.send: markdown auto-detect + client_msg_id idempotency.
    // parent_id only on the first chunk to avoid duplicate threading.
    const res = await sender.comm.send({
      conversationId,
      content: chunks[i],
      ...(i === 0 && replyTo ? { replyTo } : {}),
    });
    if (i === 0) firstId = res?.id || res?.message_id || res?.message?.id || "";
  }
  return { messageId: firstId, chunks: chunks.length };
}

// ─── Bridge lifecycle ────────────────────────────────────────
// SDK ≥ alpha.2 keys orgs by org_id everywhere (slug removed) — session/ledger
// storage keys and callback identities all carry the org UUID.
function buildOrgConfig(acct: OpenMaxChannelConfig): any {
  return {
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

  const sessionFile = (orgId: string) => path.join(dataDir, `session-${orgId}.json`);

  // One-time migration from the pre-alpha.2 slug-keyed stores ("default") to
  // org_id-keyed: rename the session file and the ledger key inside kv.json so
  // the cursor/watermark survive the SDK upgrade instead of re-seeking.
  try {
    const oldSession = path.join(dataDir, "session-default.json");
    if (acct.orgId && fs.existsSync(oldSession) && !fs.existsSync(sessionFile(acct.orgId))) {
      fs.renameSync(oldSession, sessionFile(acct.orgId));
      console.log(`[openmax] migrated session-default.json → session-${acct.orgId}.json`);
    }
    const kvFile = path.join(dataDir, "kv.json");
    const kv = readJson(kvFile);
    if (acct.orgId && kv && kv["inbox-default.json"] !== undefined && kv[`inbox-${acct.orgId}.json`] === undefined) {
      kv[`inbox-${acct.orgId}.json`] = kv["inbox-default.json"];
      delete kv["inbox-default.json"];
      writeJson(kvFile, kv);
      console.log(`[openmax] migrated inbox-default.json → inbox-${acct.orgId}.json`);
    }
  } catch (err: any) {
    console.warn(`[openmax] slug→org_id store migration failed: ${err?.message}`);
  }

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
      // Cursor recovery lives in the SDK now (issues #4/#5: the orchestrator
      // seeds/clamps sync_seq from the ledger's durable acked_seq, and gap
      // sweeps floor at the watermark) — the plugin just persists the session.
      loadSession: (orgId: string) => readJson(sessionFile(orgId)) || {},
      saveSession: (orgId: string, partial: any) => {
        writeJson(sessionFile(orgId), { ...(readJson(sessionFile(orgId)) || {}), ...partial });
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
      loadConfig: () => ({ orgs: { [acct.orgId || ""]: orgConfig } }),
      onOwnerBind: (_slug: string, memberId: string, displayName: string) => {
        orgConfig.owner = { member_id: memberId, name: displayName || "" };
        void persistOwner(memberId, displayName);
      },
      onOwnerNameHint: (_orgId: string, name: string) => {
        // Defensive: the SDK only emits the hint for a bound owner, but never
        // persist a name without a member_id (it would drop the binding).
        if (!orgConfig.owner?.member_id || !name) return;
        orgConfig.owner.name = name;
        void persistOwner(orgConfig.owner.member_id, name);
      },
      onOrgTerminated: (org: any, code: number, reason: string) => {
        log?.error?.(`openmax: org ${org?.org_id} terminated code=${code} reason="${reason || ""}"`);
      },
    },
    reporters: { version: "0.1.0" },
  });

  // state must be live before start(): inbound frames can arrive as soon as the
  // WS opens, and deliverInbound reads the module singleton.
  const st: BridgeState = {
    bridge,
    http,
    as: new AsService(http),
    comm: new CommService(http),
    orgConfig,
    memberNames: new Map(),
  };
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
      // [SKIP] sentinel: signal non-delivery via an empty messageId result
      // (channel-specific extras belong in meta per OutboundDeliveryResult).
      if (isSkipReply(params.text)) return { channel: "openmax" as const, messageId: "", meta: { skipped: true } };
      const acct = resolveOpenMaxConfig(params.cfg);
      if (!(acct.coreUrl && acct.agentToken && acct.orgId)) throw new Error("openmax: channel not configured");
      // Outbound is stateless REST: use the gateway bridge's stack when we're
      // in that process, else a REST-only stack (CLI `openclaw message send`).
      const sender = state ?? getRestStack(acct);
      const { messageId, chunks } = await sendOutbound(sender, params.to, params.text, {
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
