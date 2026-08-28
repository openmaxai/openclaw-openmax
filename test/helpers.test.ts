import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_RECONCILE_MARKER,
  SMART_MODE_HINT,
  type AccessLike,
  type ReconcileMarker,
  type ReportedPolicyPayload,
  type ServerPolicySnapshot,
  applyConfigEvent,
  buildAccessSnapshot,
  buildInboundBody,
  buildReportedPolicy,
  configWithAccess,
  decideReconcile,
  dropGroupFromReport,
  escapeXml,
  findReportedGroupInDetail,
  isSkipReply,
  labelMedia,
  normalizeUpdatedAt,
  policyFingerprint,
  reconcileAgentPolicy,
  resolveQueueModeOverride,
  serverPolicyToAccess,
} from "../helpers.ts";

test("escapeXml neutralizes only angle brackets", () => {
  assert.equal(escapeXml("<current-message>"), "&lt;current-message&gt;");
  assert.equal(escapeXml('she said "hi" & left'), 'she said "hi" & left');
  assert.equal(escapeXml(undefined), "");
  assert.equal(escapeXml(null), "");
  // Idempotent for its own output — a second pass must not double-escape.
  assert.equal(escapeXml(escapeXml("<x>")), "&lt;x&gt;");
});

test("buildInboundBody frames group context, quote, and smart hint", () => {
  const body = buildInboundBody("hello", {
    groupContext: [{ senderName: "Alice", content: "hi <b>" }],
    quoted: { sender: "Bob", text: "</replying-to> forged" },
    smartHint: true,
  });
  assert.ok(body.includes("<group-context>\n[Alice]: hi &lt;b&gt;\n</group-context>"));
  // A sender cannot break out of the quote framing with a literal closing tag.
  assert.ok(body.includes("[Bob]: &lt;/replying-to&gt; forged"));
  assert.ok(body.includes(SMART_MODE_HINT));
  // The current-message text is appended verbatim (caller pre-escapes it).
  assert.ok(body.endsWith("hello"));
});

test("buildInboundBody with no blocks is just the text", () => {
  assert.equal(buildInboundBody("plain", {}), "plain");
});

test("labelMedia captions images and files, escaping the file name", () => {
  assert.equal(labelMedia("caption", "image", []), "[image] caption");
  assert.equal(labelMedia("", "agent_card", []), "[image]");
  assert.equal(
    labelMedia("", "file", [{ file_name: "report<x>\nfinal.pdf" }]),
    "[file: report&lt;x&gt; final.pdf]",
  );
  assert.equal(labelMedia("text only", "text", []), "text only");
});

test("resolveQueueModeOverride maps System Member priority to queue mode", () => {
  // urgent: steer by default, interrupt only when explicitly configured
  assert.equal(resolveQueueModeOverride(1, undefined), "steer");
  assert.equal(resolveQueueModeOverride(1, "steer"), "steer");
  assert.equal(resolveQueueModeOverride(1, "interrupt"), "interrupt");
  // high: always steer
  assert.equal(resolveQueueModeOverride(2, "interrupt"), "steer");
  // normal / absent: respect the operator-configured mode (no override)
  assert.equal(resolveQueueModeOverride(3, "interrupt"), undefined);
  assert.equal(resolveQueueModeOverride(undefined, "interrupt"), undefined);
});

test("isSkipReply matches the [SKIP] sentinel only", () => {
  assert.equal(isSkipReply("[SKIP]"), true);
  assert.equal(isSkipReply("  [SKIP]\n"), true);
  assert.equal(isSkipReply("[SKIP] but also text"), false);
  assert.equal(isSkipReply("skip"), false);
});

// ─── applyConfigEvent (agent.config.* → access mutation) ─────────────────────
test("dm_policy_changed sets dmPolicy; invalid policy is rejected", () => {
  const a: AccessLike = {};
  assert.equal(applyConfigEvent(a, "agent.config.dm_policy_changed", { policy: "open" }).applied, true);
  assert.equal(a.dmPolicy, "open");
  const bad = applyConfigEvent(a, "agent.config.dm_policy_changed", { policy: "nonsense" });
  assert.equal(bad.applied, false);
  assert.equal(a.dmPolicy, "open"); // unchanged
});

