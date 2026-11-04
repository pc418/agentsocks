import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const uid = (): number => process.getuid?.() ?? 0;

export function stableCwd(home: string = homedir()): string {
  try {
    if (home && statSync(home).isDirectory()) return home;
  } catch {}
  return "/";
}

export const PATH_ENV = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "AGENTSOCKS_RUNTIME_DIR",
  "AGENTSOCKS_STATE_DIR",
  "AGENTSOCKS_CONFIG",
  "AGENTSOCKS_CCSOCKS_DIR",
  "AGENTSOCKS_CLAUDE_SESSIONS_DIR",
  "AGENTSOCKS_CLAUDE_PROJECTS_DIR",
  "AGENTSOCKS_PROC_ROOT",
  "TS_SOCKET",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "COPILOT_HOME",
  "CURSOR_CONFIG_DIR",
  "GEMINI_CLI_HOME",
  "HERMES_HOME",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
] as const;

export const COMMAND_ENV = ["AGENTSOCKS_CODEX_BIN", "AGENTSOCKS_TAILSCALE_BIN"] as const;

export function anchoredEnv(env: NodeJS.ProcessEnv, base: string): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of PATH_ENV) {
    const value = out[name];
    if (value && !isAbsolute(value)) out[name] = resolve(base, value);
  }
  for (const name of COMMAND_ENV) {
    const value = out[name];
    if (value && value.includes("/") && !isAbsolute(value)) out[name] = resolve(base, value);
  }
  if (out.PATH !== undefined) out.PATH = out.PATH.split(":").map((dir) => (isAbsolute(dir) ? dir : resolve(base, dir))).join(":");
  return out;
}

export function callerDir(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

function absolute(path: string): string {
  if (isAbsolute(path)) return path;
  const here = callerDir();
  return here === undefined ? path : resolve(here, path);
}

export const RESOLVED_RUNTIME_DIR = "AGENTSOCKS_RESOLVED_RUNTIME_DIR";
export const RESOLVED_STATE_DIR = "AGENTSOCKS_RESOLVED_STATE_DIR";

export function brokerEnv(): NodeJS.ProcessEnv {
  const caller = callerDir();
  const resolved = { [RESOLVED_RUNTIME_DIR]: runtimeDir(), [RESOLVED_STATE_DIR]: stateDir() };
  return { ...(caller === undefined ? process.env : anchoredEnv(process.env, caller)), ...resolved };
}

export interface SocketContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  uid: number;
  tmpdir: string;
  standardRuntime?: string;
}

const SHORT_SOCKET_BYTES = 103;
const LONGEST_PLAIN_THREAD_ID = 36;
const LONGEST_THREAD_ID = "x".repeat(LONGEST_PLAIN_THREAD_ID);
const HEX_NAME_PROBE = `a${"0".repeat(15)}.sock`;

const socketBytes = (platform: NodeJS.Platform): number => (platform === "linux" || platform === "android" ? 107 : SHORT_SOCKET_BYTES);

const fits = (path: string, platform: NodeJS.Platform): boolean => Buffer.byteLength(path) <= socketBytes(platform);

const tmpBase = (c: SocketContext): string => (c.env.TERMUX_VERSION && c.env.PREFIX ? join(c.env.PREFIX, "tmp") : "/tmp");

export function runtimeDirFor(c: SocketContext): string {
  const base = c.env.XDG_RUNTIME_DIR || c.standardRuntime;
  const short = join(tmpBase(c), `agentsocks-${c.uid}`);
  if (base) {
    const dir = join(base, "agentsocks");
    return fits(join(dir, "broker.sock"), c.platform) ? dir : short;
  }
  const inTmpdir = join(c.tmpdir, `agentsocks-${c.uid}`);
  return c.platform !== "darwin" || fits(join(inTmpdir, "t", `${LONGEST_THREAD_ID}.sock`), c.platform) ? inTmpdir : short;
}

export function claudeSocketDirs(c: SocketContext): string[] {
  const bases = c.env.XDG_RUNTIME_DIR ? [c.env.XDG_RUNTIME_DIR] : [...(c.standardRuntime ? [c.standardRuntime] : []), c.tmpdir];
  return [...new Set([...bases.map((base) => join(base, "cc-socks")), join(tmpBase(c), `cc-socks-${c.uid}`)])];
}

