import type { DatabaseSync } from "node:sqlite";
import { GATEWAY_TABLES } from "./gateway/schema.ts";

export interface Migration {
  name: string;
  up: (db: DatabaseSync) => void;
}

export function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const addColumns =
  (table: string, columns: [string, string][]) =>
  (db: DatabaseSync): void => {
    for (const [column, type] of columns) addColumn(db, table, column, type);
  };

// SQLite keeps the text of a CREATE TABLE as written, so the indentation of the two CREATE blocks below is part of every existing database's schema and must not change
const CREATE_THREADS_AND_MESSAGES = `
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT,
        mode TEXT,
        state TEXT NOT NULL DEFAULT 'unknown',
        remote TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        pending_wake_at INTEGER,
        wake_log TEXT NOT NULL DEFAULT '[]',
        stop_streak INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_thread TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_addr TEXT,
        from_name TEXT,
        from_kind TEXT,
        from_session TEXT,
        from_mode TEXT,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        surfaced_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages (to_thread, state, received_at);
    `;

const CREATE_OUTBOX_AND_TASKS = `
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        msg_id TEXT NOT NULL,
        from_addr TEXT,
        from_name TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        from_session TEXT,
        from_mode TEXT,
        to_addr TEXT NOT NULL,
        to_name TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_thread TEXT,
        to_session TEXT,
        body TEXT NOT NULL,
        urgency TEXT NOT NULL,
        route TEXT NOT NULL,
        decision TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        carrier_id TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        shown_at INTEGER,
        replied_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_to ON outbox (to_addr, created_at);
      CREATE INDEX IF NOT EXISTS outbox_pair ON outbox (from_addr, to_addr, created_at);
      CREATE INDEX IF NOT EXISTS outbox_msgid ON outbox (msg_id);
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status, created_at);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        from_addr TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        to_name TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        acceptance TEXT,
        risk TEXT NOT NULL,
        external_ref TEXT,
        on_behalf_of TEXT,
        status TEXT NOT NULL,
        result TEXT,
        evidence TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (to_addr, status);
      CREATE INDEX IF NOT EXISTS tasks_creator ON tasks (from_addr, status);
    `;

const CREATE_CHANNEL_MEMBERS = `
  CREATE TABLE IF NOT EXISTS channel_members (
    channel TEXT NOT NULL,
    member TEXT NOT NULL,
    addr TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    session TEXT,
    subscribed_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (channel, member)
  );
`;

const CREATE_ASKS = `
  CREATE TABLE IF NOT EXISTS asks (
    id TEXT PRIMARY KEY,
    from_addr TEXT,
    from_name TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    from_session TEXT,
    question TEXT NOT NULL,
    pick TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    pick_result TEXT
  );
  CREATE TABLE IF NOT EXISTS ask_targets (
    ask_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    addr TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    session TEXT,
    state TEXT NOT NULL,
    note TEXT,
    msg_id TEXT,
    route TEXT,
    answer TEXT,
    answered_at INTEGER,
    PRIMARY KEY (ask_id, ord)
  );
  CREATE INDEX IF NOT EXISTS asks_created ON asks (created_at);
`;

