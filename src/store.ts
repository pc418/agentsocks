import { chmodSync, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./paths.ts";
import { bodyHash } from "./limits.ts";
import { migrate } from "./migrations.ts";
import type { Route, Urgency } from "./router.ts";
import type { Risk, TaskStatus } from "./tasks.ts";
import type { StatRow } from "./status.ts";

export type ThreadState = "idle" | "busy" | "ended" | "unknown";

export interface ThreadRow {
  thread_id: string;
  name: string;
  cwd: string | null;
  mode: string | null;
  state: ThreadState;
  remote: string | null;
  created_at: number;
  last_seen: number;
  pending_wake_at: number | null;
  wake_log: string;
  exempt_wake_log: string;
  stop_streak: number;
  hooks_active: number;
  current_task: string | null;
  last_tool: string | null;
  last_activity: number | null;
  wake_hold_since: number | null;
  subagent: number | null;
  agent: string;
  driver_addr: string | null;
  driver_name: string | null;
  driver_sid: string | null;
  driver_instructed_at: number | null;
  name_explicit: number | null;
  wake_error: string | null;
  wake_failed_at: number | null;
  wake_failures: number;
}

export interface MessageRow {
  id: string;
  msg_id: string;
  to_thread: string;
  kind: "message" | "receipt";
  from_addr: string | null;
  from_name: string | null;
  from_kind: string | null;
  from_session: string | null;
  from_mode: string | null;
  body: string;
  received_at: number;
  state: "queued" | "notified" | "surfaced" | "held";
  surfaced_at: number | null;
  stop_blocked: number;
  wakes: number;
  route: Exclude<Route, "merge">;
  decision: string | null;
  body_hash: string | null;
  released_at: number | null;
}

export type NewMessage = Omit<MessageRow, "state" | "surfaced_at" | "stop_blocked" | "wakes" | "route" | "decision" | "body_hash" | "released_at"> & {
  route?: MessageRow["route"];
  decision?: string | null;
  held?: boolean;
};

export type OutboxStatus = "held" | "sent" | "shown" | "replied" | "merged" | "refused" | "failed";

export interface OutboxRow {
  id: string;
  msg_id: string;
  from_addr: string | null;
  from_name: string;
  from_kind: string;
  from_session: string | null;
  from_mode: string | null;
  to_addr: string;
  to_name: string;
  to_kind: "claude" | "codex";
  to_thread: string | null;
  to_session: string | null;
  body: string;
  urgency: Urgency;
  route: Route;
  decision: string;
  status: OutboxStatus;
  task_id: string | null;
  carrier_id: string | null;
  body_hash: string | null;
  body_chars: number | null;
  created_at: number;
  sent_at: number | null;
  shown_at: number | null;
  replied_at: number | null;
  error: string | null;
}

export type NewOutbox = Omit<OutboxRow, "carrier_id" | "sent_at" | "shown_at" | "replied_at" | "error" | "body_hash" | "body_chars"> &
  Partial<Pick<OutboxRow, "carrier_id" | "sent_at" | "error" | "body_hash" | "body_chars">>;

export interface RecentRow {
  msg_id: string;
  from_addr: string | null;
  from_name: string | null;
  body_hash: string | null;
  route: Route;
  rule: string | null;
  at: number;
  pending: number;
}

export interface TaskRow {
  id: string;
  from_addr: string;
  from_name: string;
  to_addr: string;
  to_name: string;
  to_kind: "claude" | "codex";
  title: string;
  body: string;
  acceptance: string | null;
  risk: Risk;
  external_ref: string | null;
  on_behalf_of: string | null;
  status: TaskStatus;
  result: string | null;
  evidence: string | null;
  from_session: string | null;
  to_session: string | null;
  request_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export const MAX_QUEUED_PER_THREAD = 200;
export const MAX_WAKES_PER_MESSAGE = 2;
const UNREAD = "state IN ('queued', 'notified')";
// held = a digest waiting for an idle moment: invisible to hooks, reads and wakes until released
const PENDING = "state IN ('queued', 'notified', 'held')";

export function renderedSize(m: Pick<MessageRow, "body" | "from_addr" | "from_name">): number {
  return m.body.length + (m.from_addr?.length ?? 0) + (m.from_name?.length ?? 0) + 200;
}

export function privateFile(path: string): void {
  if (!existsSync(path)) return;
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

 export class Store {
   readonly db: DatabaseSync;

   constructor(path: string) {
     if (path !== ":memory:") ensurePrivateDir(dirname(path));
     this.db = new DatabaseSync(path);
     this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) privateFile(file);
     migrate(this.db);
   }

  getThread(threadId: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as ThreadRow | undefined;
  }

  listThreads(includeEnded = false): ThreadRow[] {
    const sql = includeEnded
      ? "SELECT * FROM threads ORDER BY last_seen DESC"
      : "SELECT * FROM threads WHERE state != 'ended' ORDER BY last_seen DESC";
    return this.db.prepare(sql).all() as unknown as ThreadRow[];
  }

  upsertThread(threadId: string, fields: Partial<Omit<ThreadRow, "thread_id">>, defaultName: string, now = Date.now()): ThreadRow {
    const existing = this.getThread(threadId);
    if (!existing) {
      this.db
        .prepare("INSERT INTO threads (thread_id, name, cwd, mode, state, remote, subagent, agent, name_explicit, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(threadId, fields.name ?? defaultName, fields.cwd ?? null, fields.mode ?? null, fields.state ?? "unknown", fields.remote ?? null, fields.subagent ?? null, fields.agent ?? "codex", fields.name_explicit ?? null, now, now);
    } else {
      this.updateThread(threadId, { ...fields, last_seen: now });
    }
    return this.getThread(threadId)!;
  }

  updateThread(threadId: string, fields: Partial<Omit<ThreadRow, "thread_id">>): void {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE threads SET ${sets} WHERE thread_id = ?`).run(...(entries.map(([, v]) => v) as (string | number | null)[]), threadId);
  }

  enqueue(msg: NewMessage): { inserted: boolean; evicted: number } {
    if (this.db.prepare("SELECT 1 FROM messages WHERE to_thread = ? AND msg_id = ?").get(msg.to_thread, msg.msg_id)) {
      return { inserted: false, evicted: 0 };
    }
    let evicted = 0;
    if (this.pendingCount(msg.to_thread) >= MAX_QUEUED_PER_THREAD) {
      if (msg.kind === "receipt") return { inserted: false, evicted: 0 };
      const oldest = (where: string): { id: string } | undefined =>
        this.db.prepare(`SELECT id FROM messages WHERE to_thread = ? AND ${where} ORDER BY received_at ASC LIMIT 1`).get(msg.to_thread) as { id: string } | undefined;
      const victim = oldest("state = 'held'") ?? oldest(`${UNREAD} AND kind = 'receipt'`) ?? oldest(UNREAD);
      if (victim) {
        const gone = this.db.prepare("SELECT msg_id FROM messages WHERE id = ?").get(victim.id) as { msg_id: string };
        this.db.prepare("DELETE FROM messages WHERE id = ?").run(victim.id);
        this.db
          .prepare("UPDATE outbox SET status = 'failed', error = ? WHERE msg_id = ? AND to_thread = ? AND status IN ('held', 'sent')")
          .run("dropped: receiver inbox full", gone.msg_id, msg.to_thread);
        evicted = 1;
      }
    }
    this.db
      .prepare(
        `INSERT INTO messages (id, msg_id, to_thread, kind, from_addr, from_name, from_kind, from_session, from_mode, body, body_hash, received_at, route, decision, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.msg_id,
        msg.to_thread,
        msg.kind,
        msg.from_addr,
        msg.from_name,
        msg.from_kind,
        msg.from_session,
        msg.from_mode,
        msg.body,
        msg.kind === "message" ? bodyHash(msg.body) : null,
        msg.received_at,
        msg.route ?? "now",
        msg.decision ?? null,
        msg.held ? "held" : "queued",
      );
    return { inserted: true, evicted };
  }

  pendingCount(threadId: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE to_thread = ? AND ${PENDING}`).get(threadId) as { n: number }).n);
  }

  queuedCount(threadId: string, includeReceipts = true): number {
    const sql = includeReceipts
      ? `SELECT COUNT(*) AS n FROM messages WHERE to_thread = ? AND ${UNREAD}`
      : `SELECT COUNT(*) AS n FROM messages WHERE to_thread = ? AND ${UNREAD} AND kind = 'message'`;
    return Number((this.db.prepare(sql).get(threadId) as { n: number }).n);
  }

  peek(threadId: string, maxChars: number): { messages: MessageRow[]; remaining: number } {
    const unread = this.db
      .prepare(`SELECT * FROM messages WHERE to_thread = ? AND ${UNREAD} ORDER BY received_at ASC, id ASC`)
      .all(threadId) as unknown as MessageRow[];
    const picked: MessageRow[] = [];
    let used = 0;
    for (const m of unread) {
      const size = renderedSize(m);
      if (picked.length > 0 && used + size > maxChars) break;
      picked.push(m);
      used += size;
    }
    return { messages: picked, remaining: unread.length - picked.length };
  }

  markSurfaced(ids: string[], now = Date.now()): void {
    if (ids.length === 0) return;
    const mark = this.db.prepare(`UPDATE messages SET state = 'surfaced', surfaced_at = ? WHERE id = ? AND ${UNREAD}`);
    this.db.exec("BEGIN");
    try {
      for (const id of ids) mark.run(now, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  take(threadId: string, maxChars: number, now = Date.now()): { messages: MessageRow[]; remaining: number } {
    const r = this.peek(threadId, maxChars);
    this.markSurfaced(r.messages.map((m) => m.id), now);
    return r;
  }

  markNotified(threadId: string, opts: { skipPause?: boolean } = {}): { messages: number; receipts: number } {
    // a paused message waits for the end of the turn, so a mid-turn announcement skips it
    const scope = opts.skipPause ? " AND route != 'pause'" : "";
    const fresh = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM messages WHERE to_thread = ? AND state = 'queued'${scope} GROUP BY kind`)
      .all(threadId) as { kind: string; n: number }[];
    this.db.prepare(`UPDATE messages SET state = 'notified' WHERE to_thread = ? AND state = 'queued'${scope}`).run(threadId);
    return {
      messages: Number(fresh.find((r) => r.kind === "message")?.n ?? 0),
      receipts: Number(fresh.find((r) => r.kind === "receipt")?.n ?? 0),
    };
  }

  takeStopBlockable(threadId: string): number {
    const rows = this.db
      .prepare(`SELECT id FROM messages WHERE to_thread = ? AND ${UNREAD} AND kind = 'message' AND route != 'digest' AND stop_blocked = 0`)
      .all(threadId) as { id: string }[];
    if (rows.length > 0) {
      this.db.prepare(`UPDATE messages SET stop_blocked = 1, state = 'notified' WHERE to_thread = ? AND ${UNREAD} AND kind = 'message' AND route != 'digest' AND stop_blocked = 0`).run(threadId);
    }
    return rows.length;
  }

  wakeable(threadId: string): { id: string; exempt: number }[] {
    return this.db
      .prepare(
        `SELECT id, CASE WHEN json_extract(decision, '$.urgency') = 'urgent' OR json_extract(decision, '$.awaited') = 1 THEN 1 ELSE 0 END AS exempt
         FROM messages WHERE to_thread = ? AND ${UNREAD} AND kind = 'message' AND route != 'digest' AND wakes < ?`,
      )
      .all(threadId, MAX_WAKES_PER_MESSAGE) as unknown as { id: string; exempt: number }[];
  }

  messageByMsgId(threadId: string, msgId: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE to_thread = ? AND msg_id = ? AND kind = 'message'").get(threadId, msgId) as MessageRow | undefined;
  }

  bumpWakes(ids: string[]): void {
    const bump = this.db.prepare("UPDATE messages SET wakes = wakes + 1 WHERE id = ?");
    for (const id of ids) bump.run(id);
  }

  lastSurfaced(threadId: string): MessageRow | undefined {
    return this.db
      .prepare("SELECT * FROM messages WHERE to_thread = ? AND state = 'surfaced' AND kind = 'message' ORDER BY surfaced_at DESC LIMIT 1")
      .get(threadId) as MessageRow | undefined;
  }

  heldSummary(threadId: string): { count: number; oldest: number | null } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM messages WHERE to_thread = ? AND state = 'held'").get(threadId) as {
      n: number;
      oldest: number | null;
    };
    return { count: Number(r.n), oldest: r.oldest === null ? null : Number(r.oldest) };
  }

  releaseHeld(threadId: string, now = Date.now()): string[] {
    const ids = (this.db.prepare("SELECT msg_id FROM messages WHERE to_thread = ? AND state = 'held'").all(threadId) as { msg_id: string }[]).map((r) => r.msg_id);
    if (ids.length > 0) this.db.prepare("UPDATE messages SET state = 'queued', released_at = ? WHERE to_thread = ? AND state = 'held'").run(now, threadId);
    return ids;
  }

  recentInbox(threadId: string, since: number): RecentRow[] {
    return this.db
      .prepare(
        `SELECT msg_id, from_addr, from_name, body_hash, route, json_extract(decision, '$.rule') AS rule, received_at AS at,
           CASE WHEN state = 'held' OR (route IN ('pause', 'digest') AND state IN ('queued', 'notified')) THEN 1 ELSE 0 END AS pending
         FROM messages WHERE to_thread = ? AND kind = 'message' AND received_at >= ? ORDER BY received_at DESC LIMIT 500`,
      )
      .all(threadId, since) as unknown as RecentRow[];
  }

  recentOutboxTo(toAddr: string, since: number): RecentRow[] {
    return this.db
      .prepare(
        `SELECT msg_id, from_addr, from_name, body_hash, route, json_extract(decision, '$.rule') AS rule, created_at AS at,
           CASE WHEN status = 'held' OR (route IN ('pause', 'digest') AND status = 'sent' AND shown_at IS NULL) THEN 1 ELSE 0 END AS pending
         FROM outbox WHERE to_addr = ? AND created_at >= ? AND status NOT IN ('merged', 'refused', 'failed') ORDER BY created_at DESC LIMIT 500`,
      )
      .all(toAddr, since) as unknown as RecentRow[];
  }

  awaitingReply(askerAddr: string, answererAddr: string, since: number): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM outbox WHERE from_addr = ? AND to_addr = ? AND created_at >= ? AND status IN ('sent', 'shown') AND replied_at IS NULL AND route IN ('now', 'pause') AND urgency != 'fyi' LIMIT 1",
      )
      .get(askerAddr, answererAddr, since);
  }

  markReplied(askerAddr: string, answererAddr: string, now: number): number {
    const r = this.db
      .prepare("UPDATE outbox SET status = 'replied', replied_at = ? WHERE from_addr = ? AND to_addr = ? AND status = 'shown' AND shown_at <= ? AND replied_at IS NULL")
      .run(now, askerAddr, answererAddr, now);
    return Number(r.changes);
  }

  supersede(msgIds: string[], toAddr: string, byMsgId: string, undelivered: readonly OutboxStatus[]): void {
    const mark = this.db.prepare(`UPDATE outbox SET status = 'merged', error = ?, body = '' WHERE msg_id = ? AND to_addr = ? AND status IN (${undelivered.map(() => "?").join(", ")})`);
    for (const id of msgIds) mark.run(`superseded by ${byMsgId}`, id, toAddr, ...undelivered);
  }

  supersedeHeldForTask(taskId: string, why: string): number {
    const rows = this.db.prepare("SELECT id, msg_id, to_thread FROM outbox WHERE task_id = ? AND status = 'held'").all(taskId) as { id: string; msg_id: string; to_thread: string | null }[];
    for (const r of rows) {
      this.db.prepare("UPDATE outbox SET status = 'merged', error = ?, body = '' WHERE id = ?").run(why, r.id);
      if (r.to_thread) this.db.prepare("DELETE FROM messages WHERE to_thread = ? AND msg_id = ? AND state = 'held'").run(r.to_thread, r.msg_id);
    }
    return rows.length;
  }

  dropPending(threadId: string, msgIds: string[]): void {
    const drop = this.db.prepare("DELETE FROM messages WHERE to_thread = ? AND msg_id = ? AND kind = 'message' AND state IN ('held', 'queued', 'notified')");
    for (const id of msgIds) drop.run(threadId, id);
  }

  markReleased(msgIds: string[], toThread: string, now: number): void {
    const mark = this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE msg_id = ? AND to_thread = ? AND status = 'held'");
    for (const id of msgIds) mark.run(now, id, toThread);
  }

  markShown(msgIds: string[], toThread: string, now: number): void {
    const mark = this.db.prepare("UPDATE outbox SET status = 'shown', shown_at = ? WHERE msg_id = ? AND to_thread = ? AND status = 'sent'");
    for (const id of msgIds) mark.run(now, id, toThread);
  }

  heldClaudeGroups(): { from_addr: string | null; from_name: string | null; to_addr: string }[] {
    return this.db
      .prepare("SELECT DISTINCT from_addr, CASE WHEN from_addr IS NULL THEN from_name END AS from_name, to_addr FROM outbox WHERE status = 'held' AND sent_at IS NULL AND to_kind = 'claude'")
      .all() as unknown as { from_addr: string | null; from_name: string | null; to_addr: string }[];
  }

  heldClaudeRows(fromAddr: string | null, fromName: string | null, toAddr: string): OutboxRow[] {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE status = 'held' AND sent_at IS NULL AND to_kind = 'claude' AND from_addr IS ? AND (from_addr IS NOT NULL OR from_name = ?) AND to_addr = ? ORDER BY created_at ASC",
      )
      .all(fromAddr, fromName, toAddr) as unknown as OutboxRow[];
  }

  markFlushed(ids: string[], carrierId: string, now: number): void {
    const mark = this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, carrier_id = ?, body = '', error = NULL WHERE id = ?");
    for (const id of ids) mark.run(now, carrierId, id);
  }

  noteRowError(ids: string[], error: string): void {
    const mark = this.db.prepare("UPDATE outbox SET error = ? WHERE id = ?");
    for (const id of ids) mark.run(error, id);
  }

  failRows(ids: string[], error: string): void {
    const mark = this.db.prepare("UPDATE outbox SET status = 'failed', error = ?, body = '' WHERE id = ?");
    for (const id of ids) mark.run(error, id);
  }

  awaitingShown(since: number, toAddr?: string): OutboxRow[] {
    const scope = toAddr ? " AND to_addr = ?" : "";
    return this.db
      .prepare(
        `SELECT * FROM outbox WHERE to_kind = 'claude' AND to_session IS NOT NULL AND sent_at IS NOT NULL AND shown_at IS NULL AND status IN ('sent', 'held') AND created_at >= ?${scope}`,
      )
      .all(...(toAddr ? [since, toAddr] : [since])) as unknown as OutboxRow[];
  }

  markShownById(msgId: string, now: number): number {
    const r = this.db
      .prepare("UPDATE outbox SET status = 'shown', shown_at = ? WHERE (msg_id = ? OR carrier_id = ?) AND status IN ('sent', 'held') AND shown_at IS NULL")
      .run(now, msgId, msgId);
    return Number(r.changes);
  }

  applyReceipt(origMsgId: string, senderAddr: string, status: OutboxStatus, note: string): number {
    const r = this.db
      .prepare("UPDATE outbox SET status = ?, error = ? WHERE (msg_id = ? OR carrier_id = ?) AND from_addr = ? AND status IN ('sent', 'held')")
      .run(status, note, origMsgId, origMsgId, senderAddr);
    return Number(r.changes);
  }

  oldestUnread(threadId: string): number | null {
    const r = this.db
      .prepare(`SELECT MIN(COALESCE(released_at, received_at)) AS oldest FROM messages WHERE to_thread = ? AND ${UNREAD} AND kind = 'message'`)
      .get(threadId) as { oldest: number | null };
    return r.oldest === null ? null : Number(r.oldest);
  }

  unseenOutbox(toAddr: string, since: number): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM outbox WHERE to_addr = ? AND to_kind = 'claude' AND to_session IS NOT NULL AND sent_at IS NOT NULL AND shown_at IS NULL AND status IN ('sent', 'held') AND created_at >= ?")
      .all(toAddr, since) as unknown as OutboxRow[];
  }

  heldCount(toAddr: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE to_addr = ? AND status = 'held' AND sent_at IS NULL").get(toAddr) as { n: number }).n);
  }

  deliveryTimes(toAddr: string): { shown: number | null; replied: number | null } {
    const r = this.db.prepare("SELECT MAX(shown_at) AS shown, MAX(replied_at) AS replied FROM outbox WHERE to_addr = ?").get(toAddr) as { shown: number | null; replied: number | null };
    return { shown: r.shown === null ? null : Number(r.shown), replied: r.replied === null ? null : Number(r.replied) };
  }

  statRows(since: number): StatRow[] {
    return this.db
      .prepare(
        `SELECT from_addr, to_addr, to_name, to_kind, to_thread, route, status, urgency, json_extract(decision, '$.rule') AS rule, created_at, sent_at, shown_at, replied_at
         FROM outbox WHERE created_at >= ? ORDER BY created_at ASC`,
      )
      .all(since) as unknown as StatRow[];
  }

  insertOutbox(row: NewOutbox): void {
    this.db
      .prepare(
        `INSERT INTO outbox (id, msg_id, from_addr, from_name, from_kind, from_session, from_mode, to_addr, to_name, to_kind, to_thread, to_session,
           body, body_hash, body_chars, urgency, route, decision, status, task_id, carrier_id, created_at, sent_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.msg_id,
        row.from_addr,
        row.from_name,
        row.from_kind,
        row.from_session,
        row.from_mode,
        row.to_addr,
        row.to_name,
        row.to_kind,
        row.to_thread,
        row.to_session,
        row.body,
        row.body_hash ?? bodyHash(row.body),
        row.body_chars ?? row.body.length,
        row.urgency,
        row.route,
        row.decision,
        row.status,
        row.task_id,
        row.carrier_id ?? null,
        row.created_at,
        row.sent_at ?? null,
        row.error ?? null,
      );
  }

  updateOutbox(id: string, fields: Partial<Omit<OutboxRow, "id">>): void {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE outbox SET ${sets} WHERE id = ?`).run(...(entries.map(([, v]) => v) as (string | number | null)[]), id);
  }

  getOutboxByMsgId(msgId: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE msg_id = ? ORDER BY created_at DESC LIMIT 1").get(msgId) as OutboxRow | undefined;
  }

  getOutbox(msgId: string): OutboxRow | undefined {
    return (
      (this.db.prepare("SELECT * FROM outbox WHERE msg_id = ? ORDER BY created_at DESC LIMIT 1").get(msgId) as OutboxRow | undefined) ??
      (this.db.prepare("SELECT * FROM outbox WHERE carrier_id = ? ORDER BY created_at ASC LIMIT 1").get(msgId) as OutboxRow | undefined)
    );
  }

  insertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, from_addr, from_name, to_addr, to_name, to_kind, title, body, acceptance, risk, external_ref, on_behalf_of, status, result, evidence,
           from_session, to_session, request_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.from_addr,
        row.from_name,
        row.to_addr,
        row.to_name,
        row.to_kind,
        row.title,
        row.body,
        row.acceptance,
        row.risk,
        row.external_ref,
        row.on_behalf_of,
        row.status,
        row.result,
        row.evidence,
        row.from_session,
        row.to_session,
        row.request_id,
        row.created_at,
        row.updated_at,
        row.expires_at,
      );
  }

  getTaskByRequest(requestId: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE request_id = ?").get(requestId) as TaskRow | undefined;
  }

  firstOutboxForTask(taskId: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1").get(taskId) as OutboxRow | undefined;
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  listTasks(filter: { party?: string; session?: string; role?: "assignee" | "creator" | "any"; statuses?: TaskStatus[]; limit?: number }): TaskRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const role = filter.role ?? "any";
    const sides: string[] = [];
    const side = (column: "from" | "to") => {
      if (filter.party) {
        sides.push(`${column}_addr = ?`);
        args.push(filter.party);
      }
      if (filter.session) {
        sides.push(`${column}_session = ?`);
        args.push(filter.session);
      }
    };
    if (role !== "creator") side("to");
    if (role !== "assignee") side("from");
    if (filter.party || filter.session) where.push(`(${sides.join(" OR ")})`);
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      args.push(...filter.statuses);
    }
    const limit = Math.min(Math.max(Number.isFinite(filter.limit) ? Math.trunc(filter.limit!) : 50, 1), 500);
    const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.db.prepare(sql).all(...args) as unknown as TaskRow[];
  }

  rebindTask(id: string, side: "from" | "to", addr: string): void {
    this.db.prepare(`UPDATE tasks SET ${side}_addr = ? WHERE id = ?`).run(addr, id);
  }

  moveTask(id: string, from: TaskStatus[], to: TaskStatus, fields: { result?: string | null; evidence?: string | null }, now: number): boolean {
    const sets = ["status = ?", "updated_at = ?"];
    const args: (string | number | null)[] = [to, now];
    if (fields.result !== undefined) {
      sets.push("result = ?");
      args.push(fields.result);
    }
    if (fields.evidence !== undefined) {
      sets.push("evidence = ?");
      args.push(fields.evidence);
    }
    const r = this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`).run(...args, id, ...from);
    return Number(r.changes) > 0;
  }

  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  dueTasks(now: number): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE status IN ('open', 'accepted', 'in_progress') AND expires_at <= ?").all(now) as unknown as TaskRow[];
  }

  purge(days: number, now = Date.now()): void {
    const cutoff = now - days * 86_400_000;
    this.db.prepare("DELETE FROM messages WHERE received_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM outbox WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM tasks WHERE status IN ('done', 'failed', 'cancelled', 'expired') AND updated_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM threads WHERE state = 'ended' AND last_seen < ?").run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
