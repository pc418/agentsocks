import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anchoredEnv, brokerSocketPath, callerDir, stableCwd } from "./paths.ts";
import { readLines } from "./ccsocks.ts";

export function cliEntry(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./cli${ext}`, import.meta.url));
}

function once(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: brokerSocketPath() });
    let settled = false;
    const finish = (err: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(`agentsocks broker timed out on ${op}`), { code: "ETIMEDOUT" })), timeoutMs);
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish(Object.assign(new Error(`agentsocks broker closed the connection during ${op}`), { code: "ECLOSED" })));
    sock.on("connect", () => {
      sock.setNoDelay(true);
      sock.write(`${JSON.stringify({ id: 1, op, ...args })}\n`);
    });
    readLines(
      sock,
      (raw) => {
        try {
          const res = JSON.parse(raw) as { ok: boolean; result?: unknown; error?: string; ackRequired?: boolean };
          if (!res.ok) return finish(new Error(res.error ?? "broker error"));
          if (!res.ackRequired) return finish(undefined, res.result);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.end(`${JSON.stringify({ ack: true })}\n`);
          resolve(res.result);
        } catch (err) {
          finish(err as Error);
        }
      },
      timeoutMs + 1000,
      0,
    );
  });
}

export function startBroker(): void {
  const cwd = stableCwd();
  const caller = callerDir();
  const child = spawn(process.execPath, [cliEntry(), "daemon"], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...(caller === undefined ? process.env : anchoredEnv(process.env, caller)), PWD: cwd, NODE_NO_WARNINGS: "1" },
  });
  child.unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notRunning = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
};

export class OldBrokerError extends Error {
  readonly code = "EOLDBROKER";
  readonly pid: number | undefined;
  constructor(pid?: number) {
    super(`The running agentsocks broker is an older version. Run \`agentsocks install\` (or stop pid ${pid ?? "of the agentsocks daemon"}) and retry.`);
    this.pid = pid;
  }
}

export function brokerUnavailable(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT" || e.code === "ECONNREFUSED" || e.code === "EOLDBROKER") return true;
  return /^agentsocks broker did not start/.test(e.message ?? "");
}

export function outcomeUnknown(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ETIMEDOUT" || code === "ECLOSED";
}

export interface CallOptions {
  timeoutMs?: number;
  autoStart?: boolean;
  startWaitMs?: number;
}

async function olderBroker(err: unknown): Promise<unknown> {
  if (!/^unknown op /.test((err as Error)?.message ?? "")) return err;
  const pong = (await once("ping", {}, 1000).catch(() => undefined)) as { pid?: number } | undefined;
  return new OldBrokerError(pong?.pid);
}

export async function brokerCall<T = unknown>(op: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
  try {
    return await dial<T>(op, args, opts);
  } catch (err) {
    throw await olderBroker(err);
  }
}

async function dial<T>(op: string, args: Record<string, unknown>, opts: CallOptions): Promise<T> {
  const { timeoutMs = 5000, autoStart = true, startWaitMs = 5000 } = opts;
  try {
    return (await once(op, args, timeoutMs)) as T;
  } catch (err) {
    if (!autoStart || !notRunning(err)) throw err;
  }
  startBroker();
  const deadline = Date.now() + startWaitMs;
  let respawned = false;
  let last: unknown;
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      return (await once(op, args, timeoutMs)) as T;
    } catch (err) {
      last = err;
      if (!notRunning(err)) throw err;
      if (!respawned && Date.now() > deadline - startWaitMs / 2) {
        respawned = true;
        startBroker();
      }
    }
  }
  throw new Error(`agentsocks broker did not start: ${(last as Error)?.message ?? "unknown"}`);
}
