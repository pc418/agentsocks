import { kindLabel } from "./agents/types.ts";
import { renderTask } from "./tasks.ts";
import type { DestinationStats, MessageRecord, PeerStatus, WakeState } from "./status.ts";
import type { TaskRow } from "./store.ts";
import { squash } from "./limits.ts";

export function since(ts: number | null, now: number): string {
  if (ts === null) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function span(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function formatTasks(tasks: TaskRow[], now: number = Date.now()): string {
  return tasks.length === 0 ? "No tasks." : tasks.map((t) => renderTask(t, now)).join("\n");
}

export function formatPeerStatus(s: PeerStatus, now: number = Date.now(), visible?: readonly string[]): string {
  const d = s.desired;
  const a = s.actual;
  const lines = [`@${s.peer.name} (${kindLabel(s.peer.kind, s.peer.agent)}) is ${a.state}`];
  if (s.peer.driver && (visible === undefined || visible.includes(s.peer.driver))) lines.push(`  driver: @${s.peer.driver}`);
  const doing = [a.currentTask && `working on: ${squash(a.currentTask, 160)}`, a.lastTool && `last tool ${a.lastTool}`, a.lastActivity !== null && `active ${since(a.lastActivity, now)}`].filter(Boolean);
  lines.push(`  now: ${doing.length ? doing.join(", ") : "nothing observed"}`);
  const asked = [`${d.unreadMessages} unread`, `${d.heldDigests} held in a digest`, `${d.openTasks.length} active task${d.openTasks.length === 1 ? "" : "s"}`];
  lines.push(`  asked of it: ${asked.join(", ")}`);
  for (const t of d.openTasks) lines.push(`    ${t.id} [${t.status.replace("_", " ")}] ${squash(t.title, 100)}, updated ${since(t.updatedAt, now)}`);
  lines.push(`  last shown ${since(a.lastShown, now)}, last reply ${since(a.lastReply, now)}`);
  if (a.wake) lines.push(`  ${wakeLine(a.wake, now)}`);
  lines.push(s.drift.length ? `  drift:\n${s.drift.map((x) => `    ${x.code}: ${x.detail}`).join("\n")}` : "  drift: none");
  return lines.join("\n");
}

export function formatMessageStatus(m: MessageRecord & { decision: unknown }, now: number = Date.now()): string {
  const d = (m.decision ?? {}) as { route?: string; by?: string; rule?: string; backend?: string; confidence?: number; reason?: string };
  const via = [d.by, d.rule, d.backend, d.confidence !== undefined && `confidence ${d.confidence}`].filter(Boolean).join(", ");
  const lines = [`${m.msg_id}: ${m.status} (to @${m.to_name}, ${kindLabel(m.to_kind, m.to_agent)})`];
  lines.push(`  routed ${d.route ?? "?"}${via ? ` (${via})` : ""}: ${d.reason ?? "no reason recorded"}`);
  lines.push(`  created ${since(m.created_at, now)}, sent ${since(m.sent_at, now)}, shown ${since(m.shown_at, now)}, replied ${since(m.replied_at, now)}`);
  if (m.carrier_id) lines.push(`  delivered inside digest message ${m.carrier_id}`);
  if (m.task_id) lines.push(`  about task ${m.task_id}`);
  if (m.wake) {
    const times = `${m.wake.accepted} ${m.wake.accepted === 1 ? "time" : "times"}`;
    const own = m.wake.accepted > 0 ? `wake accepted ${times} for this message` : "no wake accepted for this message yet";
    const receiver = m.wake.receiver.failedAt !== null && m.wake.unread ? `; the receiver's latest ${wakeLine(m.wake.receiver, now)}` : "";
    lines.push(`  ${own}${receiver}`);
  }
  if (m.error) lines.push(`  note: ${m.error}`);
  return lines.join("\n");
}

function wakeLine(w: WakeState, now: number): string {
  if (w.failedAt !== null) return `wake failed ${since(w.failedAt, now)} (${w.failures} in a row): ${w.error ?? "no reason recorded"}`;
  return w.lastAccepted !== null ? `last wake accepted ${since(w.lastAccepted, now)}` : "no wake sent yet";
}

export function formatStats(r: { days: number; destinations: DestinationStats[] }): string {
  if (r.destinations.length === 0) return `No messages in the last ${r.days} days.`;
  const out = [`Last ${r.days} days, per destination`];
  for (const d of r.destinations) {
    const p = d.interruptPrecision;
    out.push(`@${d.to.name} (${kindLabel(d.to.kind, d.to.agent)}): ${d.messages} ${d.messages === 1 ? "message" : "messages"}, now ${d.routes.now}, pause ${d.routes.pause}, digest ${d.routes.digest}, merged ${d.routes.merge}`);
    out.push(
      `  median to shown ${span(d.medianMsToShown)}, to reply ${span(d.medianMsToReply)}; interrupt precision ${p.precision === null ? "n/a" : `${Math.round(p.precision * 100)}% (${p.repliedWithin30m} of ${p.matured} judged)`}; escalations ${d.escalations}`,
    );
  }
  return out.join("\n");
}