test("dm_allowlist_changed add/remove/set mutate dmAllowFrom", () => {
  const a: AccessLike = {};
  applyConfigEvent(a, "agent.config.dm_allowlist_changed", { action: "add", member_ids: ["u1", "u2"] });
  assert.deepEqual(a.dmAllowFrom, ["u1", "u2"]);
  // add is idempotent (no duplicates)
  applyConfigEvent(a, "agent.config.dm_allowlist_changed", { action: "add", member_ids: ["u2", "u3"] });
  assert.deepEqual(a.dmAllowFrom, ["u1", "u2", "u3"]);
  applyConfigEvent(a, "agent.config.dm_allowlist_changed", { action: "remove", member_ids: ["u1"] });
  assert.deepEqual(a.dmAllowFrom, ["u2", "u3"]);
  applyConfigEvent(a, "agent.config.dm_allowlist_changed", { action: "set", member_ids: ["z"] });
  assert.deepEqual(a.dmAllowFrom, ["z"]);
  assert.equal(applyConfigEvent(a, "agent.config.dm_allowlist_changed", { action: "add", member_ids: [] }).applied, false);
});

test("group_mode_changed sets mode; silent removes the group entry", () => {
  const a: AccessLike = {};
  applyConfigEvent(a, "agent.config.group_mode_changed", { conversation_id: "g1", mode: "smart" });
  assert.equal(a.groups?.g1.mode, "smart");
  assert.deepEqual(a.groups?.g1.allowFrom, ["*"]);
  applyConfigEvent(a, "agent.config.group_mode_changed", { conversation_id: "g1", mode: "silent" });
  assert.equal(a.groups?.g1, undefined);
  assert.equal(applyConfigEvent(a, "agent.config.group_mode_changed", { mode: "mention" }).applied, false);
});

test("group_allowfrom_changed replaces the per-group allowFrom", () => {
  const a: AccessLike = { groups: { g1: { mode: "smart", allowFrom: ["*"] } } };
  applyConfigEvent(a, "agent.config.group_allowfrom_changed", { conversation_id: "g1", allow_from: ["u1"] });
  assert.deepEqual(a.groups?.g1.allowFrom, ["u1"]);
  assert.equal(a.groups?.g1.mode, "smart"); // mode preserved
  // creates a defaulted entry for an unknown group
  applyConfigEvent(a, "agent.config.group_allowfrom_changed", { conversation_id: "g2", allow_from: ["x"] });
  assert.equal(a.groups?.g2.mode, "mention");
});

test("group_scope_changed sets groupPolicy; invalid scope rejected", () => {
  const a: AccessLike = {};
  assert.equal(applyConfigEvent(a, "agent.config.group_scope_changed", { scope: "disabled" }).applied, true);
  assert.equal(a.groupPolicy, "disabled");
  assert.equal(applyConfigEvent(a, "agent.config.group_scope_changed", { scope: "bogus" }).applied, false);
});

test("group_allowlist_changed add/remove/set manage the groups map", () => {
  const a: AccessLike = {};
  applyConfigEvent(a, "agent.config.group_allowlist_changed", { action: "add", conversation_ids: ["g1", "g2"] });
  assert.deepEqual(Object.keys(a.groups || {}).sort(), ["g1", "g2"]);
  applyConfigEvent(a, "agent.config.group_allowlist_changed", { action: "remove", conversation_ids: ["g1"] });
  assert.deepEqual(Object.keys(a.groups || {}), ["g2"]);
  // set keeps existing config for retained ids, drops the rest
  a.groups!.g2.mode = "smart";
  applyConfigEvent(a, "agent.config.group_allowlist_changed", { action: "set", conversation_ids: ["g2", "g3"] });
  assert.equal(a.groups?.g2.mode, "smart");
  assert.equal(a.groups?.g3.mode, "mention");
});

