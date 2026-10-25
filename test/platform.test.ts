import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ccSocksDir, claudeSocketDirs, codexHexName, inboxKind, namespaceDirs, namespacedSocketPath, runtimeDir, runtimeDirFor, type SocketContext } from "../src/paths.ts";
import { parentPid, processArgs, type ProcSource } from "../src/procinfo.ts";
import { isBrokerArgs } from "../src/broker.ts";
import { mcpServerConfig, validToml } from "../src/install.ts";
import { tempDir } from "./tmp.ts";

const context = (over: Partial<SocketContext> & { env?: NodeJS.ProcessEnv }): SocketContext => ({
  platform: "linux",
  env: {},
  uid: 1000,
  tmpdir: "/tmp",
  ...over,
});

const MAC_TMP = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";

test("Linux with XDG_RUNTIME_DIR: Claude's directory is $XDG_RUNTIME_DIR/cc-socks, then its /tmp fallback", () => {
  const c = context({ env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
  assert.deepEqual(claudeSocketDirs(c), ["/run/user/1000/cc-socks", "/tmp/cc-socks-1000"]);
  assert.equal(runtimeDirFor(c), "/run/user/1000/agentsocks");
});

test("Linux without XDG_RUNTIME_DIR: the standard /run/user/<uid> comes first, then tmpdir, then the fallback", () => {
  const c = context({ standardRuntime: "/run/user/1000" });
  assert.deepEqual(claudeSocketDirs(c), ["/run/user/1000/cc-socks", "/tmp/cc-socks", "/tmp/cc-socks-1000"]);
  assert.equal(runtimeDirFor(c), "/run/user/1000/agentsocks");
  assert.equal(runtimeDirFor(context({})), "/tmp/agentsocks-1000");
});

test("Linux with neither: the runtime directory is under os.tmpdir(), as in v0.2.0, even when that is not /tmp", () => {
  assert.equal(runtimeDirFor(context({ tmpdir: "/var/tmp/zz" })), "/var/tmp/zz/agentsocks-1000");
  assert.equal(runtimeDirFor(context({ tmpdir: `/var/tmp/${"z".repeat(70)}` })), `/var/tmp/${"z".repeat(70)}/agentsocks-1000`);
});

test("macOS: Claude's directory is under os.tmpdir() or /tmp (Claude Code 2.1.3xx binds /tmp/cc-socks there), and our runtime directory is /tmp, which Claude accepts as a reply target", () => {
  const c = context({ platform: "darwin", uid: 501, tmpdir: MAC_TMP });
  assert.deepEqual(claudeSocketDirs(c), [`${MAC_TMP}/cc-socks`, "/tmp/cc-socks", "/tmp/cc-socks-501"]);
  assert.equal(runtimeDirFor(c), "/tmp/agentsocks-501");
  assert.equal(runtimeDirFor(context({ platform: "darwin", uid: 501, tmpdir: "/tmp" })), "/tmp/agentsocks-501");
});

test("macOS: a temp directory whose thread sockets fit is used as it is; the first one that does not fit falls back to /tmp", () => {
  const room = 103 - Buffer.byteLength(join("agentsocks-501", "t", `${"x".repeat(36)}.sock`)) - 1;
  const fits = `/${"d".repeat(room - 1)}`;
  assert.equal(runtimeDirFor(context({ platform: "darwin", uid: 501, tmpdir: fits })), `${fits}/agentsocks-501`);
  assert.equal(runtimeDirFor(context({ platform: "darwin", uid: 501, tmpdir: `${fits}d` })), "/tmp/agentsocks-501");
});

test("macOS: a runtime directory is never rooted in the per-user temp directory, whose paths overflow the 104 byte sun_path", () => {
  const c = context({ platform: "darwin", uid: 501, tmpdir: MAC_TMP });
  const longest = join(runtimeDirFor(c), "t", `${"x".repeat(36)}.sock`);
  assert.ok(Buffer.byteLength(longest) <= 103, longest);
  const underTmpdir = join(MAC_TMP, "agentsocks-501", "t", `${"x".repeat(36)}.sock`);
  assert.ok(Buffer.byteLength(underTmpdir) > 103, `${underTmpdir} would not bind`);
});

test("an XDG_RUNTIME_DIR whose broker socket would not fit is skipped for /tmp instead of failing to bind; one whose broker socket fits is kept", () => {
  const brokerSocketFits = (xdg: string) => Buffer.byteLength(join(xdg, "agentsocks", "broker.sock")) <= 107;
  const keeps = `/home/${"u".repeat(60)}/run`;
  const skips = `/home/${"u".repeat(80)}/run`;
  assert.ok(brokerSocketFits(keeps) && !brokerSocketFits(skips));
  assert.equal(runtimeDirFor(context({ env: { XDG_RUNTIME_DIR: keeps } })), `${keeps}/agentsocks`);
  assert.equal(runtimeDirFor(context({ env: { XDG_RUNTIME_DIR: skips } })), "/tmp/agentsocks-1000");
  assert.equal(runtimeDirFor(context({ env: { XDG_RUNTIME_DIR: skips }, tmpdir: "/var/tmp/zz" })), "/tmp/agentsocks-1000");
  assert.equal(runtimeDirFor(context({ env: { XDG_RUNTIME_DIR: "/run/user/1000" } })), "/run/user/1000/agentsocks");
});

test("Termux keeps its directories under $PREFIX/tmp", () => {
  const env = { TERMUX_VERSION: "0.118", PREFIX: "/data/data/com.termux/files/usr" };
  const c = context({ platform: "android", env, uid: 10123, tmpdir: "/data/data/com.termux/files/usr/tmp" });
  assert.deepEqual(claudeSocketDirs(c), ["/data/data/com.termux/files/usr/tmp/cc-socks", "/data/data/com.termux/files/usr/tmp/cc-socks-10123"]);
  assert.equal(runtimeDirFor(c), "/data/data/com.termux/files/usr/tmp/agentsocks-10123");
  assert.equal(runtimeDirFor(context({ env: { TERMUX_VERSION: "0.118" } })), "/tmp/agentsocks-1000");
});

test("a namespaced socket name has to fit sun_path: 103 bytes on macOS, 107 on Linux, so the same directory can pass on one and fail on the other", () => {
  const dir = `/${"d".repeat(60)}`;
  const tmpdir = `${dir}/${"e".repeat(12)}`;
  const probe = (platform: NodeJS.Platform) => namespaceDirs(context({ platform, tmpdir }));
  assert.equal(Buffer.byteLength(join(tmpdir, "cc-socks", `a${"0".repeat(15)}.sock`)), 105);
  assert.deepEqual(probe("linux"), [join(tmpdir, "cc-socks"), "/tmp/cc-socks", "/tmp/cc-socks-1000"]);
  assert.deepEqual(probe("darwin"), ["/tmp/cc-socks", "/tmp/cc-socks-1000"]);
});

test("the name length the directory check assumes is the length of a real hex name", () => {
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = join(tempDir("as-hex-"), "run");
  try {
    assert.equal(codexHexName("019a8c2e-5f1d-7c3a-9b2e-1234567890ab").length, `a${"0".repeat(15)}.sock`.length);
  } finally {
    if (saved === undefined) delete process.env.AGENTSOCKS_RUNTIME_DIR;
    else process.env.AGENTSOCKS_RUNTIME_DIR = saved;
  }
});

test("when no directory can hold the name, none is offered and only the v0.1 alias path is used", () => {
  const huge = context({ platform: "darwin", uid: 501, tmpdir: `/${"d".repeat(120)}`, env: { PREFIX: `/${"p".repeat(120)}`, TERMUX_VERSION: "1" } });
  assert.deepEqual(namespaceDirs(huge), []);
});

function source(files: Record<string, string>, psOut: Record<string, string> = {}): ProcSource & { reads: string[]; psCalls: string[][] } {
  const reads: string[] = [];
  const psCalls: string[][] = [];
  return {
    reads,
    psCalls,
    read(path) {
      reads.push(path);
      return files[path];
    },
    ps(args) {
      psCalls.push(args);
      return psOut[args.join(" ")];
    },
  };
}

test("parentPid reads /proc on Linux and understands a command name containing spaces and parentheses", () => {
  const src = source({ "/proc/200/stat": "200 (node (v2) x) S 150 200 200 0 -1 4194560" });
  assert.equal(parentPid(200, "linux", src), 150);
  assert.deepEqual(src.psCalls, []);
});

test("parentPid falls back to ps on Linux when /proc cannot be read", () => {
  const src = source({}, { "-o ppid= -p 200": "  150\n" });
  assert.equal(parentPid(200, "linux", src), 150);
  assert.deepEqual(src.psCalls, [["-o", "ppid=", "-p", "200"]]);
});

test("parentPid on macOS asks ps and never touches /proc", () => {
  const src = source({ "/proc/200/stat": "200 (node) S 999 0" }, { "-o ppid= -p 200": "  150\n" });
  assert.equal(parentPid(200, "darwin", src), 150);
  assert.deepEqual(src.reads, []);
  assert.equal(parentPid(300, "darwin", src), undefined);
  assert.equal(parentPid(300, "darwin", source({}, { "-o ppid= -p 300": "\n" })), undefined);
  assert.equal(parentPid(300, "darwin", source({}, { "-o ppid= -p 300": "not a number" })), undefined);
});

test("processArgs splits /proc/<pid>/cmdline on NUL on Linux", () => {
  const src = source({ "/proc/7/cmdline": "/usr/bin/node\0/x/agentsocks/dist/cli.js\0daemon\0" });
  assert.deepEqual(processArgs(7, "linux", src), ["/usr/bin/node", "/x/agentsocks/dist/cli.js", "daemon", ""]);
  assert.equal(isBrokerArgs(processArgs(7, "linux", src)!), true);
});

test("processArgs on macOS asks ps with a width that does not truncate, and still recognises the daemon", () => {
  const line = "/Users/a b/.nvm/versions/node/v22.13.0/bin/node /Users/a b/lib/node_modules/agentsocks/dist/cli.js daemon\n";
  const src = source({}, { "-ww -o args= -p 7": line, "-ww -o args= -p 8": "gpg-agent --daemon\n" });
  assert.equal(isBrokerArgs(processArgs(7, "darwin", src)!), true);
  assert.equal(isBrokerArgs(processArgs(8, "darwin", src)!), false);
  assert.equal(processArgs(9, "darwin", src), undefined);
  assert.deepEqual(src.reads, []);
});

function asDarwin<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = { platform: process.platform, env: { ...process.env } };
  Object.defineProperty(process, "platform", { value: "darwin" });
  for (const key of ["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_CCSOCKS_DIR", "XDG_RUNTIME_DIR", "TERMUX_VERSION"]) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", { value: saved.platform });
    for (const key of Object.keys(env)) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
    for (const key of ["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_CCSOCKS_DIR", "XDG_RUNTIME_DIR", "TERMUX_VERSION"]) {
      if (saved.env[key] !== undefined) process.env[key] = saved.env[key];
    }
  }
}

