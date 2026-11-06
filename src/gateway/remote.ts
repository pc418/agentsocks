import type { Broker } from "../broker.ts";
import { cleanText } from "../limits.ts";
import { MODE_RULE } from "../modes.ts";
import { gatewayState, threadIdFor, type GatewayState, type PeerRow, type Via } from "./state.ts";

export interface PeerSpec {
  id: string;
  name: string;
  via: Via;
  machine?: string | null;
  login?: string | null;
  mayMessage?: readonly string[];
  detail?: Record<string, unknown>;
}

export interface RemotePeerInfo {
  threadId: string;
  name: string;
  via: Via;
  machine: string | null;
  login: string | null;
  status: "online" | "offline" | "never connected";
  lastSeen: number | null;
  socketPath: string;
}

export const ONLINE_WINDOW_MS = 5 * 60_000;
const TOUCH_EVERY_MS = 30_000;

export function uniqueName(state: GatewayState, wanted: string, ownerId: string): string {
  const base = cleanText(wanted, 56) || "remote";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const taken = state.peerByName(candidate);
    if (!taken || taken.id === ownerId) return candidate;
  }
}

export async function ensurePeer(broker: Broker, spec: PeerSpec, now = Date.now()): Promise<PeerRow> {
  const state = gatewayState(broker.store);
  let row = state.getPeer(spec.id);
  if (!row) {
    row = state.insertPeer(
      {
        id: spec.id,
        thread_id: threadIdFor(spec.id),
        name: uniqueName(state, spec.name, spec.id),
        via: spec.via,
        machine: spec.machine ?? null,
        login: spec.login ?? null,
        may_message: JSON.stringify(spec.mayMessage ?? []),
        detail: JSON.stringify(spec.detail ?? {}),
      },
      now,
    );
  } else {
    const changed: Partial<PeerRow> = {};
    if (spec.machine !== undefined && spec.machine !== row.machine) changed.machine = spec.machine;
    if (spec.login !== undefined && spec.login !== row.login) changed.login = spec.login;
    if (!row.last_seen || now - row.last_seen >= TOUCH_EVERY_MS) changed.last_seen = now;
    state.updatePeer(row.id, changed);
    row = state.getPeer(row.id)!;
  }
  await ensureThread(broker, row, now);
  return row;
}

export async function ensureThread(broker: Broker, peer: PeerRow, now = Date.now()): Promise<void> {
  if (!broker.inboxes.has(peer.thread_id)) await broker.register(peer.thread_id, { state: "idle" });
  const thread = broker.store.getThread(peer.thread_id);
  if (thread && (thread.name !== peer.name || thread.mode !== "prompting" || thread.mode_rule !== MODE_RULE || thread.state !== "idle" || thread.subagent !== 0)) {
    broker.store.updateThread(peer.thread_id, { name: peer.name, mode: "prompting", mode_rule: MODE_RULE, state: "idle", subagent: 0, last_seen: now });
  }
}

export function statusOf(peer: Pick<PeerRow, "last_seen">, now: number): RemotePeerInfo["status"] {
  if (!peer.last_seen) return "never connected";
  return now - peer.last_seen < ONLINE_WINDOW_MS ? "online" : "offline";
}

export function listRemotePeers(broker: Broker, now = Date.now()): RemotePeerInfo[] {
  const out: RemotePeerInfo[] = [];
  for (const peer of gatewayState(broker.store).listPeers()) {
    if (peer.disabled) continue;
    const thread = broker.store.getThread(peer.thread_id);
    if (!thread) continue;
    out.push({
      threadId: peer.thread_id,
      name: peer.name,
      via: peer.via,
      machine: peer.machine,
      login: peer.login,
      status: statusOf(peer, now),
      lastSeen: peer.last_seen,
      socketPath: broker.describe(thread).socketPath,
    });
  }
  return out;
}
