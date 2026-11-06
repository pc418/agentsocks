import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";

const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
const id = (n: number) => `0199eeee-0000-7000-8000-${String(n).padStart(12, "0")}`;
const USER = id(1);
const SPAWN = id(2);
const FRESH = id(3);
const UNTRUSTED = id(4);
const AUTO = id(5);
const HOOK_WINS = id(6);
const LEGACY = id(7);
const ONE_REPORT = id(8);

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, source TEXT NOT NULL, thread_source TEXT, first_user_message TEXT NOT NULL DEFAULT '')",
  );
  const insert = db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, source, thread_source, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(USER, "user", "/work/state-db", "never", Date.now(), "cli", "user", "x");
  insert.run(SPAWN, "spawn", "/work/state-db", "never", Date.now(), "cli", "subagent", "x");
  insert.run(FRESH, "fresh", "/work/fresh", "never", Date.now(), "cli", "user", "x");
  insert.run(UNTRUSTED, "untrusted", "/work/untrusted", "untrusted", Date.now(), "cli", "user", "x");
  insert.run(AUTO, "auto", "/work/auto", "on-request", Date.now(), "cli", "user", "x");
  insert.run(HOOK_WINS, "hookwins", "/work/hook-wins", "untrusted", Date.now(), "cli", "user", "x");
  insert.run(LEGACY, "legacy", "/work/legacy-state", "on-request", Date.now(), "cli", "user", "x");
  insert.run(ONE_REPORT, "", "/work/one-report-state", "never", Date.now(), "cli", "user", "x");
  db.close();
  await broker.start();
});

after(() => broker.stop());

test("a thread registered before the subagent flag existed keeps the permission mode and cwd its hook supplied", async () => {
  await broker.hook({ threadId: USER, event: "SessionStart", cwd: "/work/hook", permissionMode: "plan" });
  assert.equal(broker.store.getThread(USER)!.mode, "prompting");
  broker.store.updateThread(USER, { subagent: null });
  await broker.register(USER, {});
  const row = broker.store.getThread(USER)!;
  assert.equal(row.mode, "prompting", "the state DB's approval_mode is 'never', which would read as bypass");
  assert.equal(row.cwd, "/work/hook");
  assert.equal(row.subagent, 0, "the null flag is still filled in");
});

test("the null flag of a thread that has a mode is still looked up, and a subagent is found", async () => {
  await broker.hook({ threadId: SPAWN, event: "SessionStart", permissionMode: "plan" });
  broker.store.updateThread(SPAWN, { subagent: null });
  await broker.register(SPAWN, {});
  const row = broker.store.getThread(SPAWN)!;
  assert.equal(row.subagent, 1);
  assert.equal(row.mode, "prompting");
});

test("a thread with no mode still takes its mode and cwd from the state DB", async () => {
  await broker.register(FRESH, {});
  const row = broker.store.getThread(FRESH)!;
  assert.equal(row.mode, "bypass");
  assert.equal(row.cwd, "/work/fresh");
  assert.equal(row.subagent, 0);
});

// Only an approval policy that asks first (untrusted) reads as prompting.
test("a thread with no hook report takes prompting from an untrusted approval policy and bypass from on-request", async () => {
  await broker.register(UNTRUSTED, {});
  assert.equal(broker.store.getThread(UNTRUSTED)!.mode, "prompting");
  await broker.register(AUTO, {});
  assert.equal(broker.store.getThread(AUTO)!.mode, "bypass", "on-request is Codex's Auto preset");
});

test("a hook's report wins over the state DB's approval policy", async () => {
  await broker.hook({ threadId: HOOK_WINS, event: "SessionStart", cwd: "/work/hook-wins", permissionMode: "default" });
  assert.equal(broker.store.getThread(HOOK_WINS)!.mode, "bypass", "the state DB says untrusted, the hook says default");
  await broker.hook({ threadId: HOOK_WINS, event: "PostToolUse", permissionMode: "plan" });
  assert.equal(broker.store.getThread(HOOK_WINS)!.mode, "prompting", "a later report changes it");
});

test("a mode stored by an earlier release is derived again from the state DB, and the hook's cwd is kept", async () => {
  await broker.register(LEGACY, { cwd: "/work/legacy-hook" });
  broker.store.updateThread(LEGACY, { mode: "prompting", mode_rule: null });
  await broker.register(LEGACY, {});
  const row = broker.store.getThread(LEGACY)!;
  assert.equal(row.mode, "bypass", "on-request was stored as prompting before; it is bypass now");
  assert.equal(row.cwd, "/work/legacy-hook");
  assert.notEqual(row.mode_rule, null);
});

test("a mode reported when the thread is first registered is kept by a later registration that reports none", async () => {
  await broker.register(ONE_REPORT, { cwd: "/work/one-report", permissionMode: "plan" });
  assert.equal(broker.store.getThread(ONE_REPORT)!.mode, "prompting");
  await broker.register(ONE_REPORT, {});
  assert.equal(broker.store.getThread(ONE_REPORT)!.mode, "prompting", "the state DB's never would read as bypass");
});