test("on a simulated Mac the broker finds Claude's cc-socks directory under TMPDIR and binds the hex name beside Claude's own socket", () => {
  const tmp = tempDir("as-mac-");
  const claudeDir = join(tmp, "cc-socks");
  mkdirSync(claudeDir, { mode: 0o700 });
  chmodSync(claudeDir, 0o700);
  asDarwin({ TMPDIR: tmp }, () => {
    assert.equal(runtimeDir(), join(tmp, `agentsocks-${process.getuid!()}`));
    assert.equal(ccSocksDir(), claudeDir);
    const ns = namespacedSocketPath("019a8c2e-5f1d-7c3a-9b2e-1234567890ab")!;
    assert.match(ns, new RegExp(`^${claudeDir}/a[0-9a-f]{15}\\.sock$`));
    assert.equal(inboxKind(ns), "claude");
  });
});

test("on a simulated Mac with no cc-socks under TMPDIR the broker looks at /tmp/cc-socks, where Claude Code actually binds", () => {
  const tmp = tempDir("as-mac-");
  const c = context({ platform: "darwin", uid: 501, tmpdir: tmp });
  assert.deepEqual(claudeSocketDirs(c), [join(tmp, "cc-socks"), "/tmp/cc-socks", "/tmp/cc-socks-501"]);
  assert.deepEqual(claudeSocketDirs(context({ platform: "darwin", uid: 501, tmpdir: "/tmp" })), ["/tmp/cc-socks", "/tmp/cc-socks-501"]);
  assert.deepEqual(claudeSocketDirs(context({ platform: "darwin", uid: 501, tmpdir: tmp, env: { XDG_RUNTIME_DIR: "/run/user/501" } })), ["/run/user/501/cc-socks", "/tmp/cc-socks-501"]);
  assert.deepEqual(claudeSocketDirs(context({ platform: "darwin", uid: 501, tmpdir: tmp, env: { CLAUDE_CODE_TMPDIR: "/private/ct" } })), [join(tmp, "cc-socks"), "/private/ct/cc-socks", "/tmp/cc-socks-501"]);
});

