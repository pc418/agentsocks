import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { audit } from "./audit.ts";
import { cleanText } from "./limits.ts";
import { claudeSessionsDir, configPath, killSwitchOn, stableCwd, stateDir } from "./paths.ts";
import { processStart, systemProc, validKillTarget } from "./procinfo.ts";

export const ENTRYPOINT = "agentsocks-codex";
export const ENV_FLAG = "AGENTSOCKS_CLAUDE_LISTAGENTS";
export const CONFIG_KEY = "claudeListAgents";

function resolveLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
    } catch {
      return path;
    }
  }
}

function writeAtomic(path: string, text: string): void {
  const target = resolveLinks(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {}
    throw err;
  }
}

function configObject(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object; fix or remove it and run this again`);
    return raw as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err instanceof SyntaxError ? new Error(`${path} is not valid JSON; fix or remove it and run this again`) : err;
  }
}

export function listAgentsEnabled(env: NodeJS.ProcessEnv = process.env, file: string = configPath()): boolean {
  if (env[ENV_FLAG] === "1") return true;
  try {
    return configObject(file)[CONFIG_KEY] === true;
  } catch {
    return false;
  }
}

export function enableListAgents(file: string = configPath()): boolean {
  const config = configObject(file);
  if (config[CONFIG_KEY] === true) return false;
  writeAtomic(file, `${JSON.stringify({ ...config, [CONFIG_KEY]: true }, null, 2)}\n`);
  return true;
}

export function disableListAgents(file: string = configPath()): boolean {
  const config = configObject(file);
  if (!(CONFIG_KEY in config)) return false;
  const rest = { ...config };
  delete rest[CONFIG_KEY];
  writeAtomic(file, `${JSON.stringify(rest, null, 2)}\n`);
  return true;
}

export interface Listing {
  threadId: string;
  name: string;
  cwd: string;
  socketPath: string;
  status?: "busy" | "idle";
}

export interface Deps {
  platform: NodeJS.Platform;
  dir: () => string;
  ledger: () => string;
  watchPid: number;
  limit: number;
  startOf: (pid: number) => string | undefined;
  spawnHolder: (watchPid: number) => number | undefined;
  signal: (pid: number) => void;
}

export interface Removed {
  threadId: string;
  pid: number;
  file: string;
}

interface Entry {
  threadId: string;
  pid: number;
  procStart: string;
  file: string;
  name: string;
  cwd: string;
  socketPath: string;
  status?: "busy" | "idle";
  startedAt: number;
  updatedAt: number;
  statusAt?: number;
}

// Claude keys its registry by pid and treats a record as live only while that pid is alive with the recorded start time, so each record needs a process of its own; this one costs about 1 MB and ends with the broker
const HOLDER_SCRIPT = 'while kill -0 "$1" 2>/dev/null; do sleep 5 || exit 0; done';
const MAX_LISTED = 12;
const REFRESH_MS = 3_600_000;
const RETRY_MS = 30_000;
const MAX_RECORD_BYTES = 256 * 1024;
const NAME_SLUG_CHARS = 32;

export function safePath(path: string | undefined): string {
  const kept = (path ?? "").split(":").filter((dir) => dir.startsWith("/"));
  return [...new Set([...kept, "/usr/bin", "/bin"])].join(":");
}

function holder(watchPid: number): number | undefined {
  try {
    const child = spawn("/bin/sh", ["-c", HOLDER_SCRIPT, "agentsocks-claudelist", String(watchPid)], {
      cwd: stableCwd(),
      stdio: "ignore",
      env: { PATH: safePath(process.env.PATH) },
    });
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } catch {
    return undefined;
  }
}

export function systemDeps(): Deps {
  return {
    platform: process.platform,
    dir: claudeSessionsDir,
    ledger: () => join(stateDir(), "claudelist.json"),
    watchPid: process.pid,
    limit: MAX_LISTED,
    startOf: (pid) => processStart(pid, "linux", systemProc),
    spawnHolder: holder,
    signal: (pid) => {
      if (!validKillTarget(pid)) return;
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    },
  };
}

const slug = (text: string, max: number): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");

export function registryName(name: string, threadId: string, idChars = 4): string {
  const base = slug(name, NAME_SLUG_CHARS) || "thread";
  const stem = base.startsWith("codex") ? base : `codex-${base}`;
  return `${stem}-${threadId.replace(/-/g, "").slice(-idChars)}`;
}

function assignNames(listings: Listing[]): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const l of listings) {
    const name = [4, 8, 32].map((chars) => registryName(l.name, l.threadId, chars)).find((candidate) => !taken.has(candidate)) ?? registryName(l.name, l.threadId, 32);
    taken.add(name);
    names.set(l.threadId, name);
  }
  return names;
}

const isEntry = (value: unknown): value is Entry => {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  const text = (k: string) => typeof e[k] === "string" && (e[k] as string).length > 0;
  const whole = (k: string) => Number.isSafeInteger(e[k]);
  const status = e.status === undefined || e.status === "busy" || e.status === "idle";
  const named = text("file") && whole("pid") && isAbsolute(e.file as string) && basename(e.file as string) === `${e.pid as number}.json`;
  return text("threadId") && text("procStart") && named && text("name") && text("cwd") && text("socketPath") && (e.pid as number) > 1 && whole("startedAt") && whole("updatedAt") && status;
};

function readLedger(path: string): Entry[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : undefined;
  }
  try {
    const raw: unknown = JSON.parse(text);
    const entries = raw && typeof raw === "object" ? (raw as { entries?: unknown }).entries : undefined;
    return Array.isArray(entries) && entries.every(isEntry) ? entries : undefined;
  } catch {
    return undefined;
  }
}

function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.unreadable-${Date.now()}`);
    audit("claude_list_ledger_unreadable", { ledger: path });
  } catch {}
}