export function namespaceDirs(c: SocketContext): string[] {
  return claudeSocketDirs(c).filter((dir) => fits(join(dir, HEX_NAME_PROBE), c.platform));
}

function standardRuntimeDir(): string | undefined {
  const standard = `/run/user/${uid()}`;
  try {
    const st = lstatSync(standard);
    if (st.isDirectory() && st.uid === uid()) return standard;
  } catch {}
  return undefined;
}

function systemContext(): SocketContext {
  const looksUp = !process.env.XDG_RUNTIME_DIR && process.platform === "linux";
  const standardRuntime = looksUp ? standardRuntimeDir() : undefined;
  const xdg = process.env.XDG_RUNTIME_DIR;
  const env = xdg ? { ...process.env, XDG_RUNTIME_DIR: absolute(xdg) } : process.env;
  return { platform: process.platform, env, uid: uid(), tmpdir: absolute(tmpdir()), ...(standardRuntime && { standardRuntime }) };
}

export function runtimeDir(): string {
  const resolved = process.env[RESOLVED_RUNTIME_DIR];
  if (resolved) return resolved;
  const override = process.env.AGENTSOCKS_RUNTIME_DIR;
  return override ? absolute(override) : runtimeDirFor(systemContext());
}

export const brokerSocketPath = (): string => join(runtimeDir(), "broker.sock");

export const threadSocketName = (threadId: string): string =>
  threadId.length <= LONGEST_PLAIN_THREAD_ID ? `${threadId}.sock` : `h.${createHash("sha256").update(threadId).digest("hex").slice(0, 32)}.sock`;

export const threadSocketPath = (threadId: string): string => join(runtimeDir(), "t", threadSocketName(threadId));

function privateRealDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return !st.isSymbolicLink() && st.isDirectory() && st.uid === uid() && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

export function ccSocksDir(): string | undefined {
  const override = process.env.AGENTSOCKS_CCSOCKS_DIR;
  if (override) return fits(join(override, HEX_NAME_PROBE), process.platform) && privateRealDir(override) ? override : undefined;
  if (process.env.AGENTSOCKS_RUNTIME_DIR) return undefined;
  return namespaceDirs(systemContext()).find(privateRealDir);
}

export const codexHexName = (threadId: string): string =>
  `a${createHash("sha256").update(`${runtimeDir()}\0${threadId}`).digest("hex").slice(0, 15)}.sock`;

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

export function namespacedSocketPath(threadId: string): string | undefined {
  const dir = ccSocksDir();
  return dir ? join(dir, codexHexName(threadId)) : undefined;
}

export function stateDir(): string {
  const resolved = process.env[RESOLVED_STATE_DIR];
  if (resolved) return resolved;
  const override = process.env.AGENTSOCKS_STATE_DIR;
  if (override) return absolute(override);
  return absolute(join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentsocks"));
}

export const dbPath = (): string => join(stateDir(), "agentsocks.db");

export const auditLogPath = (): string => join(stateDir(), "audit.log");

export function claudeSessionsDir(): string {
  const override = process.env.AGENTSOCKS_CLAUDE_SESSIONS_DIR;
  if (override) return override;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
}

export function claudeProjectsDir(): string {
  const override = process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR;
  if (override) return override;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

const configDir = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentsocks");

export function configPath(): string {
  const override = process.env.AGENTSOCKS_CONFIG;
  if (override) return override;
  return join(configDir(), "config.json");
}

export const agentsocksEnvPath = (): string => join(configDir(), "env");

export const expandHome = (path: string): string => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export function killSwitchOn(): boolean {
  if (process.env.AGENTSOCKS_OFF === "1") return true;
  return existsSync(join(configDir(), "off"));
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to use ${dir}: not a real directory`);
  if (st.uid !== uid()) throw new Error(`refusing to use ${dir}: owned by uid ${st.uid}`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

const CC_SOCKS_DIR_NAME = /^cc-socks(?:-\d+)?$/;

export function inboxKind(raw: string): "codex" | "claude" | "agent" {
  const path = canonicalPath(raw);
  if (path.startsWith(`${canonicalPath(join(runtimeDir(), "t"))}/`)) return "codex";
  const parent = dirname(path);
  const dir = ccSocksDir();
  return (dir && parent === canonicalPath(dir)) || CC_SOCKS_DIR_NAME.test(basename(parent)) ? "claude" : "agent";
}
