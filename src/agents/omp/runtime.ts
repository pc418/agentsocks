import type { spawn as spawnProcess } from "node:child_process";

export interface Zod {
  object(shape: Record<string, unknown>): unknown;
}

export interface OmpTool {
  name: string;
  label: string;
  description: string;
  readOnly: boolean;
  params: (z: Zod) => Record<string, unknown>;
}

export interface Deps {
  spawn: typeof spawnProcess;
  randomBytes: (size: number) => { toString(encoding: "hex"): string };
  node: string;
  cli: string;
  tools: readonly OmpTool[];
  approvalMode?: () => Promise<string | undefined>;
}

export interface Context {
  agent?: { kind?: string };
  sessionManager?: { getSessionId?: () => unknown };
  cwd?: string;
  isIdle?: () => boolean;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

type Event = Record<string, unknown>;

export interface Pi {
  zod: Zod;
  getSessionName?: () => unknown;
  on(event: string, handler: (event: Event, ctx: Context) => Promise<unknown>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    loadMode: "essential";
    approval: "read" | "write";
    execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: Context) => Promise<{ content: { type: "text"; text: string }[] }>;
  }): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn?: boolean; deliverAs?: "aside" }): void;
}

// OMP's effective tools.approvalMode (its --approval-mode and --yolo flags, project config and /settings included).
// OMP serves its own modules to an extension only once the session is running, so they are loaded on first use, and
// loaded again later if that failed. The mode itself is read on every call, so a change in /settings is seen.
export function approvalModeReader(load: () => Promise<readonly unknown[]>): () => Promise<string | undefined> {
  let modules: Promise<readonly unknown[]> | undefined;
  return async () => {
    const loading = (modules ??= load());
    try {
      const [settingsModule, approvalModule] = (await loading) as [
        { Settings?: { instance?: unknown } } | undefined,
        { resolveApprovalFromContext?: (context: { settings: unknown }) => { approvalMode?: unknown } | undefined } | undefined,
      ];
      const mode = approvalModule?.resolveApprovalFromContext?.({ settings: settingsModule?.Settings?.instance })?.approvalMode;
      return typeof mode === "string" && mode !== "" ? mode.slice(0, 64) : undefined;
    } catch {
      if (modules === loading) modules = undefined;
      return undefined;
    }
  };
}