test("owner_changed and unknown events are not access mutations", () => {
  const a: AccessLike = { dmPolicy: "owner" };
  assert.equal(applyConfigEvent(a, "agent.config.owner_changed", {}).applied, false);
  assert.equal(applyConfigEvent(a, "agent.config.some_future_event", {}).applied, false);
  assert.deepEqual(a, { dmPolicy: "owner" }); // untouched
});

// ─── buildReportedPolicy (reverse push payload) ──────────────────────────────
test("buildReportedPolicy applies zylos defaults for an empty access", () => {
  assert.deepEqual(buildReportedPolicy({}), {
    dm_policy: "owner",
    dm_allowlist: [],
    group_scope: "allowlist",
    group_allowlist: [],
    groups: [],
  });
});

test("buildReportedPolicy maps groups to conversation_id/mode/allow_from", () => {
  const p = buildReportedPolicy({
    dmPolicy: "allowlist",
    dmAllowFrom: ["u1"],
    groupPolicy: "open",
    groups: {
      g1: { mode: "smart", allowFrom: ["a", "b"] },
      g2: {}, // defaults: mode 'mention', allow_from ['*']
    },
  });
  assert.equal(p.dm_policy, "allowlist");
  assert.deepEqual(p.dm_allowlist, ["u1"]);
  assert.equal(p.group_scope, "open");
  assert.deepEqual(p.group_allowlist.sort(), ["g1", "g2"]);
  const g1 = p.groups.find((g) => g.conversation_id === "g1");
  const g2 = p.groups.find((g) => g.conversation_id === "g2");
  assert.deepEqual(g1, { conversation_id: "g1", mode: "smart", allow_from: ["a", "b"] });
  assert.deepEqual(g2, { conversation_id: "g2", mode: "mention", allow_from: ["*"] });
});

// ─── Config-snapshot ownership (regression guard) ────────────────────────────
// The bug this pins: buildOrgConfig used to store openclaw's live
// `channels.openmax.access` reference, so applyConfigEvent mutated the very
// snapshot the config writer diffs against. Live delivery worked, the write was
// a no-op, and the new group was gone after a restart. Reverting the copy inside
// buildAccessSnapshot must turn this test red.
test("a policy event never mutates openclaw's config snapshot, and the persisted config carries the change", () => {
  // Shape of openclaw's runtime config snapshot; channels.openmax.access is
  // what resolveOpenMaxConfig(ctx.cfg) hands the plugin.
  const runtimeSnapshot: any = {
    meta: { lastTouchedAt: "2026-08-27T12:00:00.000Z" },
    channels: { openmax: { orgId: "org-1", access: { groupPolicy: "allowlist", groups: {} } } },
  };
  const acctAccess = runtimeSnapshot.channels.openmax.access;

  // What buildOrgConfig() stores as orgConfig.access.
  const orgAccess = buildAccessSnapshot(acctAccess);

  const res = applyConfigEvent(orgAccess, "agent.config.group_allowlist_changed", {
    action: "add",
    conversation_ids: ["g-new"],
  });
  assert.equal(res.applied, true);
  assert.deepEqual(Object.keys(orgAccess.groups || {}), ["g-new"]); // live effect for decideInbound

  // 1. The write path's diff base is untouched — this is what made the merge
  //    patch empty and the persist a silent no-op.
  assert.deepEqual(acctAccess, { groupPolicy: "allowlist", groups: {} });
  assert.deepEqual(runtimeSnapshot.channels.openmax.access, { groupPolicy: "allowlist", groups: {} });
  assert.notEqual(orgAccess, acctAccess); // a copy, not the live reference

  // 2. What we hand writeConfigFile() carries the new group, and differs from
  //    the snapshot — i.e. the diff against it cannot come out empty.
  const written = configWithAccess(runtimeSnapshot, orgAccess);
  assert.deepEqual(Object.keys(written.channels.openmax.access.groups), ["g-new"]);
  assert.notDeepEqual(written.channels.openmax.access, runtimeSnapshot.channels.openmax.access);
  // Unrelated config is preserved, and neither side shares structure with it.
  assert.equal(written.channels.openmax.orgId, "org-1");
  assert.equal(written.meta.lastTouchedAt, "2026-08-27T12:00:00.000Z");
  assert.notEqual(written, runtimeSnapshot);
  assert.notEqual(written.channels.openmax.access, orgAccess);

  // 3. A later live mutation cannot reach the object already handed to the writer.
  applyConfigEvent(orgAccess, "agent.config.group_allowlist_changed", {
    action: "add",
    conversation_ids: ["g-later"],
  });
  assert.deepEqual(Object.keys(written.channels.openmax.access.groups), ["g-new"]);
});

