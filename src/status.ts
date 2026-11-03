import { agentFieldOf, type InboxAgentId } from "./agents/types.ts";
import { listClaudeSessions, type ClaudeSession } from "./claude.ts";
import { squash } from "./limits.ts";
import { NON_INTERRUPT_RULES } from "./router.ts";
import { ACTIVE_STATUSES, STALE_TASK_MS, UNACCEPTED_TASK_MS } from "./tasks.ts";
import type { OutboxRow, Store, ThreadRow } from "./store.ts";
import { decodeAddress, encodeAddress } from "./envelope.ts";
import { canonicalPath, threadSocketPath } from "./paths.ts";

export const UNREAD_DRIFT_MS = 5 * 60_000;
export const BUSY_QUIET_DRIFT_MS = 15 * 60_000;
const REPLY_WINDOW_MS = 30 * 60_000;

export interface PeerRef {
  kind: "claude" | "codex";
  addr: string;
  name: string;
  thread?: ThreadRow;
  session?: ClaudeSession;
}

export interface Drift {
  code: "idle-with-unread" | "task-unaccepted" | "task-stale" | "busy-without-activity";
  detail: string;
}

export interface WakeState {
  lastAccepted: number | null;
  failedAt: number | null;
  error: string | null;
  failures: number;
}

export interface PeerStatus {
  peer: { name: string; kind: "claude" | "codex" | "remote"; agent?: string; addr: string; driver?: string };
  desired: {
    openTasks: { id: string; title: string; status: string; updatedAt: number }[];
    unreadMessages: number;
    heldDigests: number;
  };
  actual: {
    state: string;
    currentTask: string | null;
    lastTool: string | null;
    lastActivity: number | null;
    lastShown: number | null;
    lastReply: number | null;
    wake?: WakeState;
  };
  drift: Drift[];
}

export function wakeState(t: ThreadRow): WakeState {
  const accepted = [...(JSON.parse(t.wake_log) as number[]), ...(JSON.parse(t.exempt_wake_log) as number[])];
  return { lastAccepted: accepted.length ? Math.max(...accepted) : null, failedAt: t.wake_failed_at ?? null, error: t.wake_error ?? null, failures: t.wake_failures ?? 0 };
}

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

export const driverOfThread = (store: Store, t: ThreadRow | undefined): { addr: string; name: string } | undefined => {
  if (!t || !t.driver_addr) return undefined;
  const sid = t.driver_sid ?? null;
  if (sid !== null && sid.startsWith("session:")) {
    const live = listClaudeSessions().find((s) => s.sessionId === sid.slice("session:".length));
    if (live) return { addr: encodeAddress(live.socketPath), name: live.name };
  } else if (sid !== null && sid.startsWith("thread:")) {
    const live = store.listThreads().find((u) => u.thread_id === sid.slice("thread:".length));
    if (live) return { addr: t.driver_addr, name: live.name };
  }
  const path = decodeAddress(t.driver_addr);
  if (path) {
    const want = canonicalPath(path);
    const live = store.listThreads().find((u) => canonicalPath(threadSocketPath(u.thread_id)) === want);
    if (live) return { addr: t.driver_addr, name: live.name };
    const session = listClaudeSessions().find((s) => canonicalPath(s.socketPath) === want);
    if (session) return { addr: t.driver_addr, name: session.name };
  }
  return { addr: t.driver_addr, name: t.driver_name ?? t.driver_addr };
};

export function peerStatus(store: Store, ref: PeerRef, now: number, visible?: readonly string[]): PeerStatus {
  const session = ref.kind === "codex" ? ref.thread?.thread_id : ref.session?.sessionId;
  const tasks = store.listTasks({ party: ref.addr, ...(session && { session }), role: "assignee", statuses: [...ACTIVE_STATUSES] });
  const sent = store.deliveryTimes(ref.addr);
  let unread: number;
  let oldestUnread: number | null;
  let held: number;
  let state: string;
  let lastActivity: number | null;
  let hookActivity: number | null = null;
  let currentTask: string | null = null;
  let lastTool: string | null = null;

  if (ref.kind === "codex" && ref.thread) {
    const t = ref.thread;
    unread = store.queuedCount(t.thread_id, false);
    oldestUnread = store.oldestUnread(t.thread_id);
    held = store.heldSummary(t.thread_id).count;
    state = t.state;
    hookActivity = t.last_activity;
    lastActivity = t.last_activity ?? t.last_seen;
    currentTask = t.current_task ? squash(t.current_task, 100) : null;
    lastTool = t.last_tool;
  } else {
    const pending = store.unseenOutbox(ref.addr, now - 24 * 3_600_000);
    unread = pending.length;
    oldestUnread = pending.length ? Math.min(...pending.map((r) => r.sent_at ?? r.created_at)) : null;
    held = store.heldCount(ref.addr);
    state = ref.session?.status ?? (ref.session ? "running" : "unknown");
    lastActivity = ref.session?.updatedAt ?? null;
  }

  const drift: Drift[] = [];
  if (state === "idle" && unread > 0 && oldestUnread !== null && now - oldestUnread > UNREAD_DRIFT_MS) {
    drift.push({ code: "idle-with-unread", detail: `${unread} unread, the oldest ${minutes(now - oldestUnread)} old, while the session is idle` });
  }
  for (const t of tasks) {
    if (t.status === "open" && now - t.created_at > UNACCEPTED_TASK_MS) {
      drift.push({ code: "task-unaccepted", detail: `${t.id} is still open ${minutes(now - t.created_at)} after it was created, not accepted yet` });
    }
    if ((t.status === "accepted" || t.status === "in_progress") && now - t.updated_at > STALE_TASK_MS) {
      drift.push({ code: "task-stale", detail: `${t.id} has been ${t.status.replace("_", " ")} with no update for ${minutes(now - t.updated_at)}` });
    }
  }
  if (state === "busy" && hookActivity !== null && now - hookActivity > BUSY_QUIET_DRIFT_MS) {
    drift.push({ code: "busy-without-activity", detail: `busy with no hook activity for ${minutes(now - hookActivity)}` });
  }

  const driver = driverOfThread(store, ref.thread);
  const shown = driver !== undefined && (visible === undefined || visible.includes(driver.name)) ? driver : undefined;
  return {
    peer: { name: ref.name, kind: ref.kind, ...(ref.thread && ref.thread.agent !== "codex" && { agent: ref.thread.agent }), addr: ref.addr, ...(shown && { driver: shown.name }) },
    desired: {
      openTasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, updatedAt: t.updated_at })),
      unreadMessages: unread,
      heldDigests: held,
    },
    actual: { state, currentTask, lastTool, lastActivity, lastShown: sent.shown, lastReply: sent.replied, ...(ref.kind === "codex" && ref.thread && { wake: wakeState(ref.thread) }) },
    drift,
  };
}

