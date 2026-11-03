import { spawn } from "node:child_process";
import { stableCwd } from "../paths.ts";

export const SERVE_HTTPS_PORT = 443;
export const FUNNEL_HTTPS_PORT = 8443;

const target = (port: number): string => `http://127.0.0.1:${port}`;

export const serveCommand = (port: number): string[] => ["tailscale", "serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, target(port)];
export const serveOffCommand = (port: number): string[] => ["tailscale", "serve", `--https=${SERVE_HTTPS_PORT}`, target(port), "off"];
export const funnelCommand = (port: number): string[] => ["tailscale", "funnel", "--bg", `--https=${FUNNEL_HTTPS_PORT}`, target(port)];
export const funnelOffCommand = (port: number): string[] => ["tailscale", "funnel", `--https=${FUNNEL_HTTPS_PORT}`, target(port), "off"];
export const cloudflaredCommand = (port: number): string[] => ["cloudflared", "tunnel", "--url", target(port)];
export const render = (argv: readonly string[]): string => argv.join(" ");
export const SERVE_EXPLAINED = "makes this listener reachable over HTTPS by your own devices on your tailnet, and by nothing else";
export const FUNNEL_EXPLAINED = "makes the public listener reachable by anyone on the internet who has a token or the pairing code";

export const tailscaleTimeoutCapMs = 300_000;
export const tailscaleTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => Math.min(Number(env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS) || 30_000, tailscaleTimeoutCapMs);
export const offCallTimeoutMs = (): number => tailscaleTimeoutCapMs * 2 + 5_000;
export function runCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [program = "", ...rest] = argv;
  const bin = program === "tailscale" ? env.AGENTSOCKS_TAILSCALE_BIN || program : program;
  return new Promise((resolve) => {
    const child = spawn(bin, rest, { cwd: stableCwd(), stdio: "inherit" });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, tailscaleTimeoutMs(env));
    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`could not run ${program}: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