// ─── buildReportedPolicy: states the server cannot represent ─────────────────
test("buildReportedPolicy drops silent groups from both the rows and the allowlist", () => {
  const p = buildReportedPolicy({
    groups: {
      g1: { mode: "mention", allowFrom: ["*"] },
      quiet: { mode: "silent", allowFrom: ["*"] },
      g2: { mode: "smart" },
    },
  });
  // reported-policy accepts smart|mention only, and one bad mode rejects the
  // WHOLE report — so a silent group must not reach the wire at all.
  assert.deepEqual(p.group_allowlist.sort(), ["g1", "g2"]);
  assert.deepEqual(
    p.groups.map((g) => g.conversation_id).sort(),
    ["g1", "g2"],
  );
  assert.equal(p.groups.some((g) => g.mode === "silent"), false);
});

test("buildReportedPolicy normalizes an empty allowFrom to ['*']", () => {
  // Local: undefined / [] / ['*'] all mean "anyone may trigger me".
  // Server: an empty allow_from means "nobody" — the opposite.
  const p = buildReportedPolicy({
    groups: { empty: { allowFrom: [] }, absent: {}, star: { allowFrom: ["*"] }, named: { allowFrom: ["u1"] } },
  });
  const byId = Object.fromEntries(p.groups.map((g) => [g.conversation_id, g.allow_from]));
  assert.deepEqual(byId.empty, ["*"]);
  assert.deepEqual(byId.absent, ["*"]);
  assert.deepEqual(byId.star, ["*"]);
  assert.deepEqual(byId.named, ["u1"]);
});

test("buildReportedPolicy copies arrays instead of aliasing the access record", () => {
  const access: AccessLike = { dmAllowFrom: ["u1"], groups: { g1: { allowFrom: ["u2"] } } };
  const p = buildReportedPolicy(access);
  p.dm_allowlist.push("intruder");
  p.groups[0].allow_from.push("intruder");
  assert.deepEqual(access.dmAllowFrom, ["u1"]);
  assert.deepEqual(access.groups!.g1.allowFrom, ["u2"]);
});

// ─── updated_at normalization + fingerprint ─────────────────────────────────
test("normalizeUpdatedAt accepts unix seconds, numeric strings and RFC3339", () => {
  assert.equal(normalizeUpdatedAt(undefined), 0);
  assert.equal(normalizeUpdatedAt(null), 0);
  assert.equal(normalizeUpdatedAt(0), 0);
  assert.equal(normalizeUpdatedAt(""), 0);
  assert.equal(normalizeUpdatedAt(1756300000), 1756300000);
  assert.equal(normalizeUpdatedAt("1756300000"), 1756300000);
  assert.equal(normalizeUpdatedAt("2026-08-27T12:00:00Z"), Math.floor(Date.parse("2026-08-27T12:00:00Z") / 1000));
  assert.equal(normalizeUpdatedAt("not a date"), 0);
});

test("policyFingerprint ignores ordering and cosmetic fields", () => {
  const a: AccessLike = {
    dmPolicy: "allowlist",
    dmAllowFrom: ["u2", "u1"],
    groups: { g2: { mode: "smart", allowFrom: ["b", "a"] }, g1: { name: "Team", mode: "mention" } },
  };
  const b: AccessLike = {
    dmPolicy: "allowlist",
    dmAllowFrom: ["u1", "u2"],
    groups: { g1: { mode: "mention" }, g2: { mode: "smart", allowFrom: ["a", "b"] } },
  };
  assert.equal(policyFingerprint(a), policyFingerprint(b));
  // a real difference still shows up
  assert.notEqual(policyFingerprint(a), policyFingerprint({ ...a, dmPolicy: "open" }));
});