test("on a simulated Mac a cc-socks directory that does not exist is not created for us", () => {
  const tmp = tempDir("as-mac-");
  const getuid = process.getuid;
  process.getuid = () => 4242;
  try {
    asDarwin({ TMPDIR: tmp }, () => assert.equal(ccSocksDir(), undefined));
  } finally {
    process.getuid = getuid;
  }
  assert.equal(existsSync(join(tmp, "cc-socks")), false);
});

function withFakePython<T>(exitCode: number | undefined, run: () => T): T {
  const dir = tempDir("as-py-");
  if (exitCode !== undefined) {
    writeFileSync(join(dir, "python3"), `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(join(dir, "python3"), 0o755);
  }
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return run();
  } finally {
    process.env.PATH = saved;
  }
}

test("a python3 without tomllib, or no python3 at all, means the TOML cannot be checked, not that it is invalid", () => {
  assert.equal(withFakePython(0, () => validToml("/x")), true);
  assert.equal(withFakePython(1, () => validToml("/x")), false);
  assert.equal(withFakePython(3, () => validToml("/x")), undefined);
  assert.equal(withFakePython(undefined, () => validToml("/x")), undefined);
});

test("validToml judges real files when python3 can parse TOML", (t) => {
  const dir = tempDir("as-toml-");
  const good = join(dir, "good.toml");
  const bad = join(dir, "bad.toml");
  writeFileSync(good, '[a]\nb = "c"\n');
  writeFileSync(bad, "[a\nb = \n");
  if (validToml(good) === undefined) return t.skip("this python3 has no tomllib");
  assert.equal(validToml(good), true);
  assert.equal(validToml(bad), false);
});

test("Codex passes TMPDIR to the MCP server, so a broker started there finds the same temp directory Claude Code uses", () => {
  assert.ok(mcpServerConfig().env_vars.includes("TMPDIR"));
  assert.ok(mcpServerConfig().env_vars.includes("CLAUDE_CODE_TMPDIR"), "Claude Code reads it for its cc-socks directory, so the broker has to see it too");
  assert.equal(mcpServerConfig().default_tools_approval_mode, "approve", "approval_policy = \"never\" otherwise refuses the tools");
});

test("package.json and its lockfile do not restrict os, so npm installs on Termux (android) and the code fails open where a platform is unsupported", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
  assert.equal(read("package.json").os, undefined);
  assert.equal(read("package-lock.json").packages[""].os, undefined);
});
