import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MIGRATIONS, addColumn, migrate } from "../src/migrations.ts";
import { Store } from "../src/store.ts";
import { buildDatabase, dumpDatabase, type SchemaDump } from "./schemadump.ts";
import { tempDir } from "./tmp.ts";

const fixtures = fileURLToPath(new URL("./fixtures/schema/", import.meta.url));
const expected = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8")) as Record<string, SchemaDump>;
const final = JSON.parse(readFileSync(join(fixtures, "final.json"), "utf8")) as SchemaDump;
const legacy = (name: string): string => readFileSync(join(fixtures, `${name}.sql`), "utf8");

const SHIPPED = [
  "create threads and messages",
  "threads.hooks_active",
  "messages.msg_id, stop_blocked, wakes",
  "threads.current_task, last_tool, last_activity, wake_hold_since, exempt_wake_log",
  "messages.route, decision, body_hash, released_at",
  "messages.msg_id backfill and index",
  "create outbox and tasks",
  "outbox.body_hash, body_chars",
  "threads.subagent",
  "tasks.from_session, to_session, request_id",
  "tasks.request_id unique index",
];

function migrated(name: string, steps = MIGRATIONS): { path: string; dump: SchemaDump } {
  const path = join(tempDir("agentsocks-schema-"), "agentsocks.db");
  buildDatabase(path, name === "fresh" ? undefined : legacy(name));
  const db = new DatabaseSync(path);
  migrate(db, steps);
  db.close();
  return { path, dump: dumpDatabase(path) };
}

test("the steps that built the 0.3.1 schema keep their names and their order, and a new step goes after them", () => {
  assert.deepEqual(
    MIGRATIONS.slice(0, SHIPPED.length).map((m) => m.name),
    SHIPPED,
  );
});

for (const name of ["fresh", "v0.1.0", "v0.2.0", "v0.3.0"]) {
  test(`${name === "fresh" ? "a new database" : `a ${name} database`} after the steps that built the 0.3.1 schema has the recorded sqlite_master entries, columns and rows`, () => {
    const shipped = MIGRATIONS.slice(0, SHIPPED.length);
    const { path, dump } = migrated(name, shipped);
    assert.deepEqual(dump.master, expected[name]!.master);
    assert.deepEqual(dump.tables, expected[name]!.tables);
    assert.deepEqual(dump.rows, expected[name]!.rows);
    const again = new DatabaseSync(path);
    migrate(again, shipped);
    again.close();
    assert.deepEqual(dumpDatabase(path), dump, "running the steps again changes nothing");
  });
}

test("every legacy database opened by the Store ends with the schema of a new one, and opening it again changes nothing", () => {
  const open = (name: string) => {
    const path = join(tempDir("agentsocks-schema-"), "agentsocks.db");
    buildDatabase(path, name === "fresh" ? undefined : legacy(name));
    new Store(path).close();
    return { path, dump: dumpDatabase(path) };
  };
  const fresh = open("fresh");
  for (const name of ["v0.1.0", "v0.2.0", "v0.3.0"]) {
    const { path, dump } = open(name);
    assert.deepEqual(dump.master, fresh.dump.master, `${name} sqlite_master`);
    assert.deepEqual(dump.tables, fresh.dump.tables, `${name} table_info`);
    new Store(path).close();
    assert.deepEqual(dumpDatabase(path), dump, `${name} reopened`);
  }
});

test("migration names are unique, so a log line or a review comment names exactly one step", () => {
  const names = MIGRATIONS.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
});

test("a step appended to the list runs after the built-in ones and may run on every open", () => {
  const db = new DatabaseSync(":memory:");
  const steps = [...MIGRATIONS, { name: "threads.nickname", up: (d: DatabaseSync) => addColumn(d, "threads", "nickname", "TEXT") }];
  migrate(db, steps);
  migrate(db, steps);
  const columns = (db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name);
  assert.equal(columns.at(-1), "nickname");
  assert.equal(columns.filter((c) => c === "nickname").length, 1);
  db.close();
});

test("the v0.4 tables are created by their own steps after the shipped ones, and a database that already has them opens unchanged", () => {
  const names = MIGRATIONS.map((m) => m.name);
  const later = names.slice(SHIPPED.length);
  for (const step of ["create channel_members", "create asks and ask_targets", "create labels", "messages.received_at index"]) assert.ok(later.includes(step), `${step} comes after the shipped steps`);
  const path = join(tempDir("agentsocks-schema-"), "agentsocks.db");
  new Store(path).close();
  const first = dumpDatabase(path);
  const tables = first.master.filter((e) => e.type === "table").map((e) => e.name);
  assert.ok(first.master.some((e) => e.type === "index" && e.name === "messages_received"));
  for (const table of ["channel_members", "asks", "ask_targets", "labels"]) assert.ok(tables.includes(table), table);
  new Store(path).close();
  assert.deepEqual(dumpDatabase(path), first);
});

test("the v0.4 steps follow the shipped ones in the order channels and ratings, the gateway and then more agents added them", () => {
  assert.deepEqual(
    MIGRATIONS.slice(SHIPPED.length).map((m) => m.name),
    ["create channel_members", "create asks and ask_targets", "create labels", "messages.received_at index", "gateway tables", "threads.agent", "threads.driver_addr, driver_name, name_explicit", "threads.driver_sid", "threads.driver_instructed_at", "threads.wake_error, wake_failed_at, wake_failures"],
  );
});

test("a thread row that existed before threads.agent is a Codex thread after it, and a row inserted without an agent is one too", () => {
  const shipped = MIGRATIONS.slice(0, SHIPPED.length);
  const db = new DatabaseSync(":memory:");
  migrate(db, shipped);
  db.prepare("INSERT INTO threads (thread_id, name, created_at, last_seen) VALUES ('019e2f00-0000-7000-8000-000000000001', 'old', 1, 1)").run();
  migrate(db);
  db.prepare("INSERT INTO threads (thread_id, name, created_at, last_seen) VALUES ('019e2f00-0000-7000-8000-000000000002', 'new', 1, 1)").run();
  const rows = db.prepare("SELECT name, agent FROM threads ORDER BY name").all() as { name: string; agent: string }[];
  assert.deepEqual(rows.map((r) => [r.name, r.agent]), [["new", "codex"], ["old", "codex"]]);
  const column = (db.prepare("PRAGMA table_info(threads)").all() as { name: string; notnull: number; dflt_value: string | null }[]).find((c) => c.name === "agent")!;
  assert.deepEqual([column.notnull, column.dflt_value], [1, "'codex'"]);
  db.close();
});

for (const name of ["fresh", "v0.1.0", "v0.2.0", "v0.3.0"]) {
  test(`${name === "fresh" ? "a new database" : `a ${name} database`} after every step has the recorded final schema`, () => {
    const { path, dump } = migrated(name);
    assert.deepEqual(dump.master, final.master);
    assert.deepEqual(dump.tables, final.tables);
    if (name === "fresh") assert.deepEqual(dump.rows, final.rows);
    const again = new DatabaseSync(path);
    migrate(again);
    again.close();
    assert.deepEqual(dumpDatabase(path), dump, "running every step again changes nothing");
  });
}