const CREATE_LABELS = `
  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL,
    source TEXT NOT NULL,
    rating TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    msg_at INTEGER NOT NULL,
    receiver_addr TEXT NOT NULL,
    receiver_name TEXT,
    receiver_kind TEXT NOT NULL,
    sender_key TEXT NOT NULL,
    sender_name TEXT,
    sender_kind TEXT,
    urgency TEXT,
    route TEXT NOT NULL,
    decided_by TEXT,
    rule TEXT,
    confidence REAL,
    task TEXT,
    last_tool TEXT,
    body TEXT,
    UNIQUE (msg_id, receiver_addr, source)
  );
  CREATE INDEX IF NOT EXISTS labels_sender ON labels (sender_key, route, msg_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { name: "create threads and messages", up: (db) => db.exec(CREATE_THREADS_AND_MESSAGES) },
  { name: "threads.hooks_active", up: addColumns("threads", [["hooks_active", "INTEGER NOT NULL DEFAULT 0"]]) },
  {
    name: "messages.msg_id, stop_blocked, wakes",
    up: addColumns("messages", [
      ["msg_id", "TEXT"],
      ["stop_blocked", "INTEGER NOT NULL DEFAULT 0"],
      ["wakes", "INTEGER NOT NULL DEFAULT 0"],
    ]),
  },
  {
    name: "threads.current_task, last_tool, last_activity, wake_hold_since, exempt_wake_log",
    up: addColumns("threads", [
      ["current_task", "TEXT"],
      ["last_tool", "TEXT"],
      ["last_activity", "INTEGER"],
      ["wake_hold_since", "INTEGER"],
      ["exempt_wake_log", "TEXT NOT NULL DEFAULT '[]'"],
    ]),
  },
  {
    name: "messages.route, decision, body_hash, released_at",
    up: addColumns("messages", [
      ["route", "TEXT NOT NULL DEFAULT 'now'"],
      ["decision", "TEXT"],
      ["body_hash", "TEXT"],
      ["released_at", "INTEGER"],
    ]),
  },
  {
    name: "messages.msg_id backfill and index",
    up: (db) => {
      db.exec("UPDATE messages SET msg_id = id WHERE msg_id IS NULL");
      db.exec("CREATE INDEX IF NOT EXISTS messages_msgid ON messages (to_thread, msg_id)");
    },
  },
  { name: "create outbox and tasks", up: (db) => db.exec(CREATE_OUTBOX_AND_TASKS) },
  {
    name: "outbox.body_hash, body_chars",
    up: addColumns("outbox", [
      ["body_hash", "TEXT"],
      ["body_chars", "INTEGER"],
    ]),
  },
  { name: "threads.subagent", up: addColumns("threads", [["subagent", "INTEGER"]]) },
  {
    name: "tasks.from_session, to_session, request_id",
    up: addColumns("tasks", [
      ["from_session", "TEXT"],
      ["to_session", "TEXT"],
      ["request_id", "TEXT"],
    ]),
  },
  {
    name: "tasks.request_id unique index",
    up: (db) => db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_request ON tasks (request_id) WHERE request_id IS NOT NULL"),
  },
  { name: "create channel_members", up: (db) => db.exec(CREATE_CHANNEL_MEMBERS) },
  { name: "create asks and ask_targets", up: (db) => db.exec(CREATE_ASKS) },
  { name: "create labels", up: (db) => db.exec(CREATE_LABELS) },
  { name: "messages.received_at index", up: (db) => db.exec("CREATE INDEX IF NOT EXISTS messages_received ON messages (received_at)") },
  { name: "gateway tables", up: (db) => db.exec(GATEWAY_TABLES) },
  { name: "threads.agent", up: addColumns("threads", [["agent", "TEXT NOT NULL DEFAULT 'codex'"]]) },
  {
    name: "threads.driver_addr, driver_name, name_explicit",
    up: addColumns("threads", [
      ["driver_addr", "TEXT"],
      ["driver_name", "TEXT"],
      ["name_explicit", "INTEGER"],
    ]),
  },
  {
    name: "threads.driver_sid",
    up: addColumns("threads", [["driver_sid", "TEXT"]]),
  },
  {
    name: "threads.driver_instructed_at",
    up: addColumns("threads", [["driver_instructed_at", "INTEGER"]]),
  },
  {
    name: "threads.wake_error, wake_failed_at, wake_failures",
    up: addColumns("threads", [
      ["wake_error", "TEXT"],
      ["wake_failed_at", "INTEGER"],
      ["wake_failures", "INTEGER NOT NULL DEFAULT 0"],
    ]),
  },
];

export function migrate(db: DatabaseSync, steps: readonly Migration[] = MIGRATIONS): void {
  for (const step of steps) step.up(db);
}
