import { createHash } from "node:crypto";
import { basename } from "node:path";
import { findOwnClaudeSession, listClaudeSessions, runsUnderClaude } from "./claude.ts";
import { brokerCall } from "./client.ts";
import { decodeAddress, encodeAddress, type Mode } from "./envelope.ts";
import { canonicalPath, inboxKind, threadSocketPath } from "./paths.ts";
import { recentCodexThreads, type CodexThreadInfo } from "./codexstate.ts";
import { cleanText, STALE_PEER_MS } from "./limits.ts";
import { localSessionMode } from "./modes.ts";
import type { RemotePeerInfo } from "./gateway/remote.ts";
import { kindLabel, threadIdFor, type AgentId } from "./agents/types.ts";

export type PeerKind = "claude" | "codex" | "remote";

export interface Peer {
  kind: PeerKind;
  agent?: string;
  name: string;
  ref: string;
  socketPath: string;
  session?: string;
  cwd?: string;
  status?: string;
  connected?: boolean;
  subagent?: boolean;
  via?: string;
  machine?: string;
  driver?: string;
}

export interface Me {
  kind: PeerKind | "cli";
  agent?: AgentId;
  name: string;
  socketPath?: string;
  session?: string;
  mode?: Mode;
}

interface ThreadInfo {
  threadId: string;
  name: string;
  cwd: string | null;
  mode: string | null;
  state: string;
  socketPath: string;
  lastSeen: number;
  subagent?: boolean;
  agent?: string;
  driver?: string;
}

const UNCONNECTED_WINDOW_MS = 12 * 3_600_000;
const MAX_UNCONNECTED = 50;
const UNCONNECTED_CACHE_MS = 5_000;
const STALE_STATUS = "stale";
export const NOT_CONNECTED = "not connected";
export const NOT_CONNECTED_NOTE = "not connected yet: a message wakes it and it reads with `agentsocks inbox`";
export const RELOAD_STEPS = "close every client attached to it (its terminal and any `codex agents` dashboard), wait 60 s with no turn running, then resume it";

