import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { root, until } from "./support.ts";
import { brokerCall, startBroker } from "../src/client.ts";
import { sendMessage } from "../src/send.ts";
import { brokerCwdCheck, processCwd } from "../src/procinfo.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const childLog = join(root, "codex-child.log");
const stub = join(root, "cwd-checking-codex.sh");
writeFileSync(
  stub,
  [
    "#!/bin/sh",
    `/bin/pwd -P >/dev/null 2>&1 || { echo "Error: failed to resolve config cwd: No such file or directory (os error 2)" >&2; exit 1; }`,
    `echo "cwd=$(/bin/pwd -P) PWD=$PWD" >> ${childLog}`,
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(stub, 0o755);

function cwdOf(pid: number): string | undefined {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").find((l) => l.startsWith("n"))?.slice(1);
  } catch {
    return undefined;
  }
}

const ping = () => brokerCall<{ pid: number }>("ping", {}, { autoStart: false, timeoutMs: 500 }).catch(() => undefined);

async function brokerUp(): Promise<{ pid: number }> {
  for (let i = 0; i < 100; i++) {
    const pong = await ping();
    if (pong) return pong;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the daemon did not answer");
}

async function stopDaemon(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000);
}

test("a daemon started in a directory that is then deleted keeps serving and waking, from the home directory", async () => {
  const start = join(root, "daemon-start-dir");
  mkdirSync(start);
  const child = spawn(process.execPath, [cli, "daemon"], { cwd: start, env: { ...process.env, PWD: start, AGENTSOCKS_CODEX_BIN: stub }, stdio: "ignore" });
  try {
    assert.equal((await brokerUp()).pid, child.pid);
    rmdirSync(start);

    assert.ok(await ping(), "it still answers after its start directory is gone");
    assert.equal(cwdOf(child.pid!), realpathSync(homedir()), "the daemon works from the home directory, not where it was started");

    const thread = "cwd-thread";
    await brokerCall("hook", { threadId: thread, event: "SessionStart", cwd: "/work/cwd-thread" }, { autoStart: false });
    await brokerCall("hook", { threadId: thread, event: "Stop" }, { autoStart: false });
    const sent = await sendMessage({ kind: "cli", name: "cwd-sender" }, "codex-cwd-thread", "are you there?");
    assert.match(sent.note, /accepted the request to wake them/);
    const line = readFileSync(childLog, "utf8").trim().split("\n").at(-1)!;
    assert.equal(line.split(" ")[0], `cwd=${realpathSync(homedir())}`, "the wake child runs in an existing directory");
    assert.doesNotMatch(line, new RegExp(start), "the starter's directory does not leak into the child's PWD");
  } finally {
    await stopDaemon(child.pid!);
  }
});

test("startBroker never hands its own working directory to the daemon", async () => {
  const caller = join(root, "caller-dir");
  mkdirSync(caller);
  const back = process.cwd();
  process.chdir(caller);
  try {
    startBroker();
  } finally {
    process.chdir(back);
  }
  const pong = await brokerUp();
  try {
    rmdirSync(caller);
    assert.equal(cwdOf(pong.pid), realpathSync(homedir()));
    assert.ok(await ping(), "it serves after the caller's directory is removed");
  } finally {
    await stopDaemon(pong.pid);
  }
});

const linux = (link: string | undefined) => ({ readlink: () => link, lsof: () => undefined });
const darwin = (out: string | undefined) => ({ readlink: () => undefined, lsof: () => out });

test("the broker's working directory is read from /proc on Linux and from lsof elsewhere", () => {
  assert.deepEqual(processCwd(42, "linux", linux("/home/me")), { path: "/home/me", deleted: false });
  assert.deepEqual(processCwd(42, "linux", linux("/work/tree (deleted)")), { path: "/work/tree", deleted: true });
  assert.deepEqual(processCwd(42, "darwin", darwin("p42\nfcwd\nn/Users/me/work tree\n")), { path: "/Users/me/work tree", deleted: false });
  assert.equal(processCwd(42, "darwin", darwin(undefined)), undefined);
  assert.equal(processCwd(42, "darwin", darwin("p42\n")), undefined);
});

test("doctor fails the broker's working directory when it no longer exists, and says how to recover", () => {
  const live = brokerCwdCheck(42, { path: "/home/me", deleted: false }, () => true, "darwin");
  assert.equal(live.ok, true);
  assert.match(live.detail, /\/home\/me/);
  const gone = brokerCwdCheck(42, { path: "/work/tree", deleted: false }, () => false, "darwin");
  assert.equal(gone.ok, false);
  assert.match(gone.detail, /\/work\/tree no longer exists/);
  assert.match(gone.detail, /kill 42/);
  assert.equal(brokerCwdCheck(42, { path: "/work/tree", deleted: true }, () => true, "linux").ok, false, "a recreated path does not hide a deleted directory on Linux");
  const unknown = brokerCwdCheck(42, undefined, () => true, "darwin");
  assert.equal(unknown.ok, true);
  assert.match(unknown.detail, /could not be read.*lsof/);
});
