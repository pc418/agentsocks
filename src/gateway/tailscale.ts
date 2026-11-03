import { execFile } from "node:child_process";
import { stableCwd } from "../paths.ts";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { isIP } from "node:net";

export interface Whois {
  login: string;
  displayName: string;
  node: string;
  nodeId: string;
  os: string | null;
  tagged: boolean;
}

export interface SelfInfo {
  login: string;
  dnsName: string;
}

export interface Tailnet {
  whois(ip: string): Promise<Whois | undefined>;
  self(): Promise<SelfInfo | undefined>;
}

const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseWhois(raw: unknown): Whois | undefined {
  const top = record(raw);
  const node = record(top?.Node);
  const profile = record(top?.UserProfile);
  const login = str(profile?.LoginName).trim();
  const fqdn = str(node?.Name).trim();
  if (!node || !login || !fqdn) return undefined;
  const tags = Array.isArray(node.Tags) ? node.Tags : [];
  const hostinfo = record(node.Hostinfo);
  return {
    login,
    displayName: str(profile?.DisplayName),
    node: fqdn.replace(/\.$/, "").split(".")[0]!,
    nodeId: str(node.StableID) || str(node.ID) || fqdn,
    os: str(hostinfo?.OS) || null,
    tagged: tags.length > 0,
  };
}

export function parseSelf(raw: unknown): SelfInfo | undefined {
  const top = record(raw);
  const self = record(top?.Self);
  const users = record(top?.User);
  const userId = self?.UserID;
  const profile = record(users?.[String(userId)]);
  const login = str(profile?.LoginName).trim();
  const dnsName = str(self?.DNSName).trim().replace(/\.$/, "");
  return login && dnsName ? { login, dnsName } : undefined;
}

export const whoisAddress = (ip: string): string => (isIP(ip) === 6 ? `[${ip}]:0` : `${ip}:0`);

export function socketCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.TS_SOCKET, "/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock"].filter((p): p is string => !!p);
}

class LocalApiDenied extends Error {}

function localApi(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", headers: { Host: "local-tailscaled.sock", "Sec-Tailscale": "localapi" }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 1_000_000) req.destroy(new Error("LocalAPI answer too large"));
        else chunks.push(c);
      });
      res.on("end", () => {
        if (res.statusCode === 404) return reject(new LocalApiDenied(`LocalAPI has no such entry for ${path}`));
        if (res.statusCode !== 200) return reject(new Error(`LocalAPI answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("LocalAPI timed out")));
    req.on("error", reject);
    req.end();
  });
}

function cli(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: stableCwd(), timeout: timeoutMs, maxBuffer: 1_000_000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export interface TailnetOptions {
  sockets?: () => string[];
  bin?: () => string;
  timeoutMs?: number;
  cacheMs?: number;
  selfCacheMs?: number;
  now?: () => number;
}

const CLI_PATHS = ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];

export function tailscaleBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTSOCKS_TAILSCALE_BIN;
  if (override) return override;
  for (const candidate of CLI_PATHS) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return CLI_PATHS[0]!;
}

export function localTailnet(opts: TailnetOptions = {}): Tailnet {
  const sockets = opts.sockets ?? (() => socketCandidates());
  const bin = opts.bin ?? (() => tailscaleBin());
  const timeoutMs = opts.timeoutMs ?? 3000;
  const cacheMs = opts.cacheMs ?? 30_000;
  const selfCacheMs = opts.selfCacheMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const whoisCache = new Map<string, { at: number; value: Whois | undefined }>();
  let selfCache: { at: number; value: SelfInfo | undefined } | undefined;

  async function ask(localPath: string, cliArgs: string[]): Promise<unknown> {
    const present = sockets().filter((s) => existsSync(s));
    if (present.length === 0) return cli(bin(), cliArgs, timeoutMs + 2000);
    let lastError: unknown = new Error("no tailscale socket answered");
    for (const socket of present) {
      try {
        return await localApi(socket, localPath, timeoutMs);
      } catch (err) {
        if (err instanceof LocalApiDenied) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async function whoisOf(ip: string): Promise<Whois | undefined> {
    if (!isIP(ip)) return undefined;
    const hit = whoisCache.get(ip);
    if (hit && now() - hit.at < (hit.value ? cacheMs : 5000)) return hit.value;
    let value: Whois | undefined;
    try {
      value = parseWhois(await ask(`/localapi/v0/whois?addr=${encodeURIComponent(whoisAddress(ip))}`, ["whois", "--json", ip]));
    } catch {
      value = undefined;
    }
    if (whoisCache.size > 256) whoisCache.clear();
    whoisCache.set(ip, { at: now(), value });
    return value;
  }

  async function selfByWhois(raw: unknown): Promise<SelfInfo | undefined> {
    const self = record(record(raw)?.Self);
    const dnsName = str(self?.DNSName).trim().replace(/\.$/, "");
    const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.filter((v): v is string => typeof v === "string") : [];
    if (!dnsName) return undefined;
    for (const ip of ips) {
      const who = await whoisOf(ip);
      if (who && !who.tagged) return { login: who.login, dnsName };
    }
    return undefined;
  }

  return {
    whois: whoisOf,
    async self() {
      if (selfCache && now() - selfCache.at < (selfCache.value ? selfCacheMs : Math.min(5000, selfCacheMs))) return selfCache.value;
      let value: SelfInfo | undefined;
      try {
        const raw = await ask("/localapi/v0/status?peers=false", ["status", "--json", "--peers=false"]);
        value = parseSelf(raw) ?? (await selfByWhois(raw));
      } catch {
        value = undefined;
      }
      selfCache = { at: now(), value };
      return value;
    },
  };
}
