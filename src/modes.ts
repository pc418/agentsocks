import type { Mode } from "./envelope.ts";

// A local agent session counts as bypassing unless it reports a mode that asks before acting.
// Values a session reports that are not listed here, `auto`-like ones included, read as bypass.
const ASKING_MODES: Readonly<Record<string, ReadonlySet<string>>> = {
  codex: new Set(["plan"]),
  omp: new Set(["always-ask", "always-ask-cached"]),
};

const ASKING_APPROVAL = "untrusted";

// Which classification wrote threads.mode. A stored mode written under an earlier one (mode_rule null: every Codex
// mode but bypassPermissions was prompting then) is derived again from the Codex state DB at the next registration.
export const MODE_RULE = 1;

export function modeFromReported(agent: string, reported: string | undefined | null): Mode | null {
  if (!reported) return null;
  return ASKING_MODES[agent]?.has(reported) ? "prompting" : "bypass";
}

export function modeFromApproval(approvalMode: string | undefined | null): Mode | null {
  if (!approvalMode) return null;
  return approvalMode === ASKING_APPROVAL ? "prompting" : "bypass";
}

// The mode a local agent session sends with: what it reported, and bypass when it never reported one.
// Only the sender's identity uses it; the gateway's check on remote peers reaching a bypassing session reads the stored mode.
export function localSessionMode(stored: string | null | undefined): Mode {
  return stored === "prompting" ? "prompting" : "bypass";
}