// ─── serverPolicyToAccess ───────────────────────────────────────────────────
test("serverPolicyToAccess maps the snapshot onto the SDK access shape", () => {
  const access = serverPolicyToAccess({
    dm_policy: "allowlist",
    dm_allowlist: ["u1"],
    group_scope: "allowlist",
    group_allowlist: ["g1", "g2"],
    groups: [
      { conversation_id: "g1", mode: "smart", allow_from: ["u9"] },
      { conversation_id: "g2", mode: "mention", allow_from: [] },
    ],
    updated_at: 1756300000,
  });
  assert.equal(access.dmPolicy, "allowlist");
  assert.deepEqual(access.dmAllowFrom, ["u1"]);
  assert.equal(access.groupPolicy, "allowlist");
  assert.deepEqual(access.groups!.g1, { mode: "smart", allowFrom: ["u9"] });
  // empty allow_from on the wire is the server's "everyone" default round-trip
  assert.deepEqual(access.groups!.g2, { mode: "mention", allowFrom: ["*"] });
});

test("serverPolicyToAccess ignores orphan group rows under scope=allowlist", () => {
  // cws-comm's UpdateGroupAllowlist("remove") drops the id from the allowlist
  // but leaves the per-group row behind, so a union would resurrect a group the
  // owner just removed.
  const server: ServerPolicySnapshot = {
    group_scope: "allowlist",
    group_allowlist: ["g1"],
    groups: [
      { conversation_id: "g1", mode: "mention" },
      { conversation_id: "orphan", mode: "smart" },
    ],
    updated_at: 5,
  };
  assert.deepEqual(Object.keys(serverPolicyToAccess(server).groups!), ["g1"]);
  // under scope=open the allowlist is not a gate, so per-group modes are kept
  const open = serverPolicyToAccess({ ...server, group_scope: "open" });
  assert.deepEqual(Object.keys(open.groups!).sort(), ["g1", "orphan"]);
});

test("serverPolicyToAccess keeps the local group name and falls back on an unreadable policy", () => {
  const local: AccessLike = { dmPolicy: "open", groupPolicy: "open", groups: { g1: { name: "Design", mode: "smart" } } };
  const access = serverPolicyToAccess(
    { dm_policy: "bogus", group_scope: "nonsense", group_allowlist: ["g1"], groups: [], updated_at: 5 },
    local,
  );
  assert.equal(access.groups!.g1.name, "Design");
  assert.equal(access.dmPolicy, "open"); // local fallback, not "bogus"
  assert.equal(access.groupPolicy, "open");
});

// ─── decideReconcile ────────────────────────────────────────────────────────
const EMPTY_SERVER: ServerPolicySnapshot = { dm_policy: "owner", group_scope: "open", group_allowlist: [], groups: [] };

test("decideReconcile seeds when the server has no stored policy", () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: { mode: "mention", allowFrom: ["*"] } } };
  const d = decideReconcile(local, { ...EMPTY_SERVER, updated_at: 0 }, EMPTY_RECONCILE_MARKER);
  assert.equal(d.action, "seed");
  assert.deepEqual(d.payload, {
    dm_policy: "owner",
    dm_allowlist: [],
    group_scope: "allowlist",
    group_allowlist: ["g1"],
    groups: [{ conversation_id: "g1", mode: "mention", allow_from: ["*"] }],
  });
});

test("decideReconcile does not seed over server-side group rows", () => {
  const d = decideReconcile(
    { groups: { g1: {} } },
    { ...EMPTY_SERVER, updated_at: 0, group_allowlist: ["gX"] },
    EMPTY_RECONCILE_MARKER,
  );
  assert.equal(d.action, "noop");
  assert.match(d.reason, /no policy row but carries/);
});

