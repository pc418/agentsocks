import { existsSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { brokerSocketPath, claudeSessionsDir, killSwitchOn, runtimeDir } from "../paths.ts";
import { VERSION } from "../version.ts";
import { brokerCall } from "../client.ts";
import { brokerCwdCheck, processCwd } from "../procinfo.ts";
import { findOwnClaudeSession } from "../claude.ts";
import { agentReports, hookTrustStatus, runningBuildLine } from "../install.ts";
import { statusLine as listAgentsStatus } from "../claudelist.ts";
import { AGENT_LABELS } from "../agents/types.ts";
import { RELOAD_STEPS, listPeers } from "../peers.ts";
import { brokerDisagrees, keySource, routingLine } from "../classifiercmd.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

const checkLine = (ok: boolean, label: string, detail = ""): string => `${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`;

function check(ok: boolean, label: string, detail = ""): boolean {
  console.log(checkLine(ok, label, detail));
  return ok;
}

export const doctor: Handler = async () => {
  let healthy = true;
  const [major, minor] = process.versions.node.split(".").map(Number);
  healthy = check(major! > 22 || (major === 22 && minor! >= 13), "node >= 22.13", process.versions.node) && healthy;
  healthy = check(!killSwitchOn(), "kill switch off") && healthy;
  if (process.platform !== "linux") console.log(`note: the typing guard is Linux only, so on ${process.platform} a wake is never held while someone types`);
  try {
    const p = await brokerCall<{ pid: number; version: string; threads: number; build?: string }>("ping");
    const buildLine = p.version === VERSION ? runningBuildLine(p.pid, p.build) : undefined;
    const detail =
      p.version === VERSION
        ? `pid ${p.pid}, v${p.version}, ${p.threads} codex inboxes, ${brokerSocketPath()}${buildLine === undefined ? "" : `; ${buildLine}`}`
        : `pid ${p.pid}, v${p.version}, ${p.threads} codex inboxes, ${brokerSocketPath()}; this is v${VERSION}, so run \`agentsocks install\` (or kill ${p.pid}) and the next command starts the new one`;
    healthy = check(p.version === VERSION && buildLine === undefined, "broker", detail) && healthy;
    const cwd = brokerCwdCheck(p.pid, processCwd(p.pid), existsSync, process.platform);
    if (cwd.status === "unknown") console.log(`note: broker working directory unknown — ${cwd.detail}`);
    else healthy = check(cwd.status === "ok", "broker working directory", cwd.detail) && healthy;
  } catch (err) {
    healthy = check(false, "broker", (err as Error).message) && healthy;
  }
  const rt = runtimeDir();
  if (existsSync(rt)) check((lstatSync(rt).mode & 0o777) === 0o700, "runtime dir is private", rt);
  check(existsSync(claudeSessionsDir()), "Claude session registry", claudeSessionsDir());
  const own = findOwnClaudeSession();
  if (own) console.log(await frame(checkLine(true, "running inside Claude Code", `${own.name}, inbox ${own.socketPath}`)));
  const claudeMcp = spawnSync("claude", ["mcp", "get", "agentsocks"], { stdio: "ignore" }).status === 0;
  healthy = check(claudeMcp, "Claude MCP server registered") && healthy;
  const queue = spawnSync("codex", ["queue", "--help"], { stdio: "ignore" }).status === 0;
  check(queue, "codex queue available (idle wake)", queue ? "" : "Codex will receive by tools and hooks only");
  const trust = hookTrustStatus();
  for (const t of trust) {
    check(t.present && t.trusted, `codex hook ${t.event}`, !t.present ? "not installed" : t.trusted ? "trusted" : "installed, needs /hooks approval");
  }
  for (const { id, live, status } of agentReports()) {
    const label = `${AGENT_LABELS[id]} (${id})`;
    const tail = live === "verified" ? "" : ", untested live";
    if (status.state === "not installed") console.log(`note: ${label} is not installed on this machine`);
    else if (status.state === "not wired") console.log(`note: ${label} is installed but not wired; run \`agentsocks install --${id}\`${status.detail.length ? ` (${status.detail.join("; ")})` : ""}`);
    else healthy = check(status.state === "wired", `${label} integration`, `${status.state}${tail}${status.detail.length ? `: ${status.detail.join("; ")}` : ""}`) && healthy;
  }
  const unconnected = (await listPeers({ includeUnconnected: true })).filter((p) => p.connected === false);
  if (unconnected.length > 0) {
    const names = unconnected.map((p) => `${p.name} [${p.ref}]`).join(", ");
    const note = [
      `note: ${unconnected.length} recent Codex thread${unconnected.length === 1 ? " is" : "s are"} not connected yet (no agentsocks hook has run in ${unconnected.length === 1 ? "it" : "them"}): ${names}`,
      `      A message still wakes ${unconnected.length === 1 ? "it" : "them"} and ${unconnected.length === 1 ? "it reads" : "they read"} with \`agentsocks inbox\`. To give one full tools: ${RELOAD_STEPS}.`,
    ];
    console.log(await frame(note.join("\n")));
  }
  console.log(listAgentsStatus());
  console.log(routingLine());
  const key = keySource();
  if (key) check(true, "smart routing key", key);
  const disagreement = await brokerDisagrees();
  if (disagreement) console.log(disagreement);
  return healthy ? 0 : 1;
};
