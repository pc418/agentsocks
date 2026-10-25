import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { VERSION } from "./version.ts";
import { brokerCall, brokerUnavailable, cliEntry } from "./client.ts";
import { agentsocksEnvPath, claudeSessionsDir, configPath, dbPath, runtimeDir, stateDir } from "./paths.ts";
import { Store } from "./store.ts";
import { archiveGatewayState, disableGatewayState, gatewayState, type GatewayState } from "./gateway/state.ts";
import { funnelOffCommand, offCallTimeoutMs, runCommand, serveOffCommand } from "./gateway/expose.ts";
import { tailscaleBin } from "./gateway/tailscale.ts";
import { isBrokerArgs } from "./broker.ts";
import { pidAlive } from "./claude.ts";
import { buildHash, processArgs, validKillTarget } from "./procinfo.ts";
import { DEFAULT_CLASSIFIER, readKeyFile } from "./classifier.ts";
import { routingLine } from "./classifiercmd.ts";
import { AGENTS } from "./agents/index.ts";
import { disableListAgents, enableListAgents, listAgentsEnabled, removeOurRecords, statusLine as listAgentsStatus } from "./claudelist.ts";
import { HOOK_MARKER, onPath, shellQuote } from "./agents/files.ts";
import type { AgentSpec, AgentStatus, InboxAgentId, InstallContext } from "./agents/types.ts";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;
const SNAKE: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PostToolUse: "post_tool_use",
  Stop: "stop",
  SessionEnd: "session_end",
};
const MARKER = "agentsocks";

export interface InstallOptions {
  claude: boolean;
  codexMcp: boolean;
  codexHooks: boolean;
  trustHooks: boolean;
  dryRun: boolean;
  agents?: "detected" | readonly InboxAgentId[];
  claudeListAgents?: boolean;
  codexOptional?: boolean;
}

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

type HooksDoc = { hooks?: Record<string, HookGroup[]> };

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

export { shellQuote };

export function commandLine(...args: string[]): string[] {
  return [process.execPath, cliEntry(), ...args];
}

export function hookCommand(): string {
  return HOOK_MARKER + commandLine("hook", "codex").map(shellQuote).join(" ");
}