function fullRef(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

const refKey = (p: Pick<Peer, "kind" | "socketPath" | "session">): string => (p.kind !== "claude" && p.session ? threadSocketPath(p.session) : p.socketPath);

function assignRefs(peers: Omit<Peer, "ref">[], taken: string[] = []): Peer[] {
  const hashes = peers.map((p) => fullRef(refKey(p)));
  let len = 6;
  while (len < 64 && (new Set(hashes.map((h) => h.slice(0, len))).size < hashes.length || hashes.some((h) => taken.some((t) => t.startsWith(h.slice(0, len)))))) len++;
  return peers.map((p, i) => ({ ...p, ref: hashes[i]!.slice(0, len) }));
}

export async function codexIdentity(threadId: string, cwd?: string): Promise<Me> {
  const t = await brokerCall<ThreadInfo>("register", { threadId, ...(cwd && { cwd }) });
  return { kind: "codex", name: t.name, socketPath: t.socketPath, session: threadId, mode: localSessionMode(t.mode) };
}

export async function agentIdentity(agent: AgentId, session: string, cwd?: string): Promise<Me> {
  const threadId = threadIdFor(agent, session);
  if (!threadId) throw new Error("that is not a session id agentsocks can use");
  const t = await brokerCall<ThreadInfo>("register", { threadId, agent, ...(cwd && { cwd }) });
  return { kind: "codex", agent, name: t.name, socketPath: t.socketPath, session: threadId, mode: localSessionMode(t.mode) };
}

export function claudeIdentity(): Me | undefined {
  const own = findOwnClaudeSession();
  if (!own) return undefined;
  return { kind: "claude", name: own.name, socketPath: own.socketPath, ...(own.sessionId && { session: own.sessionId }) };
}

export const callerIsAgent = (): boolean => !!process.env.CODEX_THREAD_ID || runsUnderClaude();

export const framesPeerText = (stdoutIsTTY: boolean, env: NodeJS.ProcessEnv = process.env, agent: () => boolean = callerIsAgent): boolean => env.AGENTSOCKS_FRAME === "1" || !stdoutIsTTY || agent();

export async function detectIdentity(): Promise<Me> {
  const thread = process.env.CODEX_THREAD_ID;
  if (thread) return codexIdentity(thread, process.cwd());
  const claude = claudeIdentity();
  if (claude) return claude;
  return { kind: "cli", name: `cli-${basename(process.cwd())}` };
}

export interface ListOptions {
  includeStale?: boolean;
  includeUnconnected?: boolean;
  includeSubagents?: boolean;
}

export const RESOLVABLE: ListOptions = { includeStale: true, includeUnconnected: true, includeSubagents: true };

export async function listPeers(opts: ListOptions = {}): Promise<Peer[]> {
  const claude = listClaudeSessions().map((s) => ({
    kind: "claude" as const,
    name: s.name,
    socketPath: s.socketPath,
    ...(s.sessionId && { session: s.sessionId }),
    ...(s.cwd && { cwd: s.cwd }),
    status: s.status ?? s.kind ?? "running",
  }));
  let threads: ThreadInfo[] = [];
  try {
    threads = await brokerCall<ThreadInfo[]>("list_threads");
  } catch {}
  const now = Date.now();
  const codex = threads
    .filter((t) => (opts.includeStale || now - t.lastSeen < STALE_PEER_MS) && (opts.includeSubagents || !t.subagent))
    .map((t) => ({
      kind: "codex" as const,
      ...(t.agent && t.agent !== "codex" && { agent: t.agent }),
      name: t.name,
      socketPath: t.socketPath,
      session: t.threadId,
      ...(t.cwd && { cwd: t.cwd }),
      ...(t.subagent && { subagent: true }),
      ...(t.driver && { driver: t.driver }),
      status: now - t.lastSeen >= STALE_PEER_MS ? STALE_STATUS : t.state,
    }));
  let remoteInfo: RemotePeerInfo[] = [];
  try {
    remoteInfo = await brokerCall<RemotePeerInfo[]>("list_remote_peers");
  } catch {}
  const remote = remoteInfo.map((r) => ({
    kind: "remote" as const,
    name: r.name,
    socketPath: r.socketPath,
    session: r.threadId,
    via: r.via,
    ...(r.machine && { machine: r.machine }),
    status: r.status,
  }));
  const connected = assignRefs([...claude, ...codex, ...remote]).map((p) => ({ ...p, connected: true }));
  if (!opts.includeUnconnected) return connected;
  return [...connected, ...(await unconnectedThreads(new Set(threads.map((t) => t.threadId)), connected, now))];
}

let recent: { at: number; threads: CodexThreadInfo[] } | undefined;

async function recentThreads(now: number): Promise<CodexThreadInfo[]> {
  const configured = Number(process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS);
  const ttl = process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS && Number.isFinite(configured) ? configured : UNCONNECTED_CACHE_MS;
  if (recent && now - recent.at < ttl) return recent.threads;
  const threads = await recentCodexThreads(now - UNCONNECTED_WINDOW_MS);
  recent = { at: now, threads };
  return threads;
}

async function unconnectedThreads(registered: ReadonlySet<string>, connected: Peer[], now: number): Promise<Peer[]> {
  const seen = (await recentThreads(now)).filter((t) => !registered.has(t.id)).slice(0, MAX_UNCONNECTED);
  const peers = seen.map((t) => ({
    kind: "codex" as const,
    name: cleanText(t.name, 64) || `codex-${t.id.slice(0, 8)}`,
    socketPath: threadSocketPath(t.id),
    session: t.id,
    ...(t.cwd && { cwd: cleanText(t.cwd, 200) }),
    status: NOT_CONNECTED,
  }));
  return assignRefs(peers, connected.map((p) => fullRef(refKey(p)))).map((p) => ({ ...p, connected: false }));
}

export class ResolveError extends Error {}

const withoutNote = (name: string): string => name.replace(/\s+\([^()]{1,24}\)$/, "");

export function resolvePeer(peers: Peer[], to: string, me?: Me, allowSelf = false): Peer {
  const raw = to.trim().replace(/^@/, "");
  if (!raw) throw new ResolveError("no recipient given");
  const notSelf = (p: Peer) => allowSelf || !me?.socketPath || p.socketPath !== me.socketPath;
  if (raw.startsWith("uds:")) {
    const path = canonicalPath(decodeAddress(raw)!);
    const known = peers.find((p) => canonicalPath(p.socketPath) === path || (p.kind === "codex" && p.session && canonicalPath(threadSocketPath(p.session)) === path));
    const peer = known ?? { kind: inboxKind(path) === "claude" ? "claude" : "codex", name: path, ref: fullRef(path).slice(0, 6), socketPath: path };
    if (!notSelf(peer as Peer)) throw new ResolveError("that address is your own inbox");
    return peer as Peer;
  }
  const lower = raw.toLowerCase();
  const sameName = peers.filter((p) => p.name.toLowerCase() === lower);
  const plainName = sameName.some((p) => !p.subagent) ? sameName.filter((p) => !p.subagent) : sameName;
  const byName = plainName.length > 0 ? plainName : peers.filter((p) => p.kind === "remote" && withoutNote(p.name).toLowerCase() === lower);
  const exact = [...peers.filter((p) => p.session === raw), ...byName];
  const sameRef = peers.filter((p) => p.ref === lower);
  const byRef = sameRef.length > 0 ? sameRef : /^[0-9a-f]{4,64}$/.test(lower) ? peers.filter((p) => fullRef(refKey(p)).startsWith(lower)) : [];
  const matches = [...new Set([...exact, ...byRef])].filter(notSelf);
  const live = matches.filter((p) => p.connected !== false && p.status !== STALE_STATUS);
  const candidates = live.length > 0 ? live : matches;
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const list = candidates.map((p) => `  ${p.name} [${p.ref}] (${kindLabel(p.kind, p.agent)})`).join("\n");
    throw new ResolveError(`"${to}" matches ${candidates.length} sessions. Re-send using the ref:\n${list}`);
  }
  if ([...exact, ...byRef].length > 0) throw new ResolveError("you cannot message yourself");
  const names = peers.filter(notSelf).map((p) => `${p.name} [${p.ref}]`).join(", ") || "none";
  throw new ResolveError(`no running session named "${to}". Live sessions: ${names}`);
}

export const replyAddress = (me: Me): string | undefined => (me.socketPath ? encodeAddress(me.socketPath) : undefined);
