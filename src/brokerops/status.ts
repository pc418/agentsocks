import { isRemoteThread } from "../gateway/policy.ts";
import { parseParty, parseTarget } from "../routing.ts";
import { computeStats, messageStatus, peerStatus } from "../status.ts";
import { VERSION } from "../version.ts";
import type { OpTable } from "./types.ts";

export const statusOps: OpTable = {
  ping: async (broker) => ({ result: { pid: process.pid, version: VERSION, threads: broker.inboxes.size, build: broker.buildHash, classifier: broker.classifierState() } }),
  peer_status: async (broker, req) => {
    const ref = broker.peerRef(parseTarget(req.to));
    const status = peerStatus(broker.store, ref, Date.now());
    const remote = ref.thread && isRemoteThread(broker, ref.thread.thread_id);
    return { result: remote ? { ...status, peer: { ...status.peer, kind: "remote" as const } } : status };
  },
  message_status: async (broker, req) => {
    const caller = parseParty(req.party, "party");
    const row = typeof req.msgId === "string" ? broker.store.getOutbox(req.msgId) : undefined;
    const mine = row && (broker.holds(caller, row.from_addr, row.from_session) || broker.holds(caller, row.to_addr, row.to_session) || broker.isCliSender(caller, row));
    if (!row || !mine) throw new Error(`no message ${String(req.msgId)} sent or received by you in the outbox (only messages sent through agentsocks are tracked)`);
    return { result: messageStatus(row, broker.store) };
  },
  stats: async (broker, req) => {
    const days = typeof req.days === "number" && req.days > 0 ? Math.min(req.days, 14) : 14;
    const want = typeof req.to === "string" ? req.to.trim().replace(/^@/, "").toLowerCase() : "";
    const all = computeStats(broker.store.statRows(Date.now() - days * 86_400_000), Date.now());
    return { result: { days, destinations: want ? all.filter((d) => d.to.name.toLowerCase() === want || d.to.addr === want) : all } };
  },
};