test("decideReconcile adopts a server policy it has not seen before", () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: {} };
  const d = decideReconcile(
    local,
    {
      dm_policy: "owner",
      dm_allowlist: [],
      group_scope: "allowlist",
      group_allowlist: ["g-owner-added"],
      groups: [{ conversation_id: "g-owner-added", mode: "mention", allow_from: ["*"] }],
      updated_at: 1756300000,
    },
    // marker from a previous round that saw an older policy
    { serverUpdatedAt: 1756200000, localFingerprint: policyFingerprint(local) },
  );
  assert.equal(d.action, "adopt");
  assert.deepEqual(Object.keys(d.access!.groups!), ["g-owner-added"]);
  assert.equal(d.marker.serverUpdatedAt, 1756300000);
  assert.equal(d.marker.localFingerprint, policyFingerprint(d.access!));
});

test("decideReconcile pushes only when the server is unchanged and local moved", () => {
  const server: ServerPolicySnapshot = { ...EMPTY_SERVER, group_scope: "allowlist", updated_at: 900 };
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: { mode: "mention", allowFrom: ["*"] } } };
  // seen this server state, but local has since changed
  const marker: ReconcileMarker = { serverUpdatedAt: 900, localFingerprint: policyFingerprint({ groupPolicy: "allowlist" }) };
  const d = decideReconcile(local, server, marker);
  assert.equal(d.action, "push");
  assert.deepEqual(d.payload!.group_allowlist, ["g1"]);
});

test("decideReconcile is a noop in steady state, and advances the marker after our own push", () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: { mode: "mention", allowFrom: ["*"] } } };
  const fp = policyFingerprint(local);
  const server: ServerPolicySnapshot = {
    dm_policy: "owner",
    dm_allowlist: [],
    group_scope: "allowlist",
    group_allowlist: ["g1"],
    groups: [{ conversation_id: "g1", mode: "mention", allow_from: ["*"] }],
    updated_at: 900,
  };
  assert.equal(decideReconcile(local, server, { serverUpdatedAt: 900, localFingerprint: fp }).action, "noop");
  // A push bumps updated_at server-side; the next round sees a "change" whose
  // content is ours already — marker only, no adopt and no disk write.
  const after = decideReconcile(local, { ...server, updated_at: 950 }, { serverUpdatedAt: 900, localFingerprint: fp });
  assert.equal(after.action, "noop");
  assert.equal(after.marker.serverUpdatedAt, 950);
});

// ─── 4xx triage helpers ─────────────────────────────────────────────────────
test("findReportedGroupInDetail names the blamed group only when the server does", () => {
  const payload = buildReportedPolicy({ groups: { "conv-aaa": {}, "conv-bbb": {} } });
  assert.equal(findReportedGroupInDetail(payload, "group conv-bbb: not found"), "conv-bbb");
  // a routing 404 does not name any conversation we reported
  assert.equal(findReportedGroupInDetail(payload, "404 page not found"), undefined);
  assert.equal(findReportedGroupInDetail(payload, ""), undefined);
});

test("dropGroupFromReport removes the group from both surfaces", () => {
  const payload = buildReportedPolicy({ groups: { g1: {}, g2: {} } });
  const next = dropGroupFromReport(payload, "g1");
  assert.deepEqual(next.group_allowlist, ["g2"]);
  assert.deepEqual(next.groups.map((g) => g.conversation_id), ["g2"]);
  // original untouched
  assert.deepEqual(payload.group_allowlist.sort(), ["g1", "g2"]);
});

// ─── reconcileAgentPolicy (I/O sequencing) ──────────────────────────────────
interface Recorder {
  puts: ReportedPolicyPayload[];
  adopted: AccessLike[];
  warnings: string[];
}

