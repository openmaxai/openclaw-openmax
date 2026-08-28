// Pure, dependency-free helpers shared by the plugin and its unit tests.
// Keep this module import-free — it must run under `node --test` without the
// OpenClaw host or the SDK present.

// ─── Inbound context building (aligned with zylos formatInboundForC4) ────────
// The consumer is an LLM reading raw text, not an XML parser: only `<`/`>` are
// neutralized so a sender can't forge a closing tag and break out of a block.
export function escapeXml(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const SMART_MODE_HINT = `<smart-mode>
Decide whether to respond. Do NOT reply if: the message is unrelated to you,
just casual chat, or doesn't need your input. Only reply when:
1) someone asks a question you can help with,
2) discussing technical topics you know well,
3) someone clearly needs assistance.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>`;

export interface ContextBlocks {
  groupContext?: Array<{ senderName: string; content: string }>;
  quoted?: { sender: string; text: string; attachments?: any[] };
  smartHint?: boolean;
}

export function buildInboundBody(text: string, blocks: ContextBlocks): string {
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
export function labelMedia(text: string, msgType: string, attachments: any[]): string {
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

// ─── Policy config events (agent.config.* → access mutation) ──────────────────
// Port of zylos-openmax comm-bridge.js handleConfigUpdate (the six access
// events). The SDK classifies `agent.config.*` frames and hands them to
// callbacks.onConfigEvent; this pure core applies the mutation to an
// OpenMaxAccessConfig object. It is import-free so it runs under `node --test`
// without the OpenClaw host — index.ts persists the result and reuses the SAME
// object the SDK reads for its access gate (decideInbound), so a page/admin edit
// takes effect live with no restart. owner_changed is NOT handled here (it is an
// owner event, not an access field) — index.ts routes it to syncOwnerFromCore.

export interface AccessLike {
  dmPolicy?: "owner" | "open" | "allowlist";
  dmAllowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, { name?: string; allowFrom?: string[]; mode?: "mention" | "smart" | "silent" }>;
}

// Authoritative validation sets (mirror the SDK's access-policy.js VALID_* sets).
const VALID_DM_POLICIES = new Set(["open", "allowlist", "owner"]);
const VALID_GROUP_SCOPES = new Set(["open", "allowlist", "disabled"]);
const VALID_GROUP_MODES = new Set(["smart", "mention", "silent"]);

/** Result of applying an access config event. `applied` is false when the event
 *  was invalid/unknown (caller logs `note` and does NOT persist). `summary` is a
 *  short human string for the applied case. */
export interface ApplyConfigResult {
  applied: boolean;
  summary?: string;
  note?: string;
}

/**
 * Apply one `agent.config.*` access event to `access` IN PLACE. Returns whether
 * a persist-worthy mutation happened. Handles the six access events; returns
 * {applied:false} for owner_changed (routed elsewhere) and unknown events.
 */
export function applyConfigEvent(access: AccessLike, event: string, data: any): ApplyConfigResult {
  switch (event) {
    case "agent.config.dm_policy_changed": {
      const policy = data?.policy;
      if (!VALID_DM_POLICIES.has(policy)) return { applied: false, note: `invalid dm policy "${policy}"` };
      access.dmPolicy = policy;
      return { applied: true, summary: `dmPolicy → ${policy}` };
    }

    case "agent.config.dm_allowlist_changed": {
      const { action, member_ids: memberIds } = data || {};
      if (!Array.isArray(memberIds) || !memberIds.length) {
        return { applied: false, note: "missing or empty member_ids" };
      }
      access.dmAllowFrom = access.dmAllowFrom || [];
      if (action === "add") {
        const existing = new Set(access.dmAllowFrom);
        for (const id of memberIds) if (!existing.has(id)) access.dmAllowFrom.push(id);
      } else if (action === "remove") {
        const toRemove = new Set(memberIds);
        access.dmAllowFrom = access.dmAllowFrom.filter((id) => !toRemove.has(id));
      } else if (action === "set") {
        access.dmAllowFrom = [...memberIds];
      } else {
        return { applied: false, note: `unknown action "${action}"` };
      }
      return { applied: true, summary: `dmAllowFrom ${action} ${memberIds.length} member(s)` };
    }

    case "agent.config.group_mode_changed": {
      const { mode, conversation_id: convId } = data || {};
      if (!VALID_GROUP_MODES.has(mode)) return { applied: false, note: `invalid group mode "${mode}"` };
      if (!convId) return { applied: false, note: "missing conversation_id" };
      access.groups = access.groups || {};
      if (mode === "silent") {
        delete access.groups[convId];
      } else {
        access.groups[convId] = access.groups[convId] || { allowFrom: ["*"] };
        access.groups[convId].mode = mode;
      }
      return { applied: true, summary: `group ${convId} mode → ${mode}` };
    }

    case "agent.config.group_allowfrom_changed": {
      const { allow_from: allowFrom, conversation_id: convId } = data || {};
      if (!convId) return { applied: false, note: "missing conversation_id" };
      if (!Array.isArray(allowFrom)) return { applied: false, note: "allow_from is not an array" };
      access.groups = access.groups || {};
      if (!access.groups[convId]) {
        access.groups[convId] = { mode: "mention", allowFrom: [...allowFrom] };
      } else {
        access.groups[convId].allowFrom = [...allowFrom];
      }
      return { applied: true, summary: `group ${convId} allowFrom → ${JSON.stringify(allowFrom)}` };
    }

    case "agent.config.group_scope_changed": {
      const scope = data?.scope;
      if (!VALID_GROUP_SCOPES.has(scope)) return { applied: false, note: `invalid group scope "${scope}"` };
      access.groupPolicy = scope;
      return { applied: true, summary: `groupPolicy → ${scope}` };
    }

    case "agent.config.group_allowlist_changed": {
      const { action, conversation_ids: convIds } = data || {};
      if (!Array.isArray(convIds)) return { applied: false, note: "conversation_ids is not an array" };
      if (!["add", "remove", "set"].includes(action)) return { applied: false, note: `unknown action "${action}"` };
      access.groups = access.groups || {};
      if (action === "add") {
        for (const id of convIds) {
          if (!access.groups[id]) access.groups[id] = { mode: "mention", allowFrom: ["*"] };
        }
      } else if (action === "remove") {
        for (const id of convIds) delete access.groups[id];
      } else if (action === "set") {
        const old = access.groups;
        access.groups = {};
        for (const id of convIds) access.groups[id] = old[id] || { mode: "mention", allowFrom: ["*"] };
      }
      return { applied: true, summary: `group_allowlist ${action} ${convIds.length} conversation(s)` };
    }

    default:
      // owner_changed and any unknown event: not an access mutation.
      return { applied: false, note: `not an access event: ${event}` };
  }
}

// ─── Reported-policy payload (local access → cws-comm reported-policy) ───────
// Payload shaping for PUT /agents/{memberId}/reported-policy — the body that
// tells cws-comm what this agent's local policy is, so the server reflects a
// fresh install's pre-populated policy. It is only ever sent when the reconcile
// below has established that there is nothing on the server to overwrite; the
// unconditional push it grew out of (zylos-openmax comm-bridge.js
// syncConfigToComm, src/comm-bridge.js:1894-1900) is what erased server state.
//
// Sentinel defaults are copied from the SDK gate so the report describes the
// behavior the agent actually has — verified against decideInbound in
// @openmaxai/openmax-agent-sdk src/protocol/access-policy.js: `dmPolicy ||
// 'owner'`, `dmAllowFrom || []`, `groupPolicy || 'allowlist'`, `mode ||
// 'mention'`, and allowFrom's three-way equivalence (undefined / [] / ['*'] all
// mean everyone). Two of those states have no faithful server encoding and are
// handled below rather than passed through: mode=silent and an empty allowFrom.
export interface ReportedPolicyPayload {
  dm_policy: string;
  dm_allowlist: string[];
  group_scope: string;
  group_allowlist: string[];
  groups: Array<{ conversation_id: string; mode: string; allow_from: string[] }>;
}

export function buildReportedPolicy(access: AccessLike): ReportedPolicyPayload {
  const groups: ReportedPolicyPayload["groups"] = [];
  const groupAllowlist: string[] = [];
  if (access.groups) {
    for (const [convId, gcfg] of Object.entries(access.groups)) {
      // `silent` has no server representation: reported-policy accepts
      // smart|mention only, and one out-of-enum mode rejects the ENTIRE report
      // rather than that one row — every other group's settings would be lost
      // with it. Locally a silenced group means "not participating"
      // (applyConfigEvent deletes the entry on mode=silent, so only a
      // hand-edited config.json leaves one behind), which is exactly what
      // omitting it from both the rows AND the allowlist reports.
      if (gcfg?.mode === "silent") continue;
      groupAllowlist.push(convId);
      groups.push({
        conversation_id: convId,
        mode: gcfg?.mode || "mention",
        // Three local states all mean "anyone in the group may trigger me":
        // undefined, [], and ['*'] — decideInbound only restricts when
        // allowFrom is non-empty and carries no '*'. The server reads an EMPTY
        // allow_from as "nobody may trigger", the exact opposite, so [] has to
        // be normalized here. `allowFrom || ['*']` does NOT do that: an empty
        // array is truthy in JS.
        allow_from: gcfg?.allowFrom && gcfg.allowFrom.length > 0 ? [...gcfg.allowFrom] : ["*"],
      });
    }
  }
  return {
    dm_policy: access.dmPolicy || "owner",
    dm_allowlist: access.dmAllowFrom ? [...access.dmAllowFrom] : [],
    // Always explicit: the server treats an absent group_scope as "open", which
    // is not the SDK's local default ('allowlist').
    group_scope: access.groupPolicy || "allowlist",
    group_allowlist: groupAllowlist,
    groups,
  };
}

// ─── Config-snapshot ownership (the openclaw write path's diff base) ─────────
// OpenClaw's config writer computes `applyMergePatch(sourceSnapshot,
// createMergePatch(runtimeSnapshot, cfg))` — the RUNTIME snapshot is the diff
// base. `resolveOpenMaxConfig(ctx.cfg).access` is a live reference INTO that
// snapshot, so mutating it in place also moves the diff base: the patch comes
// out empty and the write silently persists nothing (observed: identical byte
// count before/after, only `meta.lastTouchedAt` changed, and the new group gone
// after a restart). The plugin therefore owns its own copy of the access record
// from the moment it builds the org config.

/** Deep-copy the account's access record so later in-place mutations
 *  (applyConfigEvent) cannot reach openclaw's runtime config snapshot. */
export function buildAccessSnapshot(access?: AccessLike | null): AccessLike {
  return structuredClone(access || {});
}

/** Shape the object handed to openclaw's `writeConfigFile`: a deep copy of the
 *  loaded config with `channels.openmax.access` replaced by a deep copy of
 *  `access`. Copying both sides keeps the caller's snapshot usable as a diff
 *  base and keeps the written object independent of later live mutations. */
export function configWithAccess(loadedConfig: any, access: AccessLike): any {
  const cfg = structuredClone(loadedConfig ?? {});
  const openmax = ((cfg.channels ||= {}).openmax ||= {});
  openmax.access = structuredClone(access);
  return cfg;
}

// ─── Pull-first policy reconcile (replaces the unconditional periodic push) ──
// The push-only design had one failure mode with no recovery path: cws-comm's
// agent-config relay drops config events for an OFFLINE agent and never replays
// them (internal/transport/ws/agent_config_relay.go — an offline connection
// "simply receives nothing"), so owner edits made while the agent is down are
// lost locally. The next unconditional full PUT then overwrote the server's
// real values with the agent's stale ones — that is how a populated
// group_allowlist became null and its per-group rows were deleted.
//
// The fix is to read before writing, and to give the server the last word when
// it has one. `decideReconcile` is the whole decision, kept pure and total so
// each branch is testable; `reconcileAgentPolicy` sequences the I/O through
// injected callbacks. There is deliberately NO path from a failed read to a
// PUT: if we cannot see the server's state we cannot know what we would erase.

/** cws-core GET /agents/{memberId}/policy response (the BFF sends updated_at as
 *  unix seconds; cws-comm's own HTTP surface sends RFC3339 — both accepted). */
export interface ServerPolicySnapshot {
  dm_policy?: string;
  dm_allowlist?: string[] | null;
  group_scope?: string;
  group_allowlist?: string[] | null;
  groups?: Array<{ conversation_id?: string; mode?: string; allow_from?: string[] | null }> | null;
  updated_at?: number | string | null;
}

/** What the last completed reconcile saw. `serverUpdatedAt` 0 means "never read
 *  a stored policy" (fresh process, or the server has no policy row). In-memory
 *  by design: after a restart the marker is empty, so the first reconcile treats
 *  the server as authoritative and heals local state from it. */
export interface ReconcileMarker {
  serverUpdatedAt: number;
  localFingerprint: string;
}

export const EMPTY_RECONCILE_MARKER: ReconcileMarker = Object.freeze({ serverUpdatedAt: 0, localFingerprint: "" });

export interface ReconcileDecision {
  action: "seed" | "adopt" | "push" | "noop";
  reason: string;
  /** Marker to store once the action has been carried out successfully. */
  marker: ReconcileMarker;
  /** seed | push — the exact body to PUT. */
  payload?: ReportedPolicyPayload;
  /** adopt — the access record to install live and persist. */
  access?: AccessLike;
}

/** Normalize `updated_at` to a comparable number of seconds. Only equality
 *  against the marker matters, so the unit just has to be stable. */
export function normalizeUpdatedAt(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}

/** Project a server snapshot onto the local access shape the SDK gate reads.
 *  `localAccess` only contributes the cosmetic per-group `name` (the server
 *  does not carry it) and a fallback for an unreadable dm_policy/group_scope. */
export function serverPolicyToAccess(server: ServerPolicySnapshot, localAccess: AccessLike = {}): AccessLike {
  const dmPolicy = VALID_DM_POLICIES.has(String(server.dm_policy))
    ? (server.dm_policy as AccessLike["dmPolicy"])
    : localAccess.dmPolicy;
  const groupPolicy = VALID_GROUP_SCOPES.has(String(server.group_scope))
    ? (server.group_scope as AccessLike["groupPolicy"])
    : localAccess.groupPolicy;

  const rows = Array.isArray(server.groups) ? server.groups : [];
  const rowById = new Map<string, { mode?: string; allow_from?: string[] | null }>();
  for (const row of rows) {
    const id = row?.conversation_id ? String(row.conversation_id) : "";
    if (id) rowById.set(id, row);
  }
  const allowlist = (Array.isArray(server.group_allowlist) ? server.group_allowlist : [])
    .map((id) => String(id || ""))
    .filter(Boolean);

  // Which conversations count as "configured" locally — presence in
  // access.groups is what decideInbound's allowlist gate reads.
  //
  // Under group_scope=allowlist the server's group_allowlist is the
  // authoritative membership list and per-group ROWS can outlive it: cws-comm's
  // UpdateGroupAllowlist("remove") drops the id from the allowlist without
  // deleting the row (internal/app/agent_policy_service.go), so unioning the
  // two surfaces would resurrect a group the owner had just removed. Under
  // open/disabled the allowlist is not a gate, so keep both surfaces to
  // preserve per-group modes.
  const ids = groupPolicy === "allowlist" ? allowlist : [...new Set([...allowlist, ...rowById.keys()])];

  const groups: NonNullable<AccessLike["groups"]> = {};
  for (const id of ids) {
    const row = rowById.get(id);
    const allowFrom = Array.isArray(row?.allow_from) && row!.allow_from!.length > 0
      ? row!.allow_from!.map((m) => String(m))
      : ["*"];
    // The server can only store smart|mention; anything else is a wire
    // surprise and 'mention' is the conservative reading (respond when @-ed).
    const mode: "smart" | "mention" = row?.mode === "smart" ? "smart" : "mention";
    const name = localAccess.groups?.[id]?.name;
    groups[id] = { ...(name ? { name } : {}), mode, allowFrom };
  }

  // A local mode=silent entry is deliberately absent from every report (see
  // buildReportedPolicy), so the server can never be authoritative about it —
  // adopting a server policy must not be what deletes it. Carry over the local
  // silent entries the server does not mention.
  for (const [id, gcfg] of Object.entries(localAccess.groups || {})) {
    if (gcfg?.mode === "silent" && !groups[id]) groups[id] = { ...gcfg };
  }

  return {
    ...(dmPolicy ? { dmPolicy } : {}),
    dmAllowFrom: (Array.isArray(server.dm_allowlist) ? server.dm_allowlist : []).map((m) => String(m)),
    ...(groupPolicy ? { groupPolicy } : {}),
    groups,
  };
}

/** Order-insensitive digest of everything a report would carry. Comparing
 *  digests of the reported PROJECTION (not the raw record) is what keeps a
 *  cosmetic-only local edit from triggering a pointless PUT. */
export function policyFingerprint(access: AccessLike): string {
  const p = buildReportedPolicy(access);
  return JSON.stringify({
    dm_policy: p.dm_policy,
    dm_allowlist: [...p.dm_allowlist].sort(),
    group_scope: p.group_scope,
    group_allowlist: [...p.group_allowlist].sort(),
    groups: p.groups
      .map((g) => ({ conversation_id: g.conversation_id, mode: g.mode, allow_from: [...g.allow_from].sort() }))
      .sort((a, b) => (a.conversation_id < b.conversation_id ? -1 : a.conversation_id > b.conversation_id ? 1 : 0)),
  });
}

/**
 * Decide what one reconcile round should do. Total function, no I/O.
 *
 * The ordering is what makes erasure impossible: a stored server policy that we
 * have not seen before always wins, and a local push is only ever considered
 * once we have confirmed the server has not moved since our last look.
 */
export function decideReconcile(
  localAccess: AccessLike,
  server: ServerPolicySnapshot,
  marker: ReconcileMarker = EMPTY_RECONCILE_MARKER,
): ReconcileDecision {
  const localFingerprint = policyFingerprint(localAccess);
  const serverUpdatedAt = normalizeUpdatedAt(server?.updated_at);
  const rowCount = Array.isArray(server?.groups) ? server.groups.length : 0;
  const allowlistCount = Array.isArray(server?.group_allowlist) ? server.group_allowlist.length : 0;

  if (serverUpdatedAt <= 0) {
    // No stored policy row. GetFullPolicy still answers with synthesized
    // defaults (dm_policy=owner, group_scope=open), so what the settings page
    // shows here is a placeholder, not an owner decision — there is nothing to
    // erase and seeding our local policy is the useful move.
    if (rowCount === 0 && allowlistCount === 0) {
      return {
        action: "seed",
        reason: "server has no stored policy (updated_at=0, no groups) — seeding local policy",
        marker: { serverUpdatedAt, localFingerprint },
        payload: buildReportedPolicy(localAccess),
      };
    }
    // Group rows without a policy row: someone configured groups server-side.
    // Not ours to overwrite on a guess.
    return {
      action: "noop",
      reason: `server has no policy row but carries ${allowlistCount} allowlist / ${rowCount} group row(s) — not seeding over it`,
      marker: { serverUpdatedAt, localFingerprint },
    };
  }

  if (serverUpdatedAt !== marker.serverUpdatedAt) {
    const serverAccess = serverPolicyToAccess(server, localAccess);
    const serverFingerprint = policyFingerprint(serverAccess);
    if (serverFingerprint === localFingerprint) {
      // Same content — e.g. the bump our own previous push caused. Advance the
      // marker without touching disk.
      return {
        action: "noop",
        reason: `server policy changed (updated_at=${serverUpdatedAt}) but matches local — marker only`,
        marker: { serverUpdatedAt, localFingerprint },
      };
    }
    return {
      action: "adopt",
      reason: `server policy is newer (updated_at=${serverUpdatedAt} != seen ${marker.serverUpdatedAt}) — adopting it`,
      marker: { serverUpdatedAt, localFingerprint: serverFingerprint },
      access: serverAccess,
    };
  }

  if (localFingerprint !== marker.localFingerprint) {
    return {
      action: "push",
      reason: "server unchanged since last look, local policy changed — reporting it",
      marker: { serverUpdatedAt, localFingerprint },
      payload: buildReportedPolicy(localAccess),
    };
  }

  return { action: "noop", reason: "already in sync", marker: { serverUpdatedAt, localFingerprint } };
}

/** Every conversation id a report mentions (allowlist + per-group rows). */
function reportedConversationIds(payload: ReportedPolicyPayload): string[] {
  return [...new Set([...payload.group_allowlist, ...payload.groups.map((g) => g.conversation_id)])].filter(Boolean);
}

/** Find the conversation a rejection blames, by looking for any id we reported
 *  in the server's error text. cws-comm wraps these as "group <id>: ..." and
 *  the BFF passes the downstream message through as `detail`, so a group-scoped
 *  rejection names the group while a routing 404 does not. */
export function findReportedGroupInDetail(payload: ReportedPolicyPayload, detail: string): string | undefined {
  if (!detail) return undefined;
  return reportedConversationIds(payload).find((id) => detail.includes(id));
}

/** Copy of the report with one conversation removed from both surfaces. */
export function dropGroupFromReport(payload: ReportedPolicyPayload, conversationId: string): ReportedPolicyPayload {
  return {
    ...payload,
    group_allowlist: payload.group_allowlist.filter((id) => id !== conversationId),
    groups: payload.groups.filter((g) => g.conversation_id !== conversationId),
  };
}

export interface ReconcileDeps {
  /** The live access record the SDK gate reads. */
  localAccess: AccessLike;
  marker: ReconcileMarker;
  /** GET /agents/{memberId}/policy. Throwing (or answering with a non-object)
   *  aborts the round — it must never fall through to a PUT. */
  getServerPolicy: () => Promise<ServerPolicySnapshot | null | undefined>;
  /** PUT /agents/{memberId}/reported-policy. Rejections should carry `status`
   *  (HTTP code) and, where available, `body` — both feed the 4xx triage. */
  putReportedPolicy: (payload: ReportedPolicyPayload) => Promise<unknown>;
  /** Install an adopted server policy: live for the gate, and durably. */
  adoptAccess: (access: AccessLike) => Promise<void> | void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ReconcileOutcome {
  action: "seed" | "adopt" | "push" | "noop" | "skipped" | "failed";
  reason: string;
  /** Marker to keep. Unchanged from the input when the round failed, so the
   *  next cycle retries instead of believing it succeeded. */
  marker: ReconcileMarker;
  /** How many PUTs were actually issued (0 whenever the read failed). */
  puts: number;
}

function errorText(err: any): string {
  const parts = [err?.message ? String(err.message) : ""];
  const body = err?.body;
  if (typeof body === "string") parts.push(body);
  else if (body) {
    try {
      parts.push(JSON.stringify(body));
    } catch {
      /* unserializable body: the message is enough */
    }
  }
  return parts.filter(Boolean).join(" | ");
}

/** One reconcile round: read the server, decide, then act. Never throws. */
export async function reconcileAgentPolicy(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const log = deps.log || (() => {});
  const warn = deps.warn || (() => {});

  let server: ServerPolicySnapshot | null | undefined;
  try {
    server = await deps.getServerPolicy();
  } catch (err: any) {
    // Deliberate dead end. A push from here is what erased the server's
    // allowlist: unreadable server state means unknown blast radius.
    warn(`policy reconcile: reading server policy failed (${errorText(err)}) — not reporting this round`);
    return { action: "skipped", reason: "server read failed", marker: deps.marker, puts: 0 };
  }
  if (!server || typeof server !== "object") {
    warn("policy reconcile: server policy response was not an object — not reporting this round");
    return { action: "skipped", reason: "unreadable server response", marker: deps.marker, puts: 0 };
  }

  const decision = decideReconcile(deps.localAccess, server, deps.marker);

  if (decision.action === "noop") {
    log(`policy reconcile: ${decision.reason}`);
    return { action: "noop", reason: decision.reason, marker: decision.marker, puts: 0 };
  }

  if (decision.action === "adopt") {
    try {
      await deps.adoptAccess(decision.access!);
    } catch (err: any) {
      warn(`policy reconcile: adopting server policy failed (${errorText(err)})`);
      return { action: "failed", reason: "adopt failed", marker: deps.marker, puts: 0 };
    }
    log(`policy reconcile: ${decision.reason}`);
    return { action: "adopt", reason: decision.reason, marker: decision.marker, puts: 0 };
  }

  // seed | push
  let payload = decision.payload!;
  let puts = 0;
  for (let round = 0; round < 2; round++) {
    puts++;
    try {
      await deps.putReportedPolicy(payload);
      log(
        `policy reported (${decision.action}): dmPolicy=${payload.dm_policy}, groupScope=${payload.group_scope}, groups=${payload.groups.length}`,
      );
      return { action: decision.action, reason: decision.reason, marker: decision.marker, puts };
    } catch (err: any) {
      const status = Number(err?.status) || 0;
      const detail = errorText(err);
      const blamed = status >= 400 && status < 500 ? findReportedGroupInDetail(payload, detail) : undefined;
      if (blamed && round === 0) {
        // The server names a conversation it will not accept — most often the
        // agent has been removed from that group, which cws-comm reports as a
        // 404 from verifyAgentGroupMember. Drop that one group and report the
        // rest, so one stale membership cannot block the whole policy.
        warn(`policy report rejected (${status}) over group ${blamed}: ${detail} — dropping it and retrying once`);
        payload = dropGroupFromReport(payload, blamed);
        continue;
      }
      if (blamed) {
        // Named a group again on the retry. One drop per round is the cap —
        // looping here could strip the whole allowlist one group at a time.
        warn(`policy report rejected (${status}) over group ${blamed} again: ${detail} — giving up this round`);
      } else if (status === 404) {
        // NOT "endpoint unavailable": the GET above succeeded, and cws-core
        // registers GET .../policy and PUT .../reported-policy together, so the
        // route exists. Treating every 404 as a missing endpoint is what made
        // this failure silent.
        warn(`policy report got 404 naming no group we reported (${detail}) — server policy stays stale, retrying next cycle`);
      } else {
        warn(`policy report failed (status=${status || "none"}): ${detail}`);
      }
      return { action: "failed", reason: `report failed with status ${status || "none"}`, marker: deps.marker, puts };
    }
  }
  // Unreachable: the loop either returns or breaks out via the failure path.
  return { action: "failed", reason: "report retry exhausted", marker: deps.marker, puts };
}
