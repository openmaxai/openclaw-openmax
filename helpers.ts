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

// ─── Reverse-direction policy push (local access → cws-comm reported-policy) ──
// Port of zylos-openmax comm-bridge.js syncConfigToComm payload shaping
// (src/comm-bridge.js:1894-1900). The agent pushes its local DM/group policy to
// cws-comm so the server reflects offline config.json edits / a fresh install's
// pre-populated policy. This is a PURE payload builder; index.ts does the
// PUT /agents/{memberId}/reported-policy. Defaults mirror zylos exactly
// (dmPolicy → 'owner', groupPolicy → 'allowlist', per-group mode → 'mention',
// allowFrom → ['*']).
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
      groupAllowlist.push(convId);
      groups.push({
        conversation_id: convId,
        mode: gcfg.mode || "mention",
        allow_from: gcfg.allowFrom || ["*"],
      });
    }
  }
  return {
    dm_policy: access.dmPolicy || "owner",
    dm_allowlist: access.dmAllowFrom || [],
    group_scope: access.groupPolicy || "allowlist",
    group_allowlist: groupAllowlist,
    groups,
  };
}
