import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentContext, agentReports, install, installAgents, uninstall } from "../src/install.ts";
import { readJsonObject, writeJsonObject } from "../src/agents/files.ts";
import { copilotInstaller } from "../src/agents/copilot/install.ts";
import { opencodeInstaller } from "../src/agents/opencode.ts";
import type { AgentSpec, InstallContext } from "../src/agents/types.ts";
import { shimmedEnv } from "./support.ts";
import { tempDir } from "./tmp.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function ctxFor(home: string, over: Partial<InstallContext> = {}): InstallContext {
  return { dryRun: false, home, log: [], hasBinary: () => false, command: (...args: string[]) => ["/usr/bin/node", "/opt/agentsocks/dist/cli.js", ...args], backup: () => {}, ...over };
}

test("a config write that fails halfway leaves the user's file whole, because it goes through a temporary file", () => {
  const dir = tempDir("agentsocks-atomic-");
  const target = join(dir, "mcp.json");
  const original = `${JSON.stringify({ mcpServers: { mine: { command: "x" } } }, null, 2)}\n`;
  writeFileSync(target, original);
  const script = join(dir, "write.ts");
  writeFileSync(
    script,
    `import { readJsonObject, writeJsonObject } from ${JSON.stringify(new URL("../src/agents/files.ts", import.meta.url).href)};
const file = readJsonObject(${JSON.stringify(target)});
file.doc.big = "x".repeat(200000);
writeJsonObject(file, { dryRun: false, home: "/", log: [], hasBinary: () => false, command: () => [], backup: () => {} }, "test");
`,
  );
  const r = spawnSync("sh", ["-c", `ulimit -f 1; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "the write cannot fit under the file size limit");
  assert.equal(readFileSync(target, "utf8"), original);
  assert.deepEqual(
    spawnSync("sh", ["-c", `ls ${JSON.stringify(dir)}`], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.includes(".tmp")),
    [],
  );
});

test("a symlinked config file is written through, so the link and the file it points to both stay", () => {
  const dir = tempDir("agentsocks-link-");
  const real = join(dir, "dotfiles-mcp.json");
  const link = join(dir, "mcp.json");
  writeFileSync(real, "{}\n", { mode: 0o640 });
  symlinkSync(real, link);
  const file = readJsonObject(link);
  file.doc.mcpServers = { a: { command: "b" } };
  writeJsonObject(file, ctxFor(dir), "test");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), real);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { mcpServers: { a: { command: "b" } } });
  assert.equal(lstatSync(real).mode & 0o777, 0o640);
});

test("doctor's agent lines survive an installer whose status cannot read its file", () => {
  const broken: AgentSpec = {
    id: "gemini",
    live: "untested",
    hook: async () => undefined,
    installer: { detect: () => true, install: () => {}, uninstall: () => {}, status: () => { throw new Error("EISDIR: illegal operation on a directory, read"); } },
  };
  const [report] = agentReports([broken]);
  assert.equal(report!.status.state, "partly wired");
  assert.match(report!.status.detail.join(" "), /could not read its configuration: EISDIR/);
});

test("a Copilot config that is a symlink is emptied through the link on uninstall, not unlinked with our entry left in the real file", () => {
  const home = tempDir("copilot-link-");
  const copilot = join(home, ".copilot");
  mkdirSync(copilot);
  const real = join(home, "dotfiles-mcp.json");
  writeFileSync(real, "{}\n");
  symlinkSync(real, join(copilot, "mcp-config.json"));
  const installer = copilotInstaller({});
  installer.install(ctxFor(home));
  assert.ok(JSON.parse(readFileSync(real, "utf8")).mcpServers.agentsocks);
  installer.uninstall(ctxFor(home));
  assert.equal(lstatSync(join(copilot, "mcp-config.json")).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), {});
});

test("OpenCode will not overwrite a plugin file it cannot read, and writes through a symlinked plugin file", () => {
  const home = tempDir("opencode-fix-");
  const plugins = join(home, ".config", "opencode", "plugins");
  mkdirSync(plugins, { recursive: true });
  const file = join(plugins, "agentsocks.js");
  writeFileSync(file, "// the user's own file\n");
  chmodSync(file, 0o000);
  const installer = opencodeInstaller(() => ({}));
  assert.throws(() => installer.install(ctxFor(home)), /cannot be read/);
  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, "utf8"), "// the user's own file\n");

  const other = tempDir("opencode-link-");
  const real = join(other, "agentsocks.js");
  const link = join(home, ".config", "opencode", "plugins", "agentsocks.js");
  writeFileSync(real, "// agentsocks:managed opencode-plugin (old)\n");
  spawnSync("rm", ["-f", link]);
  symlinkSync(real, link, "file");
  installer.install(ctxFor(home));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.match(readFileSync(real, "utf8"), /^\/\/ agentsocks:managed opencode-plugin/);
  assert.notEqual(readFileSync(real, "utf8"), "// agentsocks:managed opencode-plugin (old)\n");
});

test("a HOME that is empty or relative wires nothing and says so, instead of writing under the current directory", async () => {
  const saved = process.env.HOME;
  const cwd = process.cwd();
  const work = tempDir("agentsocks-relhome-");
  process.chdir(work);
  try {
    for (const home of ["", "relative/home"]) {
      process.env.HOME = home;
      assert.throws(() => agentContext(false, []), /not an absolute path/);
      const log: string[] = [];
      installAgents(["cursor", "gemini"], false, log);
      assert.match(log.join("\n"), /agents: not wired \(HOME is .* not an absolute path/);
      assert.deepEqual(agentReports(), []);
    }
    assert.equal(existsSync(join(work, ".cursor")), false);
    assert.equal(existsSync(join(work, "relative")), false);
  } finally {
    process.chdir(cwd);
    process.env.HOME = saved;
  }
});

test("a flag install does not know is an error, not a full install; naming an agent whose file cannot be edited exits 1", () => {
  const home = tempDir("agentsocks-exit-");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), "{ this is not json");
  const env = { ...process.env, ...shimmedEnv(), HOME: home, NODE_NO_WARNINGS: "1", AGENTSOCKS_STATE_DIR: tempDir("ass-"), AGENTSOCKS_RUNTIME_DIR: tempDir("asr-") };
  const typo = spawnSync(process.execPath, [cli, "install", "--dry-run", "--hermess"], { env, encoding: "utf8" });
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /install does not take --hermess/);
  const bad = spawnSync(process.execPath, [cli, "install", "--cursor"], { env, encoding: "utf8" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /cursor is not wired/);
  assert.equal(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"), "{ this is not json");
  const unknownUninstall = spawnSync(process.execPath, [cli, "uninstall", "--oops"], { env, encoding: "utf8" });
  assert.equal(unknownUninstall.status, 1);
});

async function withCodexHome<T>(codex: string, run: () => Promise<T> | T): Promise<T> {
  const saved = { codex: process.env.CODEX_HOME, path: process.env.PATH, home: process.env.HOME };
  process.env.CODEX_HOME = codex;
  process.env.PATH = tempDir("agentsocks-nopath-"); // no codex, so the config is edited directly
  process.env.HOME = tempDir("agentsocks-home-");
  try {
    return await run();
  } finally {
    process.env.CODEX_HOME = saved.codex;
    process.env.PATH = saved.path;
    process.env.HOME = saved.home;
  }
}

test("an install from before the approval setting gets that one line added in place when Codex's config API is not there", async () => {
  const codex = tempDir("agentsocks-upgrade-");
  const config = join(codex, "config.toml");
  await withCodexHome(codex, async () => {
    await install({ claude: false, codexMcp: true, codexHooks: false, trustHooks: false, dryRun: false, agents: [] });
    const fresh = readFileSync(config, "utf8");
    assert.match(fresh, /default_tools_approval_mode = "approve"/);
    const old = `${fresh.replace('default_tools_approval_mode = "approve"\n', "")}\n[mcp_servers.agentsocks.tools.send_message]\napproval = true\n`;
    writeFileSync(config, old);
    const log = await install({ claude: false, codexMcp: true, codexHooks: false, trustHooks: false, dryRun: false, agents: [] });
    assert.match(log.join("\n"), /added default_tools_approval_mode/);
    const upgraded = readFileSync(config, "utf8");
    assert.equal(upgraded.match(/default_tools_approval_mode/g)?.length, 1);
    assert.ok(upgraded.indexOf("default_tools_approval_mode") < upgraded.indexOf("[mcp_servers.agentsocks.env]") || !upgraded.includes("[mcp_servers.agentsocks.env]"));
    assert.ok(upgraded.includes("[mcp_servers.agentsocks.tools.send_message]\napproval = true"), "the rest of the table stays");
    writeFileSync(config, upgraded.replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "prompt"'));
    await install({ claude: false, codexMcp: true, codexHooks: false, trustHooks: false, dryRun: false, agents: [] });
    assert.match(readFileSync(config, "utf8"), /default_tools_approval_mode = "prompt"/, "a value the user chose is kept");
    writeFileSync(config, upgraded.replace('default_tools_approval_mode = "approve"', `"default_tools_approval_mode" = 'prompt'`));
    const quoted = await install({ claude: false, codexMcp: true, codexHooks: false, trustHooks: false, dryRun: false, agents: [] });
    assert.ok(!quoted.failed, quoted.join("\n"));
    assert.equal(readFileSync(config, "utf8").match(/default_tools_approval_mode/g)?.length, 1, "a quoted key is the same key: no second one");
  });
});

test("a Codex file that cannot be read does not stop the other agents from being wired or unwired, and the run still fails", async () => {
  const codex = tempDir("agentsocks-badcodex-");
  writeFileSync(join(codex, "hooks.json"), "{ not json");
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codex;
  const home = tempDir("agentsocks-home-ok-");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".cursor"));
  try {
    const log = await install({ claude: false, codexMcp: false, codexHooks: true, trustHooks: false, dryRun: false, agents: ["cursor"] });
    assert.equal(log.failed, true);
    assert.match(log.join("\n"), /error: /);
    assert.ok(existsSync(join(home, ".cursor", "mcp.json")), "Cursor was still wired");
    const out = uninstall(false);
    assert.equal(out.failed, true);
    assert.equal(existsSync(join(home, ".cursor", "mcp.json")), false, "and still unwired");
  } finally {
    process.env.CODEX_HOME = saved;
    process.env.HOME = savedHome;
  }
});