export interface MessageWake {
  accepted: number;
  unread: boolean;
  receiver: WakeState;
}

export type MessageRecord = Omit<OutboxRow, "body" | "decision"> & { bodyChars: number; decision: unknown; to_agent?: InboxAgentId; wake?: MessageWake };

export function messageStatus(row: OutboxRow, store?: Store): MessageRecord {
  const { body, decision, ...rest } = row;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(decision);
  } catch {}
  const { agent } = agentFieldOf(row.to_thread);
  const message = store && row.to_thread ? store.messageByMsgId(row.to_thread, row.msg_id) : undefined;
  const thread = message && row.to_thread ? store?.getThread(row.to_thread) : undefined;
  const wake = message && thread ? { accepted: message.wakes, unread: message.state === "queued" || message.state === "notified", receiver: wakeState(thread) } : undefined;
  return { ...rest, bodyChars: row.body_chars ?? body.length, decision: parsed, ...(agent && { to_agent: agent }), ...(wake && { wake }) };
}

export interface StatRow {
  from_addr: string | null;
  to_addr: string;
  to_name: string;
  to_kind: "claude" | "codex";
  to_thread?: string | null;
  route: "now" | "pause" | "digest" | "merge";
  status: string;
  urgency: string;
  rule: string | null;
  created_at: number;
  sent_at: number | null;
  shown_at: number | null;
  replied_at: number | null;
}

export interface DestinationStats {
  to: { name: string; kind: "claude" | "codex"; agent?: InboxAgentId; addr: string };
  messages: number;
  routes: { now: number; pause: number; digest: number; merge: number };
  medianMsToShown: number | null;
  medianMsToReply: number | null;
  interruptPrecision: { interrupts: number; matured: number; repliedWithin30m: number; precision: number | null };
  escalations: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const delivered = (r: StatRow): boolean => r.status !== "refused" && r.status !== "failed";

const interrupted = (r: StatRow): boolean => r.route === "now" && !NON_INTERRUPT_RULES.includes(r.rule ?? "");

function pendingUntil(r: StatRow): number {
  if (r.route === "digest") return r.sent_at ?? Infinity;
  if (r.route === "pause") return r.shown_at ?? Infinity;
  return -Infinity;
}

export function computeStats(rows: StatRow[], now: number): DestinationStats[] {
  const byDestination = new Map<string, StatRow[]>();
  for (const row of rows) {
    const list = byDestination.get(row.to_addr);
    if (list) list.push(row);
    else byDestination.set(row.to_addr, [row]);
  }
  return [...byDestination.values()].map((all) => {
    const rows = all.filter(delivered).sort((a, b) => a.created_at - b.created_at);
    const last = rows.at(-1) ?? all[0]!;
    const routes = { now: 0, pause: 0, digest: 0, merge: 0 };
    const shown: number[] = [];
    const replies: number[] = [];
    let interrupts = 0;
    let matured = 0;
    let repliedWithin30m = 0;
    let escalations = 0;
    const pendingByHolder = new Map<string, number>();
    for (const r of rows) {
      routes[r.route]++;
      if (r.shown_at !== null) shown.push(r.shown_at - r.created_at);
      if (r.replied_at !== null) replies.push(r.replied_at - r.created_at);
      if (interrupted(r)) {
        interrupts++;
        if (r.replied_at !== null || now - r.created_at >= REPLY_WINDOW_MS) matured++;
        if (r.replied_at !== null && r.replied_at - r.created_at <= REPLY_WINDOW_MS) repliedWithin30m++;
      }
      const holder = r.from_addr ?? "";
      if (r.urgency !== "fyi" && (pendingByHolder.get(holder) ?? -Infinity) > r.created_at) escalations++;
      pendingByHolder.set(holder, Math.max(pendingByHolder.get(holder) ?? -Infinity, pendingUntil(r)));
    }
    return {
      to: { name: last.to_name, kind: last.to_kind, ...agentFieldOf(last.to_thread), addr: last.to_addr },
      messages: rows.length,
      routes,
      medianMsToShown: median(shown),
      medianMsToReply: median(replies),
      interruptPrecision: { interrupts, matured, repliedWithin30m, precision: matured ? Number((repliedWithin30m / matured).toFixed(3)) : null },
      escalations,
    };
  });
}