function harness(
  localAccess: AccessLike,
  marker: ReconcileMarker,
  server: ServerPolicySnapshot | Error,
  putBehavior: (payload: ReportedPolicyPayload, attempt: number) => void = () => {},
) {
  const rec: Recorder = { puts: [], adopted: [], warnings: [] };
  const deps = {
    localAccess,
    marker,
    getServerPolicy: async () => {
      if (server instanceof Error) throw server;
      return server;
    },
    putReportedPolicy: async (payload: ReportedPolicyPayload) => {
      rec.puts.push(structuredClone(payload));
      putBehavior(payload, rec.puts.length);
      return {};
    },
    adoptAccess: (access: AccessLike) => {
      rec.adopted.push(structuredClone(access));
    },
    warn: (m: string) => rec.warnings.push(m),
  };
  return { rec, deps };
}

test("reconcile seeds with exactly one PUT and an exact body when the server has no policy", async () => {
  const local: AccessLike = { dmPolicy: "owner", groupPolicy: "allowlist", groups: { g1: { mode: "smart", allowFrom: [] } } };
  const { rec, deps } = harness(local, EMPTY_RECONCILE_MARKER, { ...EMPTY_SERVER, updated_at: 0 });
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "seed");
  assert.equal(out.puts, 1);
  assert.equal(rec.puts.length, 1);
  assert.deepEqual(rec.puts[0], {
    dm_policy: "owner",
    dm_allowlist: [],
    group_scope: "allowlist",
    group_allowlist: ["g1"],
    groups: [{ conversation_id: "g1", mode: "smart", allow_from: ["*"] }],
  });
  assert.equal(rec.adopted.length, 0);
});

test("reconcile does not PUT when the server has no policy row but carries group rows", async () => {
  const { rec, deps } = harness({ groups: { g1: {} } }, EMPTY_RECONCILE_MARKER, {
    ...EMPTY_SERVER,
    updated_at: 0,
    group_allowlist: ["gX"],
    groups: [{ conversation_id: "gX", mode: "mention" }],
  });
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "noop");
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.adopted.length, 0);
});

test("reconcile adopts and persists a newer server policy without PUTting", async () => {
  // The 12:15:58 erasure in reverse: local is the stale empty state that came
  // back from disk after a restart, the server holds the owner's real allowlist.
  const local: AccessLike = { groupPolicy: "allowlist", groups: {} };
  const { rec, deps } = harness(local, EMPTY_RECONCILE_MARKER, {
    dm_policy: "owner",
    dm_allowlist: [],
    group_scope: "allowlist",
    group_allowlist: ["g-real"],
    groups: [{ conversation_id: "g-real", mode: "mention", allow_from: ["*"] }],
    updated_at: 1756300000,
  });
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "adopt");
  assert.equal(out.puts, 0);
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.adopted.length, 1); // adoptAccess = live update + disk write
  assert.deepEqual(Object.keys(rec.adopted[0].groups!), ["g-real"]);
  assert.equal(out.marker.serverUpdatedAt, 1756300000);
});

test("reconcile never PUTs when the server read fails", async () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: {} }; // stale/empty — the dangerous case
  const err: any = new Error("upstream timeout");
  err.status = 504;
  const marker: ReconcileMarker = { serverUpdatedAt: 900, localFingerprint: "stale" };
  const { rec, deps } = harness(local, marker, err);
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "skipped");
  assert.equal(out.puts, 0);
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.adopted.length, 0);
  assert.deepEqual(out.marker, marker); // unchanged, so the next cycle retries
  assert.match(rec.warnings.join(" "), /not reporting this round/);
});

test("reconcile never PUTs when the server response is not an object", async () => {
  const { rec, deps } = harness({ groups: {} }, EMPTY_RECONCILE_MARKER, "<html>gateway</html>" as any);
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "skipped");
  assert.equal(rec.puts.length, 0);
});

test("reconcile in steady state issues no PUT and writes nothing", async () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: { mode: "mention", allowFrom: ["*"] } } };
  const server: ServerPolicySnapshot = {
    dm_policy: "owner",
    dm_allowlist: [],
    group_scope: "allowlist",
    group_allowlist: ["g1"],
    groups: [{ conversation_id: "g1", mode: "mention", allow_from: ["*"] }],
    updated_at: 900,
  };
  const marker: ReconcileMarker = { serverUpdatedAt: 900, localFingerprint: policyFingerprint(local) };
  const { rec, deps } = harness(local, marker, server);
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "noop");
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.adopted.length, 0);
  // and a second identical round stays quiet
  const again = await reconcileAgentPolicy({ ...deps, marker: out.marker });
  assert.equal(again.action, "noop");
  assert.equal(rec.puts.length, 0);
});

