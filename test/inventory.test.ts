import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS } from "../src/brokerops/index.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { TOOL_SURFACES, toolNamesFor } from "../src/gateway/gtools.ts";
import { MIGRATIONS } from "../src/migrations.ts";
import { TOOLS, toolsFor } from "../src/tools/index.ts";

const OPS_EXPECTED = [
  "ask_answer",
  "ask_create",
  "ask_pick",
  "ask_wait",
  "channel_list",
  "channel_send",
  "channel_subscribe",
  "channel_unsubscribe",
  "gateway_allow",
  "gateway_link",
  "gateway_may",
  "gateway_off",
  "gateway_on",
  "gateway_pair",
  "gateway_public",
  "gateway_public_off",
  "gateway_served",
  "gateway_status",
  "gateway_token_add",
  "gateway_token_list",
  "gateway_token_revoke",
  "gateway_uninstall",
  "gateway_unlink",
  "hook",
  "label_export",
  "label_rate",
  "list_remote_peers",
  "list_threads",
  "message_status",
  "omp_wake_wait",
  "opencode_wake_wait",
  "peer_api_add",
  "peer_api_list",
  "peer_api_remove",
  "peer_status",
  "ping",
  "register",
  "route_send",
  "set_driver",
  "set_name",
  "stats",
  "take",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
  "top",
  "wait",
];

const TOOLS_EXPECTED = [
  "answer",
  "ask",
  "broadcast",
  "list_channels",
  "list_peers",
  "list_tasks",
  "message_status",
  "peer_status",
  "rate_message",
  "read_inbox",
  "send_message",
  "send_task",
  "set_driver",
  "set_name",
  "subscribe",
  "unsubscribe",
  "update_task",
  "wait_for_message",
];

const INBOX_ONLY = ["read_inbox", "wait_for_message", "set_name", "set_driver"];

const GATEWAY_FULL_EXPECTED = [
  "answer",
  "ask",
  "list_channels",
  "list_peers",
  "list_tasks",
  "message_status",
  "peer_status",
  "rate_message",
  "read_inbox",
  "send_message",
  "send_task",
  "subscribe",
  "unsubscribe",
  "update_task",
  "wait_for_message",
];

const GATEWAY_REDUCED_EXPECTED = ["answer", "list_peers", "read_inbox", "send_message", "wait_for_message"];

const COMMANDS_EXPECTED = [
  "--version",
  "channels",
  "classifier",
  "daemon",
  "doctor",
  "driver",
  "eval-router",
  "gateway",
  "help",
  "hook",
  "inbox",
  "install",
  "labels",
  "link",
  "list",
  "mcp",
  "peer",
  "send",
  "stats",
  "status",
  "tasks",
  "tool",
  "top",
  "uninstall",
  "whoami",
];

const GATEWAY_USAGE_EXPECTED = [
  "gateway on [--port <port>] [--serve]",
  "gateway off",
  "gateway status [--json]",
  "gateway routes",
  "gateway public --via funnel|cloudflared [--yes]",
  "gateway public off",
  "gateway token add <name> [--may-message <peer>...]",
  "gateway token list|revoke <id>",
  "gateway pair chatgpt [--may-message <peer>...] [--redirect-host <host>]",
  "gateway may <peer> [<name>...]",
  "gateway allow|disallow <host>",
  "gateway allow|disallow --user <login>",
];
test("inventory: every gateway subcommand synopsis is pinned", () => {
  const gateway = COMMANDS.find((c) => c.name === "gateway");
  assert.deepEqual(gateway?.usage.map((u) => u.synopsis), GATEWAY_USAGE_EXPECTED);
});

const ALIASES_EXPECTED = ["--help", "-h", "-v", "config"];

const MIGRATIONS_EXPECTED = [
  "create threads and messages",
  "threads.hooks_active",
  "messages.msg_id, stop_blocked, wakes",
  "threads.current_task, last_tool, last_activity, wake_hold_since, exempt_wake_log",
  "messages.route, decision, body_hash, released_at",
  "messages.msg_id backfill and index",
  "create outbox and tasks",
  "outbox.body_hash, body_chars",
  "threads.subagent",
  "tasks.from_session, to_session, request_id",
  "tasks.request_id unique index",
  "create channel_members",
  "create asks and ask_targets",
  "create labels",
  "messages.received_at index",
  "gateway tables",
  "threads.agent",
  "threads.driver_addr, driver_name, name_explicit",
  "threads.driver_sid",
  "threads.driver_instructed_at",
  "threads.mode_rule",
];

test("inventory: every broker op is registered, exactly once, under its pinned name", () => {
  assert.deepEqual([...OPS.keys()].sort(), OPS_EXPECTED);
});

test("inventory: the MCP tool registry holds the pinned tool set in registry order", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    "list_peers",
    "send_message",
    "send_task",
    "update_task",
    "list_tasks",
    "message_status",
    "peer_status",
    "read_inbox",
    "wait_for_message",
    "set_name",
    "set_driver",
    "subscribe",
    "unsubscribe",
    "list_channels",
    "broadcast",
    "ask",
    "answer",
    "rate_message",
  ]);
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), TOOLS_EXPECTED);
});

test("inventory: Codex sees every tool, Claude sees every tool but the inbox ones", () => {
  assert.deepEqual(toolsFor("codex").map((t) => t.name).sort(), TOOLS_EXPECTED);
  assert.deepEqual(toolsFor("claude").map((t) => t.name).sort(), TOOLS_EXPECTED.filter((n) => !INBOX_ONLY.includes(n)));
});

test("inventory: OMP and OpenCode offer one agentsocks_ tool per Codex tool", () => {
  assert.deepEqual(
    toolsFor("codex").map((t) => `agentsocks_${t.name}`).sort(),
    TOOLS_EXPECTED.map((n) => `agentsocks_${n}`).sort(),
  );
});

test("inventory: the tailnet surface offers the full gateway set, the public surface the reduced set", () => {
  assert.deepEqual(toolNamesFor("full").slice().sort(), GATEWAY_FULL_EXPECTED);
  assert.deepEqual(toolNamesFor("reduced").slice().sort(), GATEWAY_REDUCED_EXPECTED);
  for (const name of Object.keys(TOOL_SURFACES)) {
    assert.ok(TOOLS.some((t) => t.name === name), `gateway surface names ${name} which is not an MCP tool`);
  }
  for (const never of ["broadcast", "set_name", "set_driver"]) {
    assert.deepEqual(TOOL_SURFACES[never], [], `${never} is never offered to remote peers`);
  }
});

test("inventory: every CLI command name and alias is pinned", () => {
  assert.deepEqual(COMMANDS.map((c) => c.name).sort(), COMMANDS_EXPECTED);
  assert.deepEqual(COMMANDS.flatMap((c) => c.aliases ?? []).sort(), ALIASES_EXPECTED);
});

test("inventory: every migration step name is pinned in order", () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.name), MIGRATIONS_EXPECTED);
});