const LEGACY_HOOK = /agentsocks\/(?:dist|src)\/cli\.[jt]s["']?\s+["']?hook["']?\s+["']?codex["']?\s*$/;
const isOurHook = (h: HookHandler | undefined): boolean =>
  typeof h?.command === "string" && (h.command.startsWith(HOOK_MARKER) || LEGACY_HOOK.test(h.command));
const ourGroupIndex = (groups: HookGroup[] | undefined): number => (groups ?? []).findIndex((g) => g.hooks?.some(isOurHook));

export function backup(path: string, log: string[]): void {
  if (!existsSync(path)) return;
  const dir = join(stateDir(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, path.replace(/\//g, "_"));
  copyFileSync(path, target);
  log.push(`backup: ${path} -> ${target}`);
}

function hasCommand(cmd: string): boolean {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

function installClaude(o: InstallOptions, log: string[]): void {
  if (!hasCommand("claude")) {
    log.push("claude: not found on PATH, skipped");
    return;
  }
  const [node, cli] = commandLine();
  const args = ["mcp", "add", "-s", "user", MARKER, "-e", "NODE_NO_WARNINGS=1", "--", node!, cli!, "mcp", "--host", "claude"];
  const exists = spawnSync("claude", ["mcp", "get", MARKER], { encoding: "utf8" });
  if (exists.status === 0 && exists.stdout.includes(cli!)) {
    log.push("claude: MCP server 'agentsocks' already registered (user scope), unchanged");
    return;
  }
  if (o.dryRun) {
    log.push(`claude (dry run): claude ${args.join(" ")}`);
    return;
  }
  if (exists.status === 0) execFileSync("claude", ["mcp", "remove", "-s", "user", MARKER], { stdio: "ignore" });
  execFileSync("claude", args, { stdio: "ignore" });
  log.push(`claude: ${exists.status === 0 ? "updated" : "registered"} MCP server 'agentsocks' at user scope (new sessions pick it up)`);
}

export function mcpServerConfig() {
  const [node, cli] = commandLine();
  return {
    command: node!,
    args: [cli!, "mcp", "--host", "codex"],
    env: { NODE_NO_WARNINGS: "1" },
    env_vars: ["XDG_RUNTIME_DIR", "TMPDIR", "CLAUDE_CODE_TMPDIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"],
    startup_timeout_sec: 20,
    tool_timeout_sec: 300,
  };
}

export function codexMcpBlock(): string {
  const c = mcpServerConfig();
  const q = JSON.stringify;
  return (
    `\n[mcp_servers.${MARKER}]\ncommand = ${q(c.command)}\nargs = [${c.args.map((a) => q(a)).join(", ")}]\n` +
    `env = { NODE_NO_WARNINGS = "1" }\nenv_vars = [${c.env_vars.map((v) => q(v)).join(", ")}]\n` +
    `startup_timeout_sec = ${c.startup_timeout_sec}\ntool_timeout_sec = ${c.tool_timeout_sec}\n`
  );
}

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

export function removeAgentsocksTables(toml: string): { text: string; removed: number } {
  const lines = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  let removed = 0;
  for (const line of lines) {
    const header = line.match(TABLE_HEADER);
    if (header) {
      const name = header[1]!.replace(/\s+/g, "");
      skipping = name === `mcp_servers.${MARKER}` || name.startsWith(`mcp_servers.${MARKER}.`);
      if (skipping) {
        removed++;
        continue;
      }
    }
    if (!skipping) out.push(line);
  }
  return { text: out.join("\n"), removed };
}

const NO_TOMLLIB = 3;

// python3 older than 3.11 (the one macOS ships, Ubuntu 22.04's) has no tomllib, and that is "cannot tell", not "invalid"
export function validToml(path: string): boolean | undefined {
  const script = `import sys\ntry:\n  import tomllib\nexcept ImportError:\n  sys.exit(${NO_TOMLLIB})\ntomllib.load(open(sys.argv[1],'rb'))`;
  const r = spawnSync("python3", ["-c", script, path], { stdio: "ignore" });
  if (r.error || r.status === NO_TOMLLIB) return undefined;
  return r.status === 0;
}

class AppServer {
  private child: ChildProcess;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
        if (!waiter) continue;
        this.pending.delete(msg.id!);
        if (msg.error) waiter.reject(new Error(msg.error.message ?? "app-server error"));
        else waiter.resolve(msg.result);
      }
    });
    this.child.on("error", (err) => this.failAll(err));
    this.child.on("exit", () => this.failAll(new Error("codex app-server exited")));
  }

  private failAll(err: Error): void {
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
  }

  call<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async open(): Promise<void> {
    await this.call("initialize", { clientInfo: { name: "agentsocks", title: "agentsocks installer", version: VERSION } });
    this.child.stdin!.write(`${JSON.stringify({ method: "initialized" })}\n`);
  }

  close(): void {
    this.child.stdin!.end();
    this.child.kill();
  }
}

function agentsocksMcpBlock(toml: string): string | undefined {
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => /^\s*\[\s*mcp_servers\.agentsocks\s*\]/.test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TABLE_HEADER.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const STALE_AGENTSOCKS_CLI = /agentsocks[\\/](dist|src)[\\/]cli\.[jt]s/;

function staleAgentsocksCli(block: string): string | undefined {
  const candidates = block.match(/["']?[^\s"'[\],]*[\\/]+(?:dist|src)[\\/]cli\.[jt]s["']?/g) ?? [];
  for (let raw of candidates) {
    raw = raw.replace(/^["']/, "").replace(/["']$/, "");
    let name: unknown;
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(raw, "..", "..", "package.json"), "utf8"));
      name = pkg !== null && typeof pkg === "object" && "name" in pkg ? pkg.name : undefined;
    } catch {
      name = undefined;
    }
    if (name === "agentsocks") return raw;
    if (name === undefined && STALE_AGENTSOCKS_CLI.test(raw)) return raw;
  }
  return undefined;
}

 async function installCodexMcp(o: InstallOptions, log: string[]): Promise<void> {
  const path = join(codexHome(), "config.toml");
  if (o.dryRun) {
    log.push(`codex (dry run): set [mcp_servers.agentsocks] in ${path}:${codexMcpBlock()}`);
    return;
  }
  backup(path, log);
  if (hasCommand("codex")) {
    const server = new AppServer();
    try {
      await server.open();
      await server.call("config/value/write", { keyPath: `mcp_servers.${MARKER}`, value: mcpServerConfig(), mergeStrategy: "upsert" });
      log.push(`codex: set [mcp_servers.agentsocks] in ${path} through Codex's config API`);
      return;
    } catch (err) {
      log.push(`codex: config API unavailable (${(err as Error).message}); editing ${path} directly`);
    } finally {
      server.close();
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = agentsocksMcpBlock(current);
  if (block !== undefined) {
    if (block.includes(cliEntry())) {
      log.push(`codex: [mcp_servers.agentsocks] already present in ${path}; left as is`);
      return;
    }
    if (staleAgentsocksCli(block) !== undefined) {
      const { text } = removeAgentsocksTables(current);
      writeFileSync(path, `${text.replace(/\s*$/, "\n")}${codexMcpBlock()}`, { mode: 0o600 });
      if (validToml(path) === false) {
        writeFileSync(path, current, { mode: 0o600 });
        throw new Error(`codex config became invalid TOML after the edit; restored ${path}`);
      }
      log.push(`codex: updated [mcp_servers.agentsocks] in ${path} to this install`);
      return;
    }
    log.push(`codex: [mcp_servers.agentsocks] already present in ${path}; left as is`);
    return;
  }
  writeFileSync(path, `${current.replace(/\s*$/, "\n")}${codexMcpBlock()}`, { mode: 0o600 });
  if (validToml(path) === false) {
    writeFileSync(path, current, { mode: 0o600 });
    throw new Error(`codex config became invalid TOML after the edit; restored ${path}`);
  }
  log.push(`codex: wrote [mcp_servers.agentsocks] to ${path}`);
}

export function addCodexHooks(doc: HooksDoc): { doc: HooksDoc; added: string[]; updated: string[] } {
  const hooks = doc.hooks ?? {};
  const command = hookCommand();
  const added: string[] = [];
  const updated: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    const idx = ourGroupIndex(groups);
    const handler: HookHandler = { type: "command", command, timeout: event === "SessionEnd" ? 3 : 10 };
    if (idx === -1) {
      groups.push({ hooks: [handler] });
      added.push(`${event} -> group ${groups.length - 1}`);
    } else {
      const group = groups[idx]!;
      const h = group.hooks.findIndex(isOurHook);
      if (group.hooks[h]!.command !== command) {
        group.hooks[h] = handler;
        updated.push(`${event} (group ${idx})`);
      }
    }
    hooks[event] = groups;
  }
  return { doc: { ...doc, hooks }, added, updated };
}

export function ourHookKeys(hooksPath: string, doc: HooksDoc): string[] {
  return HOOK_EVENTS.map((event) => ({ event, idx: ourGroupIndex(doc.hooks?.[event]) }))
    .filter(({ idx }) => idx >= 0)
    .map(({ event, idx }) => {
      const hookIdx = doc.hooks![event]![idx]!.hooks.findIndex(isOurHook);
      return `${hooksPath}:${SNAKE[event]}:${idx}:${hookIdx}`;
    });
}

function installCodexHooks(o: InstallOptions, log: string[]): void {
  const path = join(codexHome(), "hooks.json");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  const { doc, added, updated } = addCodexHooks(JSON.parse(current));
  if (added.length === 0 && updated.length === 0) {
    log.push("codex: agentsocks hooks already present in hooks.json, unchanged");
    return;
  }
  if (o.dryRun) {
    log.push(`codex (dry run): ${path}: append ${added.join(", ") || "nothing"}; update ${updated.join(", ") || "nothing"}`);
    return;
  }
  backup(path, log);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  if (added.length) log.push(`codex: appended hook groups after existing ones in ${path}: ${added.join(", ")}`);
  if (updated.length) log.push(`codex: updated the agentsocks hook command in place: ${updated.join(", ")}`);
  if (!o.trustHooks) log.push("codex: the new hooks stay inactive until you trust them: run /hooks in Codex and approve the agentsocks entries.");
}

interface HookMetadata {
  key: string;
  currentHash: string;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
}

async function trustCodexHooks(o: InstallOptions, log: string[]): Promise<void> {
  const hooksPath = join(codexHome(), "hooks.json");
  if (!existsSync(hooksPath) || o.dryRun) return;
  const keys = ourHookKeys(hooksPath, JSON.parse(readFileSync(hooksPath, "utf8")));
  if (keys.length === 0) return;
  const server = new AppServer();
  try {
    await server.open();
    const list = async () =>
      (await server.call<{ data: { hooks: HookMetadata[] }[] }>("hooks/list", { cwds: [homedir()] })).data.flatMap((e) => e.hooks);
    const before = await list();
    let marked = 0;
    for (const key of keys) {
      const hook = before.find((h) => h.key === key);
      if (!hook) {
        log.push(`codex: Codex does not list hook ${key}; approve it in /hooks instead`);
        continue;
      }
      if (hook.trustStatus === "trusted") continue;
      await server.call("config/value/write", { keyPath: `hooks.state.${JSON.stringify(key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "upsert" });
      marked++;
    }
    const after = await list();
    const ok = keys.filter((k) => after.find((h) => h.key === k)?.trustStatus === "trusted").length;
    log.push(`codex: ${ok}/${keys.length} agentsocks hooks trusted${marked ? ` (${marked} marked trusted through Codex's own config API)` : ""}`);
  } catch (err) {
    log.push(`codex: could not record hook trust automatically (${(err as Error).message}); approve the agentsocks hooks in /hooks`);
  } finally {
    server.close();
  }
}

function binLink(): string {
  return join(homedir(), ".local", "bin", "agentsocks");
}

function installCli(o: InstallOptions, log: string[]): void {
  const link = binLink();
  if (!existsSync(join(homedir(), ".local", "bin"))) return;
  const target = cliEntry();
  let repointFrom: string | undefined;
  let exists = false;
  try {
    const st = lstatSync(link);
    exists = true;
    if (st.isSymbolicLink() && readlinkSync(link) === target) return;
    if (st.isSymbolicLink()) {
      const old = readlinkSync(link);
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(old, "..", "..", "package.json"), "utf8"));
        if (pkg !== null && typeof pkg === "object" && "name" in pkg && pkg.name === "agentsocks") repointFrom = old;
      } catch {}
    }
  } catch {}
  if (exists && repointFrom === undefined) {
    log.push(`cli: ${link} already exists and is not ours, left alone`);
    return;
  }
  if (o.dryRun) {
    log.push(repointFrom === undefined ? `cli (dry run): link ${link} -> ${target}` : `cli (dry run): re-point ${link} -> ${target} (was ${repointFrom})`);
    return;
  }
  if (repointFrom !== undefined) {
    unlinkSync(link);
    symlinkSync(target, link);
    log.push(`cli: re-pointed ${link} -> ${target} (was ${repointFrom}, an agentsocks build)`);
    return;
  }
  symlinkSync(target, link);
  log.push(`cli: linked ${link} -> ${target} (Codex sessions started before the install use it from their shell)`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function agentContext(dryRun: boolean, log: string[]): InstallContext {
  const home = homedir();
  if (!isAbsolute(home)) throw new Error(`HOME is "${home}", which is not an absolute path, so no agent's folder can be found`);
  return { dryRun, home, log, hasBinary: (name) => onPath(name), command: commandLine, backup: (path) => backup(path, log) };
}

export function installAgents(agents: NonNullable<InstallOptions["agents"]>, dryRun: boolean, log: string[], all: readonly AgentSpec[] = AGENTS): void {
  let ctx: InstallContext;
  try {
    ctx = agentContext(dryRun, log);
  } catch (err) {
    log.push(`agents: not wired (${(err as Error).message})`);
    return;
  }
  for (const spec of all) {
    const picked = agents !== "detected" && agents.includes(spec.id);
    if (agents === "detected" && !spec.installer.detect(ctx)) {
      log.push(`${spec.id}: not installed on this machine, skipped`);
      continue;
    }
    if (agents !== "detected" && !picked) continue;
    try {
      spec.installer.install(ctx);
    } catch (err) {
      log.push(`${spec.id}: not wired (${(err as Error).message})`);
    }
  }
}

export function uninstallAgents(dryRun: boolean, log: string[], all: readonly AgentSpec[] = AGENTS): void {
  let ctx: InstallContext;
  try {
    ctx = agentContext(dryRun, log);
  } catch {
    return;
  }
  for (const spec of all) {
    try {
      spec.installer.uninstall(ctx);
    } catch (err) {
      log.push(`${spec.id}: could not finish removing its entries (${(err as Error).message})`);
    }
  }
}

function installListAgents(dryRun: boolean, log: string[]): void {
  if (dryRun) {
    log.push(`claude listagents (dry run): would set claudeListAgents in ${configPath()}; the broker would then write one record per live Codex thread into ${claudeSessionsDir()}`);
    return;
  }
  try {
    log.push(enableListAgents() ? `claude listagents: set claudeListAgents in ${configPath()}; the running broker picks it up within a few seconds` : "claude listagents: already on, unchanged");
  } catch (err) {
    log.push(`claude listagents: not turned on (${(err as Error).message})`);
    return;
  }
  log.push(`claude listagents: experimental and untested live. It writes records into ${claudeSessionsDir()} for the Codex threads this broker serves, and removes them when a thread ends or the broker stops. Turn it off with \`agentsocks uninstall\`.`);
  log.push(listAgentsStatus());
}

function uninstallListAgents(dryRun: boolean, log: string[]): void {
  if (dryRun) {
    if (listAgentsEnabled()) log.push("claude listagents (dry run): would turn it off and remove the records it wrote");
    return;
  }
  try {
    const off = disableListAgents();
    const removed = removeOurRecords();
    if (off) log.push(`claude listagents: removed claudeListAgents from ${configPath()}`);
    if (process.env.AGENTSOCKS_CLAUDE_LISTAGENTS === "1") log.push("claude listagents: AGENTSOCKS_CLAUDE_LISTAGENTS=1 is set in this environment and keeps it on for a broker started from it; unset it");
    if (removed.length > 0) log.push(`claude listagents: removed ${removed.length} registry record${removed.length === 1 ? "" : "s"} it had written (${removed.map((r) => r.file).join(", ")})`);
  } catch (err) {
    log.push(`claude listagents: could not finish turning it off (${(err as Error).message})`);
  }
}

export interface AgentReport {
  id: InboxAgentId;
  live: AgentSpec["live"];
  status: AgentStatus;
}

export function agentReports(all: readonly AgentSpec[] = AGENTS): AgentReport[] {
  let ctx: InstallContext;
  try {
    ctx = agentContext(true, []);
  } catch {
    return [];
  }
  return all.map((spec) => {
    try {
      return { id: spec.id, live: spec.live, status: spec.installer.status(ctx) };
    } catch (err) {
      return { id: spec.id, live: spec.live, status: { state: "partly wired" as const, detail: [`could not read its configuration: ${(err as Error).message}`] } };
    }
  });
}

export function entryHash(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}


export function differentBuildLine(entry: string, reportedBuild?: string): string | undefined {
  const mine = cliEntry();
  const mineHash = buildHash(dirname(mine));
  if (reportedBuild !== undefined && mineHash !== undefined && reportedBuild !== mineHash) {
    return entry === mine ? `running a different build than installed (rebuilt in place at ${mine}); run install again` : `running a different build than installed (${entry} vs ${mine}); run install again`;
  }
  if (entry === mine || !isAbsolute(entry)) return undefined;
  const theirHash = buildHash(dirname(entry));
  if (mineHash === undefined || theirHash === undefined || mineHash === theirHash) return undefined;
  return `running a different build than installed (${entry} vs ${mine}); run install again`;
}

export function runningBuildLine(pid: number, reportedBuild?: string): string | undefined {
  const args = processArgs(pid);
  if (!args || !isBrokerArgs(args)) return undefined;
  const entry = brokerEntry(args);
  return entry === undefined ? undefined : differentBuildLine(entry, reportedBuild);
}

function brokerEntry(args: string[]): string | undefined {
  const daemon = args.indexOf("daemon");
  const entry = daemon > 0 ? args[daemon - 1] : undefined;
  return entry !== undefined && /(^|\/)cli\.[jt]s$/.test(entry) ? entry : undefined;
}

async function runningBroker(): Promise<{ pid: number; version: string; build?: string } | undefined> {
  try {
    return await brokerCall("ping", {}, { autoStart: false, timeoutMs: 1500 });
  } catch {
    return undefined;
  }
}

async function terminateBroker(pid: number, version: string, log: string[], dryRun: boolean, why: string): Promise<void> {
  if (dryRun) {
    log.push(`broker (dry run): stop the v${version} daemon, pid ${pid}, ${why}`);
    return;
  }
  if (!validKillTarget(pid)) {
    log.push(`broker: refusing to stop pid ${String(pid)} reported by ping; stop it by hand`);
    return;
  }
  process.kill(pid, "SIGTERM");
  const lock = join(runtimeDir(), "broker.lock");
  for (let waited = 0; waited < 5000 && (pidAlive(pid) || existsSync(lock)); waited += 100) await sleep(100);
  log.push(
    pidAlive(pid)
      ? `broker: asked the v${version} daemon (pid ${pid}) to stop but it is still running; stop it by hand`
      : `broker: stopped the v${version} daemon (pid ${pid}); ${why}`,
  );
}

export async function stopOlderBroker(log: string[], dryRun: boolean): Promise<void> {
  const running = await runningBroker();
  if (!running) return;
  const args = processArgs(running.pid);
  if (!args || !isBrokerArgs(args)) {
    log.push(`broker: v${running.version} is running as pid ${running.pid} but that process does not look like an agentsocks daemon, so it was left alone`);
    return;
  }
  if (running.version === VERSION) {
    const entry = brokerEntry(args);
    if (entry === undefined || differentBuildLine(entry, running.build) === undefined) return;
    await terminateBroker(running.pid, running.version, log, dryRun, `it reports v${VERSION} but a different build, so the next command starts this one`);
    return;
  }
  await terminateBroker(running.pid, running.version, log, dryRun, `the next command starts v${VERSION}`);
}

export async function stopRunningBroker(log: string[], dryRun: boolean): Promise<void> {
  const running = await runningBroker();
  if (!running) return;
  const args = processArgs(running.pid);
  if (!args || !isBrokerArgs(args)) {
    log.push(`broker: v${running.version} is running as pid ${running.pid} but that process does not look like an agentsocks daemon, so it was left alone`);
    return;
  }
  await terminateBroker(running.pid, running.version, log, dryRun, "uninstall removes every running part");
}

async function installClaudeAndCodex(o: InstallOptions, log: string[]): Promise<void> {
  installCli(o, log);
  if (o.claude) installClaude(o, log);
  const codexMissing = o.codexOptional === true && (o.codexMcp || o.codexHooks) && !existsSync(codexHome()) && !onPath("codex");
  if (codexMissing) log.push("codex: not installed on this machine, skipped");
  if (o.codexMcp && !codexMissing) await installCodexMcp(o, log);
  if (o.codexHooks && !codexMissing) {
    installCodexHooks(o, log);
    if (o.trustHooks) await trustCodexHooks(o, log);
  }
}

function anyAgentPresent(): boolean {
  if (hasCommand("claude") || onPath("codex") || existsSync(codexHome())) return true;
  let ctx: InstallContext;
  try {
    ctx = agentContext(true, []);
  } catch {
    return false;
  }
  return AGENTS.some((spec) => {
    try {
      return spec.installer.detect(ctx);
    } catch {
      return false;
    }
  });
}

 export async function install(o: InstallOptions): Promise<RunLog> {
   const log: RunLog = [];
   try {
     await installClaudeAndCodex(o, log);
   } catch (err) {
     log.push(`error: ${(err as Error).message}`);
     log.failed = true;
   }
   if (o.agents) installAgents(o.agents, o.dryRun, log);
   if (o.claudeListAgents) installListAgents(o.dryRun, log);
   await stopOlderBroker(log, o.dryRun);
  if (!o.dryRun && !log.failed && !anyAgentPresent()) {
    log.push("error: install found neither Claude Code nor Codex on this machine: install the Claude Code CLI (`claude`) or the Codex CLI (`codex`) first, then run `agentsocks install` again");
    log.failed = true;
  }
   log.push(routingLine());
   return log;
 }

function onlyOurHooks(doc: HooksDoc): boolean {
  if (Object.keys(doc).some((key) => key !== "hooks")) return false;
  for (const groups of Object.values(doc.hooks ?? {})) {
    for (const group of groups) {
      if (!group.hooks.every((hook) => hook.type === "command" && hook.command === "true")) return false;
    }
  }
  return true;
}

 export function removeCodexHooks(doc: HooksDoc): { doc: HooksDoc; changed: boolean } {
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = doc.hooks?.[event];
    const idx = ourGroupIndex(groups);
    if (!groups || idx === -1) continue;
    const group = groups[idx]!;
    if (group.hooks.length > 1) {
      group.hooks = group.hooks.map((h) => (isOurHook(h) ? { type: "command", command: "true", timeout: 1 } : h));
    } else if (idx === groups.length - 1) {
      groups.pop();
    } else {
      groups[idx] = { hooks: [{ type: "command", command: "true", timeout: 1 }] };
    }
    changed = true;
  }
  return { doc, changed };
}

export type RunLog = string[] & { failed?: boolean };

function uninstallClaudeAndCodex(dryRun: boolean, log: string[]): void {
  try {
    const link = binLink();
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === cliEntry()) {
      if (!dryRun) unlinkSync(link);
      log.push(dryRun ? `cli: would remove ${link}` : `cli: removed ${link}`);
    }
  } catch {}
  if (hasCommand("claude") && spawnSync("claude", ["mcp", "get", MARKER], { stdio: "ignore" }).status === 0) {
    if (!dryRun) execFileSync("claude", ["mcp", "remove", "-s", "user", MARKER], { stdio: "ignore" });
    log.push(dryRun ? "claude: would remove MCP server 'agentsocks'" : "claude: removed MCP server 'agentsocks'");
  }
  const configPath = join(codexHome(), "config.toml");
  if (existsSync(configPath)) {
    const current = readFileSync(configPath, "utf8");
    const { text, removed } = removeAgentsocksTables(current);
    if (removed > 0) {
      if (!dryRun) backup(configPath, log);
      if (!dryRun && text.trim() === "") {
        unlinkSync(configPath);
        log.push(dryRun ? `codex: would remove ${configPath} (it holds only agentsocks entries)` : `codex: removed ${configPath} (it held only agentsocks entries)`);
      } else {
        if (!dryRun) {
          writeFileSync(configPath, text, { mode: 0o600 });
          if (validToml(configPath) === false) {
            writeFileSync(configPath, current, { mode: 0o600 });
            throw new Error(`codex config became invalid TOML after removal; restored ${configPath}`);
          }
        }
        log.push(dryRun ? `codex: would remove ${removed} agentsocks table${removed === 1 ? "" : "s"} from ${configPath}` : `codex: removed ${removed} agentsocks table${removed === 1 ? "" : "s"} from ${configPath}`);
      }
    }
  }
  const hooksPath = join(codexHome(), "hooks.json");
  if (existsSync(hooksPath)) {
    const { doc, changed } = removeCodexHooks(JSON.parse(readFileSync(hooksPath, "utf8")));
    if (changed) {
      if (!dryRun) backup(hooksPath, log);
      if (!dryRun && onlyOurHooks(doc)) {
        unlinkSync(hooksPath);
        log.push(dryRun ? `codex: would remove ${hooksPath} (it holds only agentsocks hooks)` : `codex: removed ${hooksPath} (it held only agentsocks hooks)`);
      } else {
        for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
          const kept = groups.filter((group) => group.hooks.length > 0);
          if (kept.length === 0) delete doc.hooks![event];
          else doc.hooks![event] = kept;
        }
        if (!dryRun) writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
        log.push(dryRun ? `codex: would remove agentsocks hooks from ${hooksPath} (other hooks keep their positions and trust)` : `codex: removed agentsocks hooks from ${hooksPath} (other hooks keep their positions and trust)`);
      }
    }
  }
}

export function uninstall(dryRun: boolean): RunLog {
  const log: RunLog = [];
  try {
    uninstallClaudeAndCodex(dryRun, log);
  } catch (err) {
    log.push(`error: ${(err as Error).message}`);
    log.failed = true;
  }
  uninstallAgents(dryRun, log);
  uninstallListAgents(dryRun, log);
  const envFile = agentsocksEnvPath();
  if (existsSync(envFile)) {
    const holds = readKeyFile(envFile, DEFAULT_CLASSIFIER.apiKeyEnv!) ? "holds" : "may hold";
    log.push(`key: ${envFile} ${holds} your TypeSafe key and is left in place (mode 600). To remove it: rm ${shellQuote(envFile)}`);
  }
  log.push(`history: your message history (database), audit.log and daemon.log stay in ${dirname(dbPath())}; delete the directory to remove everything`);
  return log;
}

interface GatewayUninstalled {
  stopped: { privateStopped: boolean; publicStopped: boolean; federationLinks: number; apiPeers: number; polls: number; serveUndone: boolean; funnelUndone: boolean };
  serveFailed: boolean;
  funnelFailed: boolean;
  disabled: number;
  archive: string;
}

function gatewaySettingsLive(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  let parsed: { enabled?: unknown; served?: unknown; exposed?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return parsed?.enabled === true || parsed?.served === true || parsed?.exposed === true;
}

function gatewayStateUsed(state: GatewayState): boolean {
  if (state.listPeers().length > 0 || state.hosts().length > 0) return true;
  if (gatewaySettingsLive(state.setting("private")) || gatewaySettingsLive(state.setting("public"))) return true;
  try {
    for (const table of ["gateway_tokens", "gateway_oauth_clients", "gateway_oauth_codes", "gateway_oauth_tokens", "gateway_pairings", "gateway_push"]) {
      const row: unknown = state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      if (row && typeof row === "object" && "n" in row && typeof row.n === "number" && row.n > 0) return true;
    }
  } catch {}
  return false;
}

function gatewayArchiveUsed(path: string): boolean {
  let dump: Record<string, unknown> = {};
  try {
    dump = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
  for (const [table, rows] of Object.entries(dump)) {
    if (!Array.isArray(rows)) continue;
    if (table === "gateway_settings") {
      if (rows.some((row) => row && typeof row === "object" && "value" in row && typeof row.value === "string" && gatewaySettingsLive(row.value))) return true;
      continue;
    }
    if (rows.length > 0) return true;
  }
  return false;
}

export async function uninstallGatewayState(dryRun: boolean): Promise<RunLog> {
  const log: RunLog = [];
  if (dryRun) {
    log.push(`gateway (dry run): would stop every gateway listener, link and API peer, undo any tailscale serve/funnel agentsocks set up, disable every token, grant and API peer, and archive the gateway state into ${join(stateDir(), "backups")} (never deleted)`);
    return log;
  }
  try {
    const done = await brokerCall<GatewayUninstalled>("gateway_uninstall", {}, { autoStart: false, timeoutMs: offCallTimeoutMs() });
    const s = done.stopped;
    const did = [s.privateStopped && "private listener", s.publicStopped && "public listener", s.federationLinks > 0 && `${s.federationLinks} federation link(s)`, s.apiPeers > 0 && `${s.apiPeers} API peer(s)`, s.polls > 0 && `${s.polls} in-flight request(s)`].filter(Boolean);
    log.push(`gateway: stopped ${did.length ? did.join(", ") : "nothing (it was not running)"}${s.serveUndone ? "; undid the tailscale serve agentsocks set up" : ""}${s.funnelUndone ? "; undid the tailscale funnel agentsocks set up" : ""}`);
    if (done.serveFailed) log.push("gateway: the tailscale serve-off command failed, so the served flag is kept; a later agentsocks gateway off or uninstall retries it");
    if (done.funnelFailed) log.push("gateway: the tailscale funnel-off command failed, so the exposed flag is kept; a later agentsocks gateway public off or uninstall retries it");
    if (gatewayArchiveUsed(done.archive)) {
      log.push(`gateway: disabled ${done.disabled} peer(s), so their tokens and grants stop working; state archived at ${done.archive}`);
    } else {
      try {
        unlinkSync(done.archive);
      } catch {}
      log.push(`gateway: disabled ${done.disabled} peer(s), so their tokens and grants stop working; the gateway was never used, so there is nothing to archive`);
    }
    return log;
  } catch (err) {
    if (!brokerUnavailable(err)) {
      log.push(`gateway: the broker could not stop the gateway (${(err as Error).message}); run agentsocks gateway off`);
      log.failed = true;
      return log;
    }
  }
  if (!existsSync(dbPath())) return log;
  const store = new Store(dbPath());
  try {
    const state = gatewayState(store);
    const flagOf = (key: string, flag: string): { on: boolean; port: number } => {
      try {
        const v = JSON.parse(state.setting(key) ?? "{}") as { port?: unknown; served?: unknown; exposed?: unknown };
        return { on: (flag === "served" ? v.served : v.exposed) === true, port: typeof v.port === "number" ? v.port : 0 };
      } catch {
        return { on: false, port: 0 };
      }
    };
    const env = { ...process.env, AGENTSOCKS_TAILSCALE_BIN: tailscaleBin() };
    const served = flagOf("private", "served");
    const exposed = flagOf("public", "exposed");
    const serveOk = !served.on || (served.port > 0 && (await runCommand(serveOffCommand(served.port), env)) === 0);
    const funnelOk = !exposed.on || (exposed.port > 0 && (await runCommand(funnelOffCommand(exposed.port), env)) === 0);
    const disabled = disableGatewayState(state);
    if (served.on && !serveOk) state.setSetting("private", JSON.stringify({ ...(JSON.parse(state.setting("private") ?? "{}") as Record<string, unknown>), enabled: false, served: true }));
    if (exposed.on && !funnelOk) state.setSetting("public", JSON.stringify({ ...(JSON.parse(state.setting("public") ?? "{}") as Record<string, unknown>), enabled: false, exposed: true }));
    if (served.on && serveOk) state.setSetting("private", JSON.stringify({ ...(JSON.parse(state.setting("private") ?? "{}") as Record<string, unknown>), served: false }));
    if (exposed.on && funnelOk) state.setSetting("public", JSON.stringify({ ...(JSON.parse(state.setting("public") ?? "{}") as Record<string, unknown>), exposed: false }));
    const undone: string[] = [];
    if (served.on && serveOk) undone.push("undid the tailscale serve agentsocks set up");
    if (exposed.on && funnelOk) undone.push("undid the tailscale funnel agentsocks set up");
    const kept: string[] = [];
    if (served.on && !serveOk) kept.push("tailscale serve");
    if (exposed.on && !funnelOk) kept.push("tailscale funnel");
    log.push(`gateway: no broker was running, so nothing was listening${undone.length ? `; ${undone.join("; ")}` : ""}${kept.length ? `; could not undo ${kept.join(" and ")} so the served/exposed flags are kept for a later uninstall` : ""}; disabled ${disabled} peer(s)${gatewayStateUsed(state) ? ` and archived the gateway state at ${archiveGatewayState(store.db, join(stateDir(), "backups"))}` : " and the gateway was never used, so there is nothing to archive"}`);
  } catch (err) {
    log.push(`gateway: could not disable the gateway state (${(err as Error).message})`);
    log.failed = true;
  } finally {
    store.close();
  }
  return log;
}

export function hookTrustStatus(): { event: string; key: string; present: boolean; trusted: boolean }[] {
  const hooksPath = join(codexHome(), "hooks.json");
  const configPath = join(codexHome(), "config.toml");
  if (!existsSync(hooksPath)) return [];
  const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as HooksDoc;
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const keys = new Map(ourHookKeys(hooksPath, doc).map((k) => [k.split(":").at(-3)!, k]));
  return HOOK_EVENTS.map((event) => {
    const key = keys.get(SNAKE[event]!) ?? `${hooksPath}:${SNAKE[event]}:-1:0`;
    const block = config.split(`[hooks.state.${JSON.stringify(key)}]`)[1]?.split(/\n\[/)[0] ?? "";
    return { event, key, present: keys.has(SNAKE[event]!), trusted: keys.has(SNAKE[event]!) && /trusted_hash\s*=/.test(block) };
  });
}
