import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stableCwd } from "./paths.ts";

export interface ProcSource {
  read(path: string): string | undefined;
  ps(args: string[]): string | undefined;
}

export const systemProc: ProcSource = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  ps(args) {
    try {
      return execFileSync("ps", args, { cwd: stableCwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  },
};

export const hasProcfs = (platform: NodeJS.Platform): boolean => platform === "linux" || platform === "android";

const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(")") + 2).split(" ");

function parseStatParent(stat: string): number | undefined {
  const ppid = Number(statFields(stat)[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

function parsePsParent(out: string | undefined): number | undefined {
  const text = out?.trim();
  if (!text) return undefined;
  const ppid = Number(text);
  return Number.isInteger(ppid) ? ppid : undefined;
}

export function parentPid(pid: number, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): number | undefined {
  if (hasProcfs(platform)) {
    const stat = src.read(`/proc/${pid}/stat`);
    const fromProc = stat === undefined ? undefined : parseStatParent(stat);
    if (fromProc !== undefined) return fromProc;
  }
  return parsePsParent(src.ps(["-o", "ppid=", "-p", String(pid)]));
}

export function processStart(pid: number, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): string | undefined {
  if (!hasProcfs(platform)) return undefined;
  const stat = src.read(`/proc/${pid}/stat`);
  return stat === undefined ? undefined : statFields(stat)[19] || undefined;
}

// ps joins the arguments with spaces, so a path containing a space comes back split; callers match whole words, which survives that
export function processArgs(pid: number, platform: NodeJS.Platform = process.platform, src: ProcSource = systemProc): string[] | undefined {
  if (hasProcfs(platform)) {
    const raw = src.read(`/proc/${pid}/cmdline`);
    if (raw !== undefined) return raw.split("\0");
  }
  const line = src.ps(["-ww", "-o", "args=", "-p", String(pid)])?.trim();
  return line ? line.split(/\s+/) : undefined;
}

export interface CwdSource {
  readlink(path: string): string | undefined;
  lsof(args: string[]): string | undefined;
}

export const systemCwd: CwdSource = {
  readlink(path) {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  },
  lsof(args) {
    try {
      return execFileSync("lsof", args, { cwd: stableCwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    } catch (err) {
      return (err as { stdout?: string }).stdout || undefined;
    }
  },
};

const DELETED = " (deleted)";

export function processCwd(pid: number, platform: NodeJS.Platform = process.platform, src: CwdSource = systemCwd): { path: string; deleted: boolean } | undefined {
  if (hasProcfs(platform)) {
    const link = src.readlink(`/proc/${pid}/cwd`);
    if (link === undefined) return undefined;
    return link.endsWith(DELETED) ? { path: link.slice(0, -DELETED.length), deleted: true } : { path: link, deleted: false };
  }
  const name = src
    .lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    ?.split("\n")
    .find((line) => line.startsWith("n"));
  return name && name.length > 1 ? { path: name.slice(1), deleted: false } : undefined;
}

export function brokerCwdCheck(pid: number, cwd: { path: string; deleted: boolean } | undefined, exists: (path: string) => boolean, platform: NodeJS.Platform): { status: "ok" | "gone" | "unknown"; detail: string } {
  if (!cwd) return { status: "unknown", detail: `could not be read (${hasProcfs(platform) ? `/proc/${pid}/cwd` : "lsof"} gave nothing), so whether it still exists is not checked` };
  if (cwd.deleted || !exists(cwd.path)) return { status: "gone", detail: `${cwd.path} no longer exists, so its child processes fail; run \`agentsocks install\` (or kill ${pid}) and the next command starts a broker that works from the home directory` };
  return { status: "ok", detail: cwd.path };
}

export function validKillTarget(pid: unknown): pid is number {
  return Number.isSafeInteger(pid) && (pid as number) > 1 && pid !== process.pid && pid !== process.ppid;
}

export function buildHash(dir: string): string | undefined {
  const names: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const at = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile()) names.push(at);
    }
  };
  try {
    walk("");
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  const hash = createHash("sha256");
  try {
    for (const name of names.sort()) hash.update(name).update("\0").update(readFileSync(join(dir, name))).update("\0");
  } catch {
    return undefined;
  }
  return hash.digest("hex");
}