export function createOmpExtension(deps: Deps, pi: Pi): void {
  const PREFIX = "📨 agentsocks:";
  const NOTICE_TYPE = "agentsocks-notice";
  const TOOL_PREFIX = "agentsocks_";
  const HOOK_TIMEOUT_MS = 4000;
  const HOOK_PAUSE_MS = 30_000;
  const TURN_START_MS = 1000;
  const END_TIMEOUT_MS = 1500;
  const TOOL_TIMEOUT_MS = 45_000;
  const POLL_MS = 25_000;
  const TICK_MS = 1000;
  const MAX_LINE = 600;
  const MAX_OUTPUT = 1_000_000;
  const KEEP_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "NODE_OPTIONS", "NODE_NO_WARNINGS", "NODE_PATH", "TS_SOCKET"]);
  const childEnv = (): Record<string, string> =>
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && (KEEP_ENV.has(entry[0]) || entry[0].startsWith("AGENTSOCKS_") || entry[0].startsWith("LC_"))));
  const sink = deps.randomBytes(12).toString("hex");

  const running = new Set<{ kill(signal?: NodeJS.Signals): boolean }>();
  let attached: string | undefined;
  let live: Context | undefined;
  let ticker: unknown;
  let polling: AbortController | undefined;
  let failures = 0;
  let backoffUntil = 0;
  let hooksPausedUntil = 0;
  let closed = false;
  let runs = 0;

  const parse = (text: string): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const noticeLines = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const lines = value.split("\n").filter((line) => line.startsWith(PREFIX));
    return lines.length > 0 ? lines.join("\n") : undefined;
  };

  const killAll = (): void => {
    for (const child of running) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };

  const run = (args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; timedOut: boolean }> =>
    new Promise((resolve) => {
      let stdout = "";
      let timedOut = false;
      let settled = false;
      let child: ReturnType<typeof deps.spawn>;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        running.delete(child);
        resolve({ stdout, timedOut });
      };
      const stop = () => {
        try {
          child.kill("SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      try {
        child = deps.spawn(deps.node, [deps.cli, ...args], { stdio: ["pipe", "pipe", "ignore"], env: childEnv() });
      } catch {
        clearTimeout(timer);
        resolve({ stdout, timedOut });
        return;
      }
      running.add(child);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stdout!.on("error", () => {});
      child.on("error", finish);
      child.on("close", finish);
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    });

  const approvalMode = async (): Promise<string | undefined> => {
    try {
      const mode = await deps.approvalMode?.();
      return typeof mode === "string" && mode !== "" ? mode : undefined;
    } catch {
      return undefined;
    }
  };

  const sendHook = async (event: string, session: string, extra: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> => {
    if (Date.now() < hooksPausedUntil) return {};
    const permissionMode = await approvalMode();
    const reply = await run(["hook", "omp", event], JSON.stringify({ session, remote: sink, ...extra, ...(permissionMode && { permissionMode }) }), timeoutMs);
    if (reply.timedOut) hooksPausedUntil = Date.now() + HOOK_PAUSE_MS;
    return parse(reply.stdout);
  };

  const hookQueues = new Map<string, Promise<unknown>>();
  const hook = (event: string, session: string, extra: Record<string, unknown> = {}, timeoutMs: number = HOOK_TIMEOUT_MS): Promise<Record<string, unknown>> => {
    const reply = (hookQueues.get(session) ?? Promise.resolve()).then(() => sendHook(event, session, extra, timeoutMs));
    const tail = reply.catch(() => undefined);
    hookQueues.set(session, tail);
    void tail.then(() => {
      if (hookQueues.get(session) === tail) hookQueues.delete(session);
    });
    return reply;
  };

  const sessionNameUsable = (name: string): boolean => {
    const lowered = name.toLowerCase();
    if (["(remote)", "(phone)", "(api)", "(guest)"].some((m) => lowered.includes(m))) return false;
    return !name.includes("@");
  };

  const isRoot = (ctx: Context | undefined): boolean => ctx?.agent?.kind === "main";

  const sessionOf = (ctx: Context): string | undefined => {
    try {
      const id = ctx.sessionManager?.getSessionId?.();
      return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
      return undefined;
    }
  };

  const wellFormed = (line: string): boolean => line.length <= MAX_LINE && line.split("\n").every((one) => one.startsWith(PREFIX));

  const deliver = async (line: string, nudge: boolean): Promise<boolean> => {
    const ctx = live;
    const id = attached;
    if (closed || !ctx || !id || !wellFormed(line)) return false;
    let idle = false;
    try {
      idle = !nudge && ctx.isIdle?.() === true;
      pi.sendMessage({ customType: NOTICE_TYPE, content: line, display: true }, { deliverAs: "aside" });
    } catch {
      return false;
    }
    if (!idle) return true;
    for (let waited = 0; waited < TURN_START_MS; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (ctx.isIdle?.() !== true) {
        await hook("UserPromptSubmit", id, { prompt: line });
        return true;
      }
    }
    return true;
  };

  const tick = async (): Promise<void> => {
    if (closed || polling || !attached || Date.now() < backoffUntil) return;
    const abort = new AbortController();
    polling = abort;
    try {
      const reply = await run(["hook", "omp", "wake"], JSON.stringify({ sink, timeoutMs: POLL_MS }), POLL_MS + 15_000, abort.signal);
      if (abort.signal.aborted) return;
      const wakes = parse(reply.stdout).wakes;
      if (!Array.isArray(wakes)) {
        failures++;
        backoffUntil = Date.now() + Math.min(60_000, 1000 * 2 ** failures);
        return;
      }
      failures = 0;
      for (const wake of wakes as { session?: unknown; line?: unknown }[]) {
        if (typeof wake?.session === "string" && wake.session === attached && typeof wake.line === "string") await deliver(wake.line, false);
      }
    } catch {
    } finally {
      if (polling === abort) polling = undefined;
    }
  };

  const attach = async (ctx: Context): Promise<string | undefined> => {
    const id = closed ? undefined : sessionOf(ctx);
    if (!id) return undefined;
    live = ctx;
    if (attached === id) return id;
    const previous = attached;
    attached = id;
    if (previous) await hook("SessionEnd", previous, {}, END_TIMEOUT_MS);
    let ownName: string | undefined;
    try {
      const name = pi.getSessionName?.();
      const trimmed = typeof name === "string" && name.trim() ? name.trim() : undefined;
      ownName = trimmed && !/^[0-9a-fA-F]{6,64}$/.test(trimmed) && sessionNameUsable(trimmed) ? trimmed : undefined;
    } catch {
      ownName = undefined;
    }
    await hook("SessionStart", id, { cwd: ctx.cwd, ...(ownName && { name: ownName }) });
    if (!ticker && typeof ctx.setInterval === "function") ticker = ctx.setInterval(() => tick(), TICK_MS);
    return id;
  };

  const detach = async (ctx: Context): Promise<void> => {
    const id = attached;
    closed = true;
    attached = undefined;
    live = undefined;
    if (ticker !== undefined) {
      try {
        ctx.clearTimer?.(ticker);
      } catch {}
      ticker = undefined;
    }
    polling?.abort();
    killAll();
    if (id) await hook("SessionEnd", id, {}, END_TIMEOUT_MS);
  };

  const guarded =
    (handler: (event: Event, ctx: Context) => Promise<unknown>) =>
    async (event: Event, ctx: Context): Promise<unknown> => {
      try {
        return await handler(event, ctx);
      } catch {
        return undefined;
      }
    };

  const call = async (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, ctx: Context): Promise<string> => {
    if (!isRoot(ctx)) throw new Error("agentsocks is not available inside a subagent session");
    const id = await attach(ctx);
    if (!id) throw new Error("agentsocks could not tell which OMP session this is; call the tool again");
    const wait = name === "wait_for_message" ? (typeof args?.timeout_seconds === "number" ? args.timeout_seconds : 60) * 1000 + 20_000 : 0;
    const where = typeof ctx.cwd === "string" && ctx.cwd !== "" ? ["--cwd", ctx.cwd] : [];
    const reply = await run(["tool", "omp", name, "--session", id, ...where], JSON.stringify(args ?? {}), TOOL_TIMEOUT_MS + wait, signal);
    const last = reply.stdout.trim().split("\n").pop() ?? "";
    const outcome = parse(last);
    if (typeof outcome.text !== "string") throw new Error(reply.timedOut ? `agentsocks ${name} timed out` : signal?.aborted ? `agentsocks ${name} was cancelled` : `agentsocks ${name} failed to run`);
    if (outcome.isError) throw new Error(outcome.text);
    return outcome.text;
  };

  for (const entry of deps.tools) {
    pi.registerTool({
      name: `${TOOL_PREFIX}${entry.name}`,
      label: entry.label,
      description: entry.description,
      parameters: pi.zod.object(entry.params(pi.zod)),
      loadMode: "essential",
      approval: entry.readOnly ? "read" : "write",
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => ({ content: [{ type: "text", text: await call(entry.name, params, signal, ctx) }] }),
    });
  }

  const sessionChanged = guarded(async (_event, ctx) => {
    if (isRoot(ctx)) await attach(ctx);
  });
  pi.on("session_start", sessionChanged);
  pi.on("session_switch", sessionChanged);
  pi.on("session_branch", sessionChanged);

  pi.on(
    "session_shutdown",
    guarded(async (_event, ctx) => {
      if (isRoot(ctx)) await detach(ctx);
    }),
  );

  pi.on(
    "before_agent_start",
    guarded(async (event, ctx) => {
      if (!isRoot(ctx)) return undefined;
      const id = await attach(ctx);
      if (!id) return undefined;
      const prompt = typeof event.prompt === "string" ? event.prompt.slice(0, 1000) : "";
      const notice = noticeLines((await hook("UserPromptSubmit", id, { prompt })).context);
      return notice ? { message: { customType: NOTICE_TYPE, content: notice, display: false } } : undefined;
    }),
  );

  pi.on(
    "tool_result",
    guarded(async (event, ctx) => {
      const tool = event.toolName;
      if (!isRoot(ctx) || typeof tool !== "string" || tool.startsWith(TOOL_PREFIX)) return undefined;
      const id = await attach(ctx);
      if (!id) return undefined;
      const notice = noticeLines((await hook("PostToolUse", id, { tool })).context);
      return notice ? { additionalContext: notice } : undefined;
    }),
  );

  pi.on(
    "agent_start",
    guarded(async (_event, ctx) => {
      if (isRoot(ctx)) runs++;
      return undefined;
    }),
  );

  pi.on(
    "agent_end",
    guarded(async (event, ctx) => {
      const settled = runs;
      if (!isRoot(ctx) || event.willContinue === true) return undefined;
      const id = await attach(ctx);
      if (!id) return undefined;
      const line = noticeLines((await hook("Stop", id)).block);
      if (line && settled === runs) await deliver(line, true);
      return undefined;
    }),
  );
}
