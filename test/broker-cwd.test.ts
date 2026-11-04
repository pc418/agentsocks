import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { root, until } from "./support.ts";
import { brokerCall, startBroker } from "../src/client.ts";
import { sendMessage } from "../src/send.ts";
import { brokerCwdCheck, processCwd } from "../src/procinfo.ts";
import { anchoredEnv } from "../src/paths.ts";

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

test("doctor fails the broker's working directory when it no longer exists, says how to recover, and calls an unreadable one unknown", () => {
  const live = brokerCwdCheck(42, { path: "/home/me", deleted: false }, () => true, "darwin");
  assert.equal(live.status, "ok");
  assert.match(live.detail, /\/home\/me/);
  const gone = brokerCwdCheck(42, { path: "/work/tree", deleted: false }, () => false, "darwin");
  assert.equal(gone.status, "gone");
  assert.match(gone.detail, /\/work\/tree no longer exists/);
  assert.match(gone.detail, /kill 42/);
  assert.equal(brokerCwdCheck(42, { path: "/work/tree", deleted: true }, () => true, "linux").status, "gone", "a recreated path does not hide a deleted directory on Linux");
  const unknown = brokerCwdCheck(42, undefined, () => true, "darwin");
  assert.equal(unknown.status, "unknown", "an unreadable directory is neither a pass nor a failure");
  assert.match(unknown.detail, /could not be read.*lsof/);
});

test("path-valued variables are anchored to the caller's directory; names, commands without a slash and absolute paths are kept", () => {
  const env = anchoredEnv(
    {
      AGENTSOCKS_RUNTIME_DIR: "./rt",
      AGENTSOCKS_STATE_DIR: "st",
      AGENTSOCKS_CONFIG: "../cfg/agentsocks.json",
      AGENTSOCKS_CCSOCKS_DIR: "/abs/cc",
      CODEX_HOME: "codex-home",
      XDG_STATE_HOME: "xdg-state",
      TS_SOCKET: "ts.sock",
      AGENTSOCKS_CODEX_BIN: "bin/codex",
      AGENTSOCKS_TAILSCALE_BIN: "tailscale",
      AGENTSOCKS_CLASSIFIER_KEY: "relative-looking-value",
      OMP_PROFILE: "work",
      PATH: "/usr/bin::bin",
    },
    "/caller/dir",
  );
  assert.equal(env.AGENTSOCKS_RUNTIME_DIR, "/caller/dir/rt");
  assert.equal(env.AGENTSOCKS_STATE_DIR, "/caller/dir/st");
  assert.equal(env.AGENTSOCKS_CONFIG, "/caller/cfg/agentsocks.json");
  assert.equal(env.AGENTSOCKS_CCSOCKS_DIR, "/abs/cc");
  assert.equal(env.CODEX_HOME, "/caller/dir/codex-home");
  assert.equal(env.XDG_STATE_HOME, "/caller/dir/xdg-state");
  assert.equal(env.TS_SOCKET, "/caller/dir/ts.sock");
  assert.equal(env.AGENTSOCKS_CODEX_BIN, "/caller/dir/bin/codex");
  assert.equal(env.AGENTSOCKS_TAILSCALE_BIN, "tailscale", "a bare command is still looked up on PATH");
  assert.equal(env.AGENTSOCKS_CLASSIFIER_KEY, "relative-looking-value");
  assert.equal(env.OMP_PROFILE, "work");
  assert.equal(env.PATH, "/usr/bin:/caller/dir:/caller/dir/bin", "an empty PATH entry meant the caller's directory");
});

async function inRelativeSetup<T>(dir: string, vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const back = process.cwd();
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.chdir(back);
  }
}

test("startBroker with a relative runtime and state directory starts a broker the caller can reach, keeping its files where they were", async () => {
  const project = join(root, "rel-project");
  await inRelativeSetup(project, { AGENTSOCKS_RUNTIME_DIR: "./rt", AGENTSOCKS_STATE_DIR: "./st" }, async () => {
    startBroker();
    let pong: { pid: number } | undefined;
    try {
      pong = await brokerUp();
      assert.ok(existsSync(join(project, "rt", "broker.sock")), "the socket is where the caller looks");
      assert.ok(existsSync(join(project, "st", "agentsocks.db")), "the state stays under the caller's directory");
      assert.ok(!existsSync(join(homedir(), "rt")), "nothing is rebased onto the home directory");
    } finally {
      if (pong) await stopDaemon(pong.pid);
    }
  });
});

test("a daemon run directly with a relative runtime directory resolves it before it moves to the home directory", async () => {
  const project = join(root, "rel-direct");
  await inRelativeSetup(project, { AGENTSOCKS_RUNTIME_DIR: "./rt2", AGENTSOCKS_STATE_DIR: "./st2" }, async () => {
    const child = spawn(process.execPath, [cli, "daemon"], { cwd: project, env: { ...process.env }, stdio: "ignore" });
    try {
      assert.equal((await brokerUp()).pid, child.pid);
      assert.ok(existsSync(join(project, "rt2", "broker.sock")));
      assert.equal(cwdOf(child.pid!), realpathSync(homedir()));
    } finally {
      await stopDaemon(child.pid!);
    }
  });
});
