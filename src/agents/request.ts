import type { HookRequest } from "../broker.ts";
import { redactSecrets } from "../redact.ts";
import { threadIdFor, type InboxAgentId } from "./types.ts";

export interface AgentHookFields {
  session: unknown;
  event: HookRequest["event"];
  cwd?: unknown;
  prompt?: unknown;
  toolName?: unknown;
  source?: unknown;
  remote?: string;
  permissionMode?: unknown;
  name?: unknown;
}

export function agentHookRequest(agent: InboxAgentId, f: AgentHookFields): HookRequest | undefined {
  const threadId = threadIdFor(agent, f.session);
  if (!threadId) return undefined;
  return {
    threadId,
    agent,
    event: f.event,
    ...(typeof f.cwd === "string" && f.cwd && { cwd: f.cwd }),
    ...(typeof f.permissionMode === "string" && f.permissionMode && { permissionMode: f.permissionMode.slice(0, 64) }),
    ...(typeof f.source === "string" && { source: f.source }),
    ...(typeof f.prompt === "string" && { prompt: redactSecrets(f.prompt).slice(0, 500) }),
    ...(typeof f.toolName === "string" && { toolName: f.toolName.slice(0, 64) }),
    ...(f.remote && { remote: f.remote }),
    ...(typeof f.name === "string" && f.name && { name: f.name }),
  };
}
