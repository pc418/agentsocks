import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";
import { ompAgent } from "../src/agents/omp.ts";
import { threadIdFor } from "../src/agents/index.ts";
import { agentIdentity, codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";

// A local agent session's message carries bypass unless the session reports a mode
// that asks before acting (Codex plan, OMP always-ask / always-ask-cached); a session that reports nothing counts
// as bypass. A Claude session that bypasses permissions holds a message whose sender attests no mode, or prompting.
const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });
let claude: FakeClaude;

before(async () => {
  await broker.start();
  claude = await fakeClaude("modereceiver", livePid(), "idle");
});

after(async () => {
  await closeServer(claude.server);
  await broker.stop();
});

async function fromMode(me: Me, body: string): Promise<string | undefined> {
  const r = await sendMessage(me, claude.name, body);
  const frame = await until(() => claude.frames.find((f) => f.msg_id === r.msgId));
  const env = parseEnvelope(messageContent(frame));
  assert.ok(env, "the envelope parses");
  assert.equal(env.body, body);
  return env.fromMode;
}

const ompHook = (event: string, session: string, extra: Record<string, unknown> = {}) =>
  ompAgent.hook!({ event, input: { session, cwd: `/work/${session}`, ...extra }, call: (req) => broker.hook(req) });

test("an OMP session that reports no approval mode sends as bypass", async () => {
  await ompHook("SessionStart", "omp-quiet");
  assert.equal(broker.store.getThread(threadIdFor("omp", "omp-quiet")!)!.mode, null, "nothing was reported, so nothing is stored");
  const me = await agentIdentity("omp", "omp-quiet", "/work/omp-quiet");
  assert.equal(me.mode, "bypass");
  assert.equal(await fromMode(me, "from an OMP session with no reported mode"), "bypass");
});

test("an OMP session's reported approval mode decides its sender mode, and follows a change", async () => {
  const threadId = threadIdFor("omp", "omp-asking")!;
  await ompHook("SessionStart", "omp-asking", { permissionMode: "always-ask" });
  assert.equal(broker.store.getThread(threadId)!.mode, "prompting");
  const asking = await agentIdentity("omp", "omp-asking", "/work/omp-asking");
  assert.equal(asking.mode, "prompting", "a tool call's registration, which reports no mode, keeps the one the hook stored");
  assert.equal(await fromMode(asking, "from an always-ask OMP session"), "prompting");
  await ompHook("PostToolUse", "omp-asking", { tool: "bash", permissionMode: "yolo" });
  const yolo = await agentIdentity("omp", "omp-asking", "/work/omp-asking");
  assert.equal(await fromMode(yolo, "from the same session after /settings switched it to yolo"), "bypass");
  await ompHook("PostToolUse", "omp-asking", { tool: "bash", permissionMode: "always-ask-cached" });
  assert.equal((await agentIdentity("omp", "omp-asking", "/work/omp-asking")).mode, "prompting", "and back again");
});

test("a Codex session in the Auto preset sends as bypass; one in plan mode sends as prompting", async () => {
  await broker.hook({ threadId: "thread-auto-1", event: "SessionStart", cwd: "/work/auto", permissionMode: "default" });
  assert.equal(await fromMode(await codexIdentity("thread-auto-1"), "from Codex on-request"), "bypass");
  await broker.hook({ threadId: "thread-plan-1", event: "SessionStart", cwd: "/work/plan", permissionMode: "plan" });
  assert.equal(await fromMode(await codexIdentity("thread-plan-1"), "from Codex in plan mode"), "prompting");
});

test("a Codex thread with no hook report and no state-DB row sends as bypass", async () => {
  await broker.register("thread-unknown-1", { cwd: "/work/unknown" });
  assert.equal(broker.store.getThread("thread-unknown-1")!.mode, null);
  assert.equal(await fromMode(await codexIdentity("thread-unknown-1"), "from a Codex thread with no known mode"), "bypass");
});

test("a plain shell sender still attests no mode", async () => {
  assert.equal(await fromMode({ kind: "cli", name: "cli-shell" }, "from a shell"), undefined);
});
