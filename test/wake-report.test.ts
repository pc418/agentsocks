import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, until } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { Store } from "../src/store.ts";
import { dbPath } from "../src/paths.ts";
import { messageStatus, peerStatus } from "../src/ops.ts";
import { formatMessageStatus, formatPeerStatus } from "../src/render.ts";
import { sendMessage } from "../src/send.ts";
import { deliveryNote } from "../src/routing.ts";
import { NOT_FROM_DRIVER_RULE } from "../src/router.ts";
import type { Me } from "../src/peers.ts";

const calls = join(root, "codex-calls.log");
const down = join(root, "codex-down");
const slow = join(root, "codex-slow");
const leaky = join(root, "codex-leaky-stderr");
const stub = join(root, "codex-like.sh");
writeFileSync(
  stub,
  [
    "#!/bin/sh",
    `/bin/pwd -P >/dev/null 2>&1 || { echo "Error: failed to resolve config cwd: No such file or directory (os error 2)" >&2; exit 1; }`,
    `echo "$@" >> ${calls}`,
    `[ -e ${leaky} ] && { cat ${leaky} >&2; exit 1; }`,
    `[ -e ${down} ] && { echo "app-server unreachable" >&2; exit 1; }`,
    `[ -e ${slow} ] && sleep 3`,
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(stub, 0o755);

const broker = new Broker({ codexBin: stub, ttyScan: () => [], wakeReportMs: 2500 });
const me: Me = { kind: "cli", name: "wake-sender" };
const queueCalls = (thread: string) => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("queue") && l.includes(`--thread ${thread} `)).length : 0);
const auditFor = (event: string, thread: string) =>
  readFileSync(join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log"), "utf8")
    .split("\n")
    .filter((l) => l.includes(`"event":"${event}"`) && l.includes(`"thread":"${thread}"`));
const idleThread = async (id: string) => {
  await broker.hook({ threadId: id, event: "SessionStart", cwd: `/work/${id}` });
  await broker.hook({ threadId: id, event: "Stop" });
};

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("an idle Codex thread is woken even after the directory the broker started in was deleted", async () => {
  await idleThread("wr-control");
  const control = await sendMessage(me, "codex-wr-control", "control message");
  await until(() => auditFor("wake", "wr-control").length + auditFor("wake_failed", "wr-control").length > 0, 5000);
  assert.equal(auditFor("wake", "wr-control").length, 1, "control: with a live working directory the wake goes out");
  assert.equal(queueCalls("wr-control"), 1);
  assert.doesNotMatch(control.note, /NOT woken/);

  const started = process.cwd();
  const gone = join(root, "deleted-start-dir");
  mkdirSync(gone);
  process.chdir(gone);
  rmdirSync(gone);
  try {
    await idleThread("wr-gone");
    const sent = await sendMessage(me, "codex-wr-gone", "message after the start directory vanished");
    await until(() => auditFor("wake", "wr-gone").length + auditFor("wake_failed", "wr-gone").length > 0, 5000);
    assert.deepEqual(auditFor("wake_failed", "wr-gone"), [], "the wake does not fail on the broker's deleted working directory");
    assert.equal(queueCalls("wr-gone"), 1, "codex queue ran once for the thread");
    assert.equal(broker.store.getThread("wr-gone")!.wake_error ?? null, null);
    assert.doesNotMatch(sent.note, /NOT woken/);
  } finally {
    process.chdir(started);
  }
});

test("an accepted wake is reported as accepted, not as 'right away if idle'", async () => {
  await idleThread("wr-ok");
  const sent = await sendMessage(me, "codex-wr-ok", "please look at this");
  assert.equal(queueCalls("wr-ok"), 1, "the reply came after the wake attempt");
  assert.match(sent.note, /accepted the request to wake them/);
  assert.doesNotMatch(sent.note, /right away if idle/);
});

test("two sends inside the debounce share one wake and both senders hear its outcome", async () => {
  await idleThread("wr-pair");
  const [a, b] = await Promise.all([sendMessage(me, "codex-wr-pair", "first of two"), sendMessage({ kind: "cli", name: "wake-sender-2" }, "codex-wr-pair", "second of two")]);
  assert.equal(queueCalls("wr-pair"), 1, "one codex queue call for both messages");
  assert.match(a.note, /accepted the request to wake them/);
  assert.match(b.note, /accepted the request to wake them/);
});

test("a wake that fails is reported to the sender with its reason, shown in status, kept across a restart and retried with backoff", async () => {
  writeFileSync(down, "");
  try {
    await idleThread("wr-fail");
    const first = await sendMessage(me, "codex-wr-fail", "this one cannot wake them");
    assert.equal(queueCalls("wr-fail"), 1);
    assert.match(first.note, /^Queued, NOT woken: .*app-server unreachable/);
    assert.doesNotMatch(first.note, /right away if idle/);

    const second = await sendMessage(me, "codex-wr-fail", "and this one arrives inside the backoff");
    assert.equal(queueCalls("wr-fail"), 1, "no attempt inside the backoff");
    assert.match(second.note, /^Queued, NOT woken: .*app-server unreachable/);
    assert.match(second.note, /retr/i, "the sender is told a retry is coming");

    const record = formatMessageStatus(await messageStatus(me, first.msgId));
    assert.match(record, /wake/i);
    assert.match(record, /app-server unreachable/);
    const peer = await peerStatus(me, "codex-wr-fail");
    assert.match(formatPeerStatus(peer), /wake failed .*app-server unreachable/);

    const reopened = new Store(dbPath());
    try {
      const row = reopened.getThread("wr-fail")!;
      assert.match(row.wake_error ?? "", /app-server unreachable/, "the failure is persisted, not only held in memory");
      assert.equal(row.wake_failures, 1);
    } finally {
      reopened.db.close();
    }

    rmSync(down);
    await broker.wake("wr-fail", Date.now() + 31_000);
    assert.equal(queueCalls("wr-fail"), 2, "after the backoff the wake is attempted again");
    assert.equal(broker.store.getThread("wr-fail")!.wake_error ?? null, null, "a success clears the failure");
    assert.doesNotMatch(formatPeerStatus(await peerStatus(me, "codex-wr-fail")), /wake failed/);
  } finally {
    rmSync(down, { force: true });
  }
});

test("a wake skipped by the hourly cap tells the sender so", async () => {
  await idleThread("wr-cap");
  broker.store.updateThread("wr-cap", { wake_log: JSON.stringify(Array.from({ length: 6 }, (_, i) => Date.now() - i * 60_000)) });
  const sent = await sendMessage(me, "codex-wr-cap", "an ordinary message over the cap");
  assert.equal(queueCalls("wr-cap"), 0, "the cap still holds the wake back");
  assert.match(sent.note, /^Queued, NOT woken: .*hour/);
});

test("a wake that has not answered within the report bound is reported as unconfirmed, and status shows its outcome later", async () => {
  writeFileSync(slow, "");
  try {
    await idleThread("wr-slow");
    const sent = await sendMessage(me, "codex-wr-slow", "slow wake");
    assert.match(sent.note, /not confirmed/);
    assert.doesNotMatch(sent.note, /right away if idle/);
    await until(() => auditFor("wake", "wr-slow").length === 1, 8000);
    assert.match(formatMessageStatus(await messageStatus(me, sent.msgId)), /wake accepted/);
  } finally {
    rmSync(slow, { force: true });
  }
});

test("a busy receiver and a digest keep their old wording and wake nobody", async () => {
  await idleThread("wr-busy");
  await broker.hook({ threadId: "wr-busy", event: "UserPromptSubmit", prompt: "working" });
  const busy = await sendMessage(me, "codex-wr-busy", "while you are busy");
  assert.equal(busy.note, "Delivered. They see it at their next tool call, or right away if idle.");
  await idleThread("wr-digest");
  const fyi = await sendMessage(me, "codex-wr-digest", "FYI only", undefined, { urgency: "fyi" });
  assert.equal(fyi.route, "digest");
  assert.match(fyi.note, /^Batched/);
  assert.equal(queueCalls("wr-busy") + queueCalls("wr-digest"), 0);
});

test("a credential in the wake error is redacted before the reason is shortened, so it never reaches the sender or status", async () => {
  const head = "Error: could not reach https://deploy:";
  const password = "q".repeat(200 - head.length);
  writeFileSync(leaky, `${head}${password}@registry.invalid/queue failed\n`);
  try {
    await idleThread("wr-leak");
    const sent = await sendMessage(me, "codex-wr-leak", "wake with a leaky error");
    assert.match(sent.note, /^Queued, NOT woken: /);
    assert.doesNotMatch(sent.note, new RegExp(password));
    assert.doesNotMatch(broker.store.getThread("wr-leak")!.wake_error ?? "", new RegExp(password));
    assert.doesNotMatch(formatPeerStatus(await peerStatus(me, "codex-wr-leak")), new RegExp(password));
    assert.doesNotMatch(formatMessageStatus(await messageStatus(me, sent.msgId)), new RegExp(password));
    assert.deepEqual(auditFor("wake_failed", "wr-leak").filter((l) => l.includes(password)), [], "nor the audit log");
  } finally {
    rmSync(leaky, { force: true });
  }
});

test("an information-only message to a driven receiver still tells the sender what the wake did", () => {
  const decision = { route: "pause" as const, by: "rule" as const, rule: NOT_FROM_DRIVER_RULE, driverName: "lead", awaited: true as const, reason: "not from its driver" };
  const to = { name: "worker", kind: "codex" as const };
  const failed = deliveryNote({ decision, status: "sent", to, wake: { outcome: "failed", reason: "app-server unreachable" } }, "normal");
  assert.match(failed, /Delivered as information: worker works for lead/);
  assert.match(failed, /NOT woken: the wake failed \(app-server unreachable\)/);
  const pending = deliveryNote({ decision, status: "sent", to, wake: { outcome: "pending" } }, "normal");
  assert.match(pending, /Delivered as information/);
  assert.match(pending, /not confirmed/);
  const accepted = deliveryNote({ decision, status: "sent", to, wake: { outcome: "accepted" } }, "normal");
  assert.match(accepted, /accepted the request to wake them/);
  assert.equal(deliveryNote({ decision, status: "sent", to }, "normal"), "Delivered as information: worker works for lead and may not act on it. Ask lead if you need it to do something.", "without a wake report the note is unchanged");
});
