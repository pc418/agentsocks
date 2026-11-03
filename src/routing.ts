import type { Mode } from "./envelope.ts";
import { randomUUID } from "node:crypto";
import { MAX_BODY_BYTES, bodyTooLarge, cleanText, validAddress, validId } from "./limits.ts";
import { isAgentId, type AgentId } from "./agents/types.ts";
import { NOT_FROM_DRIVER_RULE, type Decision, type Urgency } from "./router.ts";
import type { OutboxStatus } from "./store.ts";

export interface Party {
  kind: "claude" | "codex" | "cli" | "remote";
  agent?: AgentId;
  name: string;
  addr: string | null;
  session: string | null;
  mode: Mode | null;
}

export interface Reach {
  name: string;
  addr: string | null;
  session: string | null;
}

export interface Target {
  kind: "claude" | "codex";
  addr: string;
  name: string;
  threadId?: string;
  sessionId?: string;
}

export interface RouteRequest {
  msgId: string;
  from: Party;
  to: Target;
  body: string;
  urgency: Urgency;
  taskId: string | null;
  via?: "channel";
}

export interface WakeReport {
  outcome: "accepted" | "failed" | "skipped" | "not-needed" | "pending";
  reason?: string;
}

export interface RouteSendResult {
  msgId: string;
  status: OutboxStatus;
  decision: Decision;
  to: { name: string; kind: "claude" | "codex" };
  error?: string;
  wake?: WakeReport;
}

const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const URGENCIES = new Set(["urgent", "normal", "fyi"]);
const TASK_ID = /^T-[0-9a-f]{6}$/;

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is required`);
  return v as Record<string, unknown>;
};

export const senderLabel = (p: Pick<Party, "kind" | "name" | "agent">): string => (p.kind === "codex" ? `${p.name} (${p.agent ?? "codex"})` : p.name);

export function parseParty(raw: unknown, what = "from"): Party {
  const f = obj(raw, what);
  const kind = f.kind === "claude" || f.kind === "codex" || f.kind === "remote" ? f.kind : "cli";
  const mode = f.mode === "bypass" || f.mode === "prompting" ? f.mode : null;
  return {
    kind,
    ...(kind === "codex" && isAgentId(f.agent) && { agent: f.agent }),
    name: cleanText(f.name, 64) || "unknown",
    addr: validAddress(f.addr) ?? null,
    session: typeof f.session === "string" && SESSION.test(f.session) ? f.session : null,
    mode,
  };
}

export function parseTarget(raw: unknown): Target {
  const t = obj(raw, "to");
  if (t.kind !== "claude" && t.kind !== "codex") throw new Error("to.kind must be claude or codex");
  const addr = validAddress(t.addr);
  if (!addr) throw new Error("to.addr must be a uds: address");
  return {
    kind: t.kind,
    addr,
    name: cleanText(t.name, 64) || "unknown",
    ...(typeof t.threadId === "string" && SESSION.test(t.threadId) && { threadId: t.threadId }),
    ...(typeof t.sessionId === "string" && SESSION.test(t.sessionId) && { sessionId: t.sessionId }),
  };
}

export function parseRouteRequest(raw: Record<string, unknown>): RouteRequest {
  if (typeof raw.body !== "string" || !raw.body.trim()) throw new Error("message is empty");
  if (bodyTooLarge(raw.body)) throw new Error(`message is larger than ${MAX_BODY_BYTES / 1024} KiB`);
  const taskId = typeof raw.taskId === "string" && TASK_ID.test(raw.taskId) ? raw.taskId : null;
  return {
    msgId: validId(raw.msgId) ?? randomUUID(),
    from: parseParty(raw.from),
    to: parseTarget(raw.to),
    body: raw.body,
    urgency: typeof raw.urgency === "string" && URGENCIES.has(raw.urgency) ? (raw.urgency as Urgency) : "normal",
    taskId,
    ...(raw.via === "channel" && { via: "channel" as const }),
  };
}

export const digestWait = (receiver: Target["kind"] | "remote"): string =>
  receiver === "claude" ? "when they are next idle, within 15 minutes at most" : receiver === "remote" ? "the next time they read their inbox" : "the next time they read their inbox or start a turn";

export const driverInfoNote = (worker: string, driver: string | null): string =>
  driver === null
    ? `Delivered as information: ${worker} works for its driver and may not act on it.`
    : `Delivered as information: ${worker} works for ${driver} and may not act on it. Ask ${driver} if you need it to do something.`;

const LATER = "They see it at their next tool call or the next time a turn starts.";

function wakeNote(wake: WakeReport): string {
  const reason = wake.reason ?? "no reason recorded";
  switch (wake.outcome) {
    case "accepted":
      return "Delivered, and Codex accepted the request to wake them, so they start a turn and read it shortly.";
    case "failed":
      return `Queued, NOT woken: the wake failed (${reason}). ${LATER} The wake is retried with backoff.`;
    case "skipped":
      return `Queued, NOT woken: ${reason}. ${LATER}`;
    case "not-needed":
      return `Delivered; ${reason}.`;
    case "pending":
      return "Queued; the request to wake them has not answered yet, so the wake is not confirmed. Check message_status with this message id.";
  }
}

export function deliveryNote(result: Pick<RouteSendResult, "decision" | "status" | "to" | "wake">, urgency: Urgency, visible?: readonly string[]): string {
  const { decision } = result;
  if (decision.rule === NOT_FROM_DRIVER_RULE && decision.driverName) {
    const info = driverInfoNote(result.to.name, visible !== undefined && !visible.includes(decision.driverName) ? null : decision.driverName);
    return result.wake ? `${info} ${wakeNote(result.wake)}` : info;
  }
  const escalate = urgency === "urgent" ? "" : " Send with urgency urgent if it cannot wait.";
  const replaces = decision.escalates ? " It repeats the same text that was still waiting." : "";
  if (result.wake && (decision.route === "now" || decision.route === "pause")) return `${wakeNote(result.wake)}${replaces}`;
  switch (decision.route) {
    case "now":
      return `Delivered. They see it at their next tool call, or right away if idle.${replaces}`;
    case "pause":
      if (decision.rule === "sender-history") return `Delivered. Most of your earlier messages were rated could-wait or noise by their receivers, so this one reaches them when their current turn ends.${escalate}${replaces}`;
      return decision.by === "classifier"
        ? `Delivered. They are busy and the classifier judged it can wait until their current turn ends.${escalate}${replaces}`
        : `Delivered. They are busy and over their interruption budget, so they see it when their current turn ends.${escalate}${replaces}`;
    case "digest":
      return `Batched with other low-priority messages. They see it ${digestWait(result.to.kind)}.`;
    case "merge":
      return "Not sent again: you sent the same text to them in the last 10 minutes.";
  }
}