function writeLedger(path: string, entries: Entry[]): void {
  if (entries.length === 0) {
    try {
      unlinkSync(path);
    } catch {}
    return;
  }
  writeAtomic(path, `${JSON.stringify({ version: 1, entries })}\n`);
}

// no pidDomain on purpose: Claude trusts a record from another domain without checking its pid
function recordText(e: Entry): string {
  return JSON.stringify({
    pid: e.pid,
    sessionId: e.threadId,
    cwd: e.cwd,
    name: e.name,
    startedAt: e.startedAt,
    updatedAt: e.updatedAt,
    procStart: e.procStart,
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    entrypoint: ENTRYPOINT,
    messagingSocketPath: e.socketPath,
    ...(e.status && { status: e.status, statusUpdatedAt: e.statusAt ?? e.updatedAt }),
  });
}

type Seen = "ours" | "missing" | "foreign";

function inspect(e: Entry): Seen {
  let fd: number;
  try {
    fd = openSync(e.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "foreign";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.size > MAX_RECORD_BYTES) return "foreign";
    const raw = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown> | null;
    return raw && raw.entrypoint === ENTRYPOINT && raw.pid === e.pid && raw.sessionId === e.threadId && raw.procStart === e.procStart ? "ours" : "foreign";
  } catch {
    return "foreign";
  } finally {
    closeSync(fd);
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function stage(file: string, text: string): string {
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  } catch (err) {
    discard(temp);
    throw err;
  }
  return temp;
}

// link(2) fails with EEXIST instead of replacing a record that is not ours, and a reader never sees a half-written file
function publish(file: string, text: string): void {
  const temp = stage(file, text);
  try {
    linkSync(temp, file);
  } finally {
    discard(temp);
  }
}

function replace(file: string, text: string): void {
  const temp = stage(file, text);
  try {
    renameSync(temp, file);
  } catch (err) {
    discard(temp);
    throw err;
  }
}

function dirProblem(dir: string): string | undefined {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return `${dir} does not exist, so Claude Code has no session registry here`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a real directory`;
  if (st.uid !== process.getuid?.()) return `${dir} is not owned by this user`;
  if ((st.mode & 0o077) !== 0) return `${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)})`;
  return undefined;
}

const holderAlive = (deps: Deps, e: Entry): boolean => deps.startOf(e.pid) === e.procStart;

function retire(deps: Deps, e: Entry): Removed | undefined {
  const seen = inspect(e);
  let removed: Removed | undefined;
  if (seen === "ours") {
    try {
      unlinkSync(e.file);
      removed = { threadId: e.threadId, pid: e.pid, file: e.file };
    } catch {}
  }
  if (holderAlive(deps, e)) deps.signal(e.pid);
  audit("claude_list_remove", { thread: e.threadId, pid: e.pid, record: removed ? "removed" : seen });
  return removed;
}

export function removeOurRecords(dir?: string, deps: Deps = systemDeps()): Removed[] {
  const path = deps.ledger();
  const all = readLedger(path);
  if (!all) return [];
  const mine = all.filter((e) => dir === undefined || resolve(dirname(e.file)) === resolve(dir));
  const removed = mine.flatMap((e) => retire(deps, e) ?? []);
  const rest = readLedger(path)?.filter((e) => !mine.some((m) => m.pid === e.pid && m.procStart === e.procStart));
  if (mine.length > 0 && rest) writeLedger(path, rest);
  return removed;
}

export class ClaudeList {
  private readonly deps: Deps;
  private readonly gaveUp = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private problem: string | undefined;
  private reclaimed = false;
  private closed = false;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  run(listings: () => Listing[], now: number): void {
    if (this.closed) return;
    if (!this.reclaimed) {
      this.reclaimed = true;
      if (readLedger(this.deps.ledger()) === undefined) quarantine(this.deps.ledger());
      removeOurRecords(undefined, this.deps);
    }
    if (this.deps.platform !== "linux" || killSwitchOn() || !listAgentsEnabled()) {
      removeOurRecords(undefined, this.deps);
      return;
    }
    this.sync(listings(), now);
  }

  close(): void {
    this.closed = true;
    removeOurRecords(undefined, this.deps);
  }

  private refuse(reason: string): void {
    if (reason !== this.problem) audit("claude_list_refused", { reason });
    this.problem = reason;
  }

  sync(listings: Listing[], now: number): void {
    const { deps } = this;
    const path = deps.ledger();
    const problem = dirProblem(deps.dir());
    if (problem) {
      this.refuse(problem);
      removeOurRecords(undefined, deps);
      return;
    }
    const before = readLedger(path);
    if (!before) {
      this.refuse(`${path} cannot be read, so nothing is changed until it is fixed or the broker restarts`);
      return;
    }
    this.problem = undefined;
    const listed = new Set(before.map((e) => e.threadId));
    const eligible = listings.map((l) => ({ ...l, cwd: cleanText(l.cwd, 200) })).filter((l) => l.cwd);
    const wanted = [...eligible.filter((l) => listed.has(l.threadId)), ...eligible.filter((l) => !listed.has(l.threadId))].slice(0, deps.limit);
    const want = new Map(wanted.map((l) => [l.threadId, l]));
    const names = assignNames(wanted);
    const kept: Entry[] = [];
    for (const entry of before) {
      const l = want.get(entry.threadId);
      const alive = holderAlive(deps, entry);
      const seen = l && alive ? inspect(entry) : undefined;
      if (l && alive && seen === "missing") {
        this.gaveUp.add(entry.threadId);
        audit("claude_list_gave_up", { thread: entry.threadId, pid: entry.pid });
      }
      if (!l || !alive || seen !== "ours" || l.socketPath !== entry.socketPath) {
        retire(deps, entry);
        if (l && (!alive || seen === "foreign")) this.retryAt.set(entry.threadId, now + RETRY_MS);
        continue;
      }
      kept.push(this.refreshed(entry, l, names.get(l.threadId)!, now));
    }
    if (JSON.stringify(before) !== JSON.stringify(kept)) writeLedger(path, kept);
    for (const l of wanted) {
      if (kept.some((e) => e.threadId === l.threadId) || this.gaveUp.has(l.threadId) || now < (this.retryAt.get(l.threadId) ?? 0)) continue;
      const created = this.create(l, names.get(l.threadId)!, now, kept);
      if (created) kept.push(created);
      else this.retryAt.set(l.threadId, now + RETRY_MS);
    }
  }

  private refreshed(entry: Entry, l: Listing, name: string, now: number): Entry {
    const changed = name !== entry.name || l.cwd !== entry.cwd || l.status !== entry.status;
    if (!changed && now - entry.updatedAt < REFRESH_MS) return entry;
    const next: Entry = { ...entry, name, cwd: l.cwd, updatedAt: now, ...(l.status !== entry.status && { statusAt: now }) };
    if (l.status) next.status = l.status;
    else delete next.status;
    try {
      replace(entry.file, recordText(next));
    } catch (err) {
      audit("claude_list_refused", { thread: entry.threadId, reason: (err as Error).message });
      return entry;
    }
    return next;
  }

  private create(l: Listing, name: string, now: number, kept: Entry[]): Entry | undefined {
    const { deps } = this;
    const pid = deps.spawnHolder(deps.watchPid);
    if (pid === undefined) return undefined;
    const procStart = deps.startOf(pid);
    if (procStart === undefined) {
      deps.signal(pid);
      return undefined;
    }
    const entry: Entry = { threadId: l.threadId, pid, procStart, file: join(deps.dir(), `${pid}.json`), name, cwd: l.cwd, socketPath: l.socketPath, startedAt: now, updatedAt: now, ...(l.status && { status: l.status, statusAt: now }) };
    try {
      // the ledger goes first so a crash between the two writes cannot leave a record that nothing names
      writeLedger(deps.ledger(), [...kept, entry]);
      publish(entry.file, recordText(entry));
    } catch (err) {
      deps.signal(pid);
      try {
        writeLedger(deps.ledger(), kept);
      } catch {}
      audit("claude_list_refused", { thread: l.threadId, pid, reason: (err as NodeJS.ErrnoException).code === "EEXIST" ? "a record that is not ours already has the holder's pid" : (err as Error).message });
      return undefined;
    }
    audit("claude_list_register", { thread: l.threadId, pid, name });
    return entry;
  }
}

export function statusLine(deps: Deps = systemDeps()): string {
  const label = "Claude ListAgents (experimental, untested live)";
  if (deps.platform !== "linux") return `${label}: not available on ${deps.platform} in this release.`;
  if (!listAgentsEnabled()) return `${label}: off. Turn it on with \`agentsocks install --claude-listagents\`.`;
  if (killSwitchOn()) return `${label}: on, paused by the kill switch, so no Codex thread is listed.`;
  const problem = dirProblem(deps.dir());
  if (problem) return `${label}: on, but nothing is listed because ${problem}.`;
  const entries = readLedger(deps.ledger());
  if (!entries) return `${label}: on, but ${deps.ledger()} cannot be read, so nothing is changed until it is fixed or the broker restarts.`;
  return `${label}: on, ${entries.length} Codex thread${entries.length === 1 ? "" : "s"} listed in ${deps.dir()}.`;
}
