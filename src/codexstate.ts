import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexThreadInfo {
  id: string;
  name?: string;
  cwd?: string;
  approvalMode?: string;
  updatedAtMs?: number;
  subagent?: boolean;
}

export const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

function stateDbPath(): string | undefined {
  try {
    const files = readdirSync(codexHome())
      .map((f) => ({ f, n: Number(f.match(/^state_(\d+)\.sqlite$/)?.[1]) }))
      .filter((x) => Number.isInteger(x.n))
      .sort((a, b) => b.n - a.n);
    return files[0] ? join(codexHome(), files[0].f) : undefined;
  } catch {
    return undefined;
  }
}

type Db = import("node:sqlite").DatabaseSync;

async function withState<T>(fn: (db: Db, columns: Set<string>) => T): Promise<T | undefined> {
  const path = stateDbPath();
  if (!path) return undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name));
      return columns.has("id") ? fn(db, columns) : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

const SELECTED = ["id", "name", "cwd", "approval_mode", "updated_at_ms"];

function infoOf(row: Record<string, unknown> | undefined): CodexThreadInfo | undefined {
  if (!row || typeof row.id !== "string") return undefined;
  return {
    id: row.id,
    ...(typeof row.name === "string" && row.name && { name: row.name }),
    ...(typeof row.cwd === "string" && { cwd: row.cwd }),
    ...(typeof row.approval_mode === "string" && { approvalMode: row.approval_mode }),
    ...(row.updated_at_ms != null && { updatedAtMs: Number(row.updated_at_ms) }),
    ...(row.subagent != null && { subagent: Number(row.subagent) === 1 }),
  };
}

function subagentTest(columns: Set<string>): string | undefined {
  const tests = [
    columns.has("thread_source") && "COALESCE(thread_source = 'subagent', 0)",
    columns.has("source") && "(CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NOT NULL ELSE 0 END)",
  ].filter((test): test is string => !!test);
  return tests.length > 0 ? `(${tests.join(" OR ")})` : undefined;
}

// has_user_event is no longer written by Codex, so a thread the user typed into is told by its first message
function listable(columns: Set<string>): string[] {
  const isSubagent = subagentTest(columns);
  return [
    columns.has("archived") && "archived = 0",
    columns.has("archived_at") && "archived_at IS NULL",
    isSubagent && `NOT ${isSubagent}`,
    columns.has("first_user_message") ? "COALESCE(first_user_message, '') <> ''" : columns.has("has_user_event") && "has_user_event = 1",
  ].filter((clause): clause is string => !!clause);
}

export async function findCodexThread(query: { id?: string; name?: string }, opts: { userFacingOnly?: boolean } = {}): Promise<CodexThreadInfo | undefined> {
  if (!query.id && !query.name) return undefined;
  return withState((db, columns) => {
    const isSubagent = subagentTest(columns);
    const pick = [...SELECTED.filter((c) => columns.has(c)), ...(isSubagent ? [`${isSubagent} AS subagent`] : [])].join(", ");
    const only = opts.userFacingOnly ? listable(columns).map((clause) => ` AND ${clause}`).join("") : "";
    const row = query.id
      ? db.prepare(`SELECT ${pick} FROM threads WHERE id = ?${only}`).get(query.id)
      : columns.has("name")
        ? db.prepare(`SELECT ${pick} FROM threads WHERE name = ? COLLATE NOCASE${only} ORDER BY ${columns.has("updated_at_ms") ? "updated_at_ms" : "id"} DESC LIMIT 1`).get(query.name!)
        : undefined;
    const info = infoOf(row as Record<string, unknown> | undefined);
    return info && (!opts.userFacingOnly || CODEX_THREAD_ID.test(info.id)) ? info : undefined;
  });
}

export async function recentCodexThreads(sinceMs: number, limit = 500): Promise<CodexThreadInfo[]> {
  const found = await withState((db, columns) => {
    const updated = columns.has("updated_at_ms") ? "updated_at_ms" : columns.has("updated_at") ? "updated_at * 1000" : undefined;
    if (!updated) return [];
    const live = listable(columns);
    const pick = SELECTED.filter((c) => c !== "updated_at_ms" && columns.has(c)).join(", ");
    const sql = `SELECT ${pick}, ${updated} AS updated_at_ms FROM threads WHERE ${[`${updated} >= ?`, ...live].join(" AND ")} ORDER BY ${updated} DESC LIMIT ?`;
    return (db.prepare(sql).all(sinceMs, limit) as Record<string, unknown>[]).map(infoOf);
  });
  return (found ?? []).filter((t): t is CodexThreadInfo => !!t && CODEX_THREAD_ID.test(t.id));
}