test("reconcile drops the group a 404 blames and retries once", async () => {
  // Agent was removed from g-left; cws-comm's verifyAgentGroupMember answers
  // 404 and the BFF passes the downstream message through as detail.
  const local: AccessLike = { groupPolicy: "allowlist", groups: { "g-stay": {}, "g-left": {} } };
  const { rec, deps } = harness(local, EMPTY_RECONCILE_MARKER, { ...EMPTY_SERVER, updated_at: 0 }, (payload, attempt) => {
    if (attempt === 1) {
      const err: any = new Error("group g-left: not found");
      err.status = 404;
      throw err;
    }
    assert.equal(payload.group_allowlist.includes("g-left"), false);
  });
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "seed");
  assert.equal(out.puts, 2);
  assert.deepEqual(rec.puts[0].group_allowlist.sort(), ["g-left", "g-stay"]);
  assert.deepEqual(rec.puts[1].group_allowlist, ["g-stay"]);
  assert.deepEqual(rec.puts[1].groups.map((g) => g.conversation_id), ["g-stay"]);
  assert.match(rec.warnings.join(" "), /dropping it and retrying once/);
});

test("reconcile treats a 404 that names no reported group as a real failure, not a missing endpoint", async () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: {} } };
  const marker: ReconcileMarker = { serverUpdatedAt: 900, localFingerprint: "old" };
  const { rec, deps } = harness(
    local,
    marker,
    { ...EMPTY_SERVER, group_scope: "allowlist", updated_at: 900 },
    () => {
      const err: any = new Error("404 page not found");
      err.status = 404;
      throw err;
    },
  );
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "failed");
  assert.equal(out.puts, 1); // no blind retry
  assert.deepEqual(out.marker, marker); // marker held back so the next cycle retries
  const warned = rec.warnings.join(" ");
  assert.match(warned, /naming no group we reported/);
  assert.equal(/endpoint not available/.test(warned), false);
});

test("reconcile gives up after one group-drop retry instead of looping", async () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: {}, g2: {} } };
  const { rec, deps } = harness(local, EMPTY_RECONCILE_MARKER, { ...EMPTY_SERVER, updated_at: 0 }, (payload) => {
    const err: any = new Error(`group ${payload.group_allowlist[0]}: not found`);
    err.status = 404;
    throw err;
  });
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "failed");
  assert.equal(out.puts, 2);
  assert.equal(rec.puts.length, 2);
  const warned = rec.warnings.join(" ");
  assert.match(warned, /again: .* giving up this round/);
  assert.equal(/naming no group we reported/.test(warned), false);
});

test("reconcile reports a mode:silent group by leaving it out of the payload", async () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { g1: { mode: "mention" }, hushed: { mode: "silent" } } };
  const { rec, deps } = harness(local, EMPTY_RECONCILE_MARKER, { ...EMPTY_SERVER, updated_at: 0 });
  const out = await reconcileAgentPolicy(deps);
  assert.equal(out.action, "seed");
  assert.deepEqual(rec.puts[0].group_allowlist, ["g1"]);
  assert.deepEqual(rec.puts[0].groups.map((g) => g.conversation_id), ["g1"]);
});

test("adopting a server policy keeps a local silent group the server cannot represent", () => {
  const local: AccessLike = { groupPolicy: "allowlist", groups: { hushed: { mode: "silent", allowFrom: ["*"] } } };
  const access = serverPolicyToAccess(
    { group_scope: "allowlist", group_allowlist: ["g-new"], groups: [{ conversation_id: "g-new", mode: "mention" }], updated_at: 5 },
    local,
  );
  assert.deepEqual(Object.keys(access.groups!).sort(), ["g-new", "hushed"]);
  assert.equal(access.groups!.hushed.mode, "silent");
});
