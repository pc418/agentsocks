# agentsocks guide

Everything the [README](../README.md) leaves out: how `agentsocks install` wires each agent, using it from a shell, every agent integration, attention routing, tasks, channels, asks, ratings, `agentsocks top`, delivery states, the gateway, and security.

- [A 30-second demo](#a-30-second-demo)
- [What `agentsocks install` does](#what-agentsocks-install-does)
- [Using it](#using-it)
- [More agents (v0.4)](#more-agents-v04)
- [Attention routing (v0.2)](#attention-routing-v02)
- [Tasks](#tasks)
- [Workers and drivers (v0.4, experimental)](#workers-and-drivers-v04-experimental)
- [Channels and broadcast (v0.4, experimental)](#channels-and-broadcast-v04-experimental)
- [Asking several sessions (v0.4, experimental)](#asking-several-sessions-v04-experimental)
- [Learning from ratings (v0.4, experimental)](#learning-from-ratings-v04-experimental)
- [Watching it: `agentsocks top` (v0.4, experimental)](#watching-it-agentsocks-top-v04-experimental)
- [Is it getting there?](#is-it-getting-there)
- [How delivery works](#how-delivery-works)
- [Beyond this machine (v0.4, experimental)](#beyond-this-machine-v04-experimental)
- [Security](#security)

## A 30-second demo

Two sessions are running in different terminals: `api-worker` in Claude Code, and a Codex session in
a web project. You tell Codex: "tell api-worker the migration is done and the new column is tenant_id".
Codex looks up who is running and sends the message with its `agentsocks` tools. The Claude session
shows it like any other cross-session message:

```text
› Message from @codex-web (codex): Migration is done; the new column is tenant_id. (ctrl+o to expand)
```

Claude answers with its built-in `SendMessage`. The idle Codex session wakes with a short agentsocks
line, reads the answer with a tool, and replies with another:

```text
› 📨 agentsocks: new message from a Claude Code session. Read it with read_inbox.
• Called agentsocks.read_inbox
• Called agentsocks.send_message
  └ Sent to @api-worker [064c2f] (claude), message id 1c8a0f3e-.... Delivered. They see it at their
    next tool call, or right away if idle.
```

You can do the same from any shell:

```text
$ agentsocks list
api-worker [064c2f]  claude  idle  /work/api
codex-web [9334a8]  codex  idle  /work/web

$ agentsocks send api-worker "the rebase is safe now"
sent 724739a7-6bac-48cc-b4eb-862ce1708fdb to @api-worker [064c2f] (claude) as @cli-web, routed now
Delivered. They see it at their next tool call, or right away if idle.
```

## What `agentsocks install` does

`agentsocks install` is idempotent and keeps backups of every file it edits under
`~/.local/state/agentsocks/backups/`. It:

- registers the `agentsocks` MCP server with Claude Code at user scope;
- adds `[mcp_servers.agentsocks]` to `~/.codex/config.toml`;
- appends five hooks to `~/.codex/hooks.json`, after your existing ones, so your hooks keep their
  positions and their trust;
- marks those five hooks trusted through Codex's own config API. Use `--no-trust-hooks` if you would
  rather approve them yourself in `/hooks`.

New sessions pick it up, including Codex sessions started through the shared app-server daemon
(it reads the config when each thread starts).

With no flag at all, `agentsocks install` also wires every other agent it finds on this machine (OpenCode,
Hermes, Cursor, Copilot CLI, Gemini CLI, OMP) and says which it skipped. An agent counts as found when its
config folder exists (`~/.hermes` or `$HERMES_HOME`, `~/.copilot` or `$COPILOT_HOME`), or its folder
exists or its program is on `PATH` (OpenCode's folder or `opencode`, Cursor's `~/.cursor` or `cursor-agent`,
Gemini's `settings.json` or `tmp` under `~/.gemini` or `$GEMINI_CLI_HOME`, or `gemini`; OMP's `~/.omp` or `omp`). Hermes and
Copilot need the folder because other programs are also called `hermes` and `copilot`; start the agent
once, or name it with `--hermes` or `--copilot`. A machine with no Codex is skipped for Codex. `--opencode`, `--hermes`, `--cursor`, `--copilot` and
`--gemini` and `--omp` wire just those, even when they are not found yet. Each of them is edited the same careful way
as Codex's files: every entry agentsocks adds can be recognised again (hook commands start with an
`AGENTSOCKS_HOOK=1` marker, and the MCP server is the one named `agentsocks` that runs agentsocks; a server of
that name that does not run agentsocks is left alone), every file it changes is backed up first and written
through a temporary file, a file it cannot parse is left exactly as it was, running install twice changes
nothing the second time, and `--dry-run` shows what would change. JSON files are rewritten with two-space
indentation, so comments (which the agents do not accept in them anyway) and unusual number formatting are
not kept. The folders can move with `OPENCODE_CONFIG_DIR`, `HERMES_HOME`, `COPILOT_HOME`,
`GEMINI_CLI_HOME` and, for OMP, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` and `OMP_PROFILE`, read when you install
and when you uninstall. `agentsocks install` exits 1 when
an agent you named could not be wired, and when a Codex or Claude step failed (the other agents are still
done). `agentsocks doctor` has one line per agent: wired, partly wired, installed but not wired, or not
installed, and `untested live` while nobody has run that agent end to end.

A Codex thread the shared app-server loaded before the install keeps its old config until it has had no
attached client and no running turn for 60 seconds, so it has no agentsocks tools or hooks. Restarting the terminal
client does not help while another client (a `codex agents` dashboard, say) stays attached or the thread is resumed within 60 seconds. `agentsocks list` shows the recent ones (updated in the last 12 hours, not
archived, started by a person and not spawned as a subagent) as `not connected yet`. A thread can be there because it started before the install or because its hooks have not run yet. A message to one still wakes it, it reads the message with `agentsocks
inbox`, and the first send registers it. `agentsocks doctor` lists them and says how to give one full
tools: close every client attached to it (its terminal and any `codex agents` dashboard), wait 60 seconds
with no turn running, then resume it. In `agentsocks list --json` every entry carries `connected`.
A subagent that registered through its own hooks is left out of the list; it still answers to its thread id
or ref, and to its name unless a session that is not a subagent has the same name, which goes to that session.

`agentsocks uninstall` removes all of it (backups are kept); your message history, audit.log and daemon.log stay in the state directory until you delete it.

## Using it

You don't need to do anything special. Ask an agent to tell another session something, or to ask it
a question, and it will.

**Tools** (MCP server `agentsocks`):

| Tool | Claude | Codex and the other agents | What it does |
|---|---|---|---|
| `list_peers` | ✓ | ✓ | Running Claude and Codex sessions, with names, refs, folders and status |
| `send_message` | ✓ | ✓ | Message a Codex session by name, ref, or reply address, with an urgency of `urgent`, `normal` or `fyi`. A Claude session calling it for a Claude target is pointed to its built-in `SendMessage` instead |
| `send_task` | ✓ | ✓ | Hand a session tracked work with acceptance criteria; you hear when it moves |
| `update_task` | ✓ | ✓ | Report progress on a task (accepted, in progress, done, failed) or cancel one you created |
| `list_tasks` | ✓ | ✓ | Tasks assigned to you or created by you |
| `message_status` | ✓ | ✓ | How a message you sent or received was routed, and whether it was sent, shown or answered |
| `peer_status` | ✓ | ✓ | What a session is doing next to what is asked of it, with drift flags |
| `subscribe`, `unsubscribe`, `list_channels` | ✓ | ✓ | v0.4: join or leave a `#topic` channel, and see who is in each (see Channels) |
| `broadcast` | ✓ | ✓ | v0.4: one message to every live session, at `fyi` or `normal` |
| `rate_message` | ✓ | ✓ | v0.4: rate a message you received useful-now, could-wait or noise (see Learning from ratings) |
| `ask`, `answer` | ✓ | ✓ | v0.4: ask up to 16 sessions one question and get the answers together; answer one you were asked (see Asking several sessions) |
| `read_inbox` | | ✓ | Read messages from other sessions |
| `wait_for_message` | | ✓ | Wait for the next message (for headless workers) |
| `set_name` | | ✓ | Choose the name other sessions see |
| `set_driver` | | ✓ | Name the local session that drives this one, or `none` |

Claude keeps using its built-in `SendMessage` and `ListAgents` for Claude peers, and can reply to a
Codex sender with `SendMessage` to the `from=` address on its message. `send_message` on the Claude
host does not send to a Claude session. agentsocks cannot attest a Claude sender's permission mode, so
the receiver would show its user a held-message approval prompt; the built-in `SendMessage` carries the
mode, so the tool returns that advice instead. The same goes for `agentsocks send` run inside a Claude
session. Codex senders and plain shells are unchanged, and `send_task` still tracks the task (see Tasks). Text a peer wrote (names, task
fields, notes) comes back in tool output inside a framed block marked as written by another session.

**CLI**:

```bash
agentsocks list                    # who is running, plus recent Codex threads that are not connected
agentsocks send api-worker "rebase is safe now"
agentsocks send --urgency fyi api-worker "lint is green"
agentsocks send '#deploys' "v2 is tagged"   # post to a channel (v0.4)
agentsocks channels                # channels with subscribers, and who is in each (v0.4)
agentsocks tasks                   # your active tasks (run inside a session); --all includes finished ones
agentsocks status <msg-id>         # how a message was routed and what became of it
agentsocks status api-worker       # what a session is doing and what is asked of it (your own name works too)
agentsocks stats                   # routing metrics per destination
agentsocks driver <peer|none>      # name this session's driver (workers and drivers, v0.4)
agentsocks top                     # live view of sessions and today's routing counts (v0.4)
agentsocks classifier              # smart routing: what is in effect, and how to change it
agentsocks eval-router             # score the router on the labelled set
agentsocks eval-router --own       # score it on your own rated messages (v0.4)
agentsocks labels export           # your ratings as JSONL, for fine-tuning a local model (v0.4)
agentsocks whoami                  # how this process is identified
agentsocks doctor                  # check the install
agentsocks gateway status          # v0.4: the gateway, remote peers and tokens (see Beyond this machine)
agentsocks link <host>             # v0.4: another machine's sessions as name@host
agentsocks peer add grok --api xai --key-file ~/xai.env --may-message api-worker # v0.4: a model behind an API as a peer
```

## More agents (v0.4)

OpenCode, Hermes, Cursor, GitHub Copilot CLI, Gemini CLI and OMP sessions are peers too, in the same inbox, with the same tools, routing, tasks and delivery states as Codex. A session of one of them shows up in `agentsocks list` and `list_peers` named after its folder (`opencode-api`, `cursor-web`, `omp-api`), with its agent as the kind, and a message to it is announced and read exactly as for Codex: the text reaches the model only as the result of `read_inbox` or `wait_for_message`, in the same marked frame.

**None of these integrations has been run live against this release.** Each was built from the agent's own documentation and tested against fixtures made from it and against a fake of the agent. They have not been run against the real programs with this release, `agentsocks doctor` says `untested live` next to each, and the first live run may find that an agent behaves differently from its documentation. Treat them as experimental.

| Agent | How it connects | How it hears about a message | Idle wake |
|---|---|---|---|
| OpenCode | A generated plugin, `plugins/agentsocks.js` in OpenCode's config folder, that gives the model the agentsocks tools | A one-line notice added to the next tool result; a one-line prompt when idle | Yes, through OpenCode's own client in the plugin |
| Hermes | An MCP server and five shell hooks in `config.yaml` (you approve the hooks once in Hermes) | A notice at the start of the next turn; one more turn at the end of an edit turn | Only if you run Hermes's API server and give agentsocks its key (`hermes` in `config.json`) |
| Cursor (CLI and IDE) | `~/.cursor/mcp.json` and `~/.cursor/hooks.json` | A notice after the next tool call; a follow-up message when the turn ends with messages unread | No |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` and one hooks file under `~/.copilot/hooks/` | A notice after the next tool call; one more turn when the model tries to finish | No |
| Gemini CLI | `mcpServers` and `hooks` in `~/.gemini/settings.json` | A notice after the next tool call; one more turn when the model finishes | No |
| OMP (oh-my-pi), full | A generated extension, `extensions/agentsocks.ts` in OMP's agent folder, that gives the model the agentsocks tools | A note after the next tool result; a hidden note before a turn; one more turn when the model finishes; a custom message when idle | Yes, through OMP's own `sendMessage` in the extension |

The agents that cannot be woken are pull-only: they hear nothing while idle, and a message waits until the session next calls a tool, finishes a turn, or is asked to read its inbox. The notices and nudges are counts and a sender kind, never message text, and a nudge at the end of a turn is limited to three in a row.

Hermes, Cursor, Copilot CLI and Gemini CLI do not say which session made an MCP call, so their pre-tool hook stamps the session into the arguments of agentsocks tools, signed with a key only your user can read, and the MCP server accepts a session only from a valid stamp ([SECURITY.md](../SECURITY.md) has the detail and its limits). Whether each agent really applies that rewrite to MCP tools is not documented, and it is the first thing a live run has to show. Gemini CLI also asks you to confirm each agentsocks tool on first use unless you allow the server; agentsocks never sets `trust`.

`agentsocks install` with no flags wires every one of them it finds. `--opencode`, `--hermes`, `--cursor`, `--copilot`, `--gemini` and `--omp` wire one, and `agentsocks uninstall` removes every entry it added (your own hooks and servers are left in place, each file is backed up first, and a file that does not parse is never touched).

**Aider is not supported.** It has no MCP client and no hooks, so there is nothing for agentsocks to attach to.

### OMP (oh-my-pi)

OMP is the one of these that gets the whole treatment, like OpenCode: tools, a note in the middle of a turn, a nudge at the end of one, and a wake when idle. It is also **untested live**. The extension targets OMP 18.10.3 (`doctor` says so, and calls another major partly wired). An earlier 0.4 build passed `scripts/live/omp.sh` against omp 18.10.3; this release has not been run live. `scripts/live/omp.sh` is the run that would show it.

- **How it connects.** `agentsocks install --omp` writes one file, `extensions/agentsocks.ts`, in OMP's agent folder (`~/.omp/agent`, or `$PI_CODING_AGENT_DIR`; `$PI_CONFIG_DIR` renames `~/.omp`; `OMP_PROFILE` or `PI_PROFILE` selects `~/.omp/profiles/<name>/agent`, and then `PI_CODING_AGENT_DIR` does not apply, as in OMP). Its first line marks it as ours, it is mode 600, and OMP loads it the next time it starts. `uninstall` deletes only a file with that marker, from the agent folder and from every profile folder.
- **Tools.** `agentsocks_list_peers`, `agentsocks_send_message`, `agentsocks_read_inbox`, `agentsocks_wait_for_message`, the task, channel, ask and rating tools: one for every tool the Codex route has, always loaded, with the `read` approval tier for the read-only ones and `write` for the rest (OMP's default mode, `yolo`, allows both). The prefix is there because OMP has its own `ask`. Each hook also reports the session's current `tools.approvalMode`, read from OMP's own settings (so `--approval-mode`, `--yolo` and a change in `/settings` count): `always-ask` and `always-ask-cached` send as `prompting`, `write` and `yolo` as `bypass`. The session a tool acts for is the one OMP says it is running, read from OMP when the tool is called, so a model cannot name another.
- **What the model is told.** After a tool result, when a message waits, OMP adds one line to the next request as context: `📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox before your next step.` A hidden note of the same kind goes in before a turn if one waits when you submit a prompt. When the model finishes with a message unread, one more turn is asked for with the finish-time line, at most three times in a row. The lines are counts and a sender kind, never message text.
- **Idle wake.** The extension long-polls the broker, and a message for an idle session starts a turn with the line `📨 agentsocks: new message from a Claude Code session. Read it with agentsocks_read_inbox.` as a custom message of type `agentsocks-notice`. The extension never types as the user. While the model is working the line goes in as an aside at the next step instead.
- **Subagents.** Only a top-level session is a peer. Subagents (`task`, `/tan` clones), an advisor and anything else OMP does not call the main agent get no tools, no notices and no wake.
- **Things to know.** Every line agentsocks hands OMP (a wake, a notice while the model is busy, the finish-time nudge) is an aside: an idle session starts a turn to read its mail, but in plan mode, or after you stop a turn with Esc, OMP folds the line into its context without starting a turn, so it waits until you type again. OMP's extension API changes between minors: `agentsocks doctor` prints the OMP version next to the one tested (18.10.3) and calls a different major `partly wired`. If OMP is set to read Claude Code's or Codex's config (`enabledProviders` lists `claude` or `codex`, or `CLAUDE_CONFIG_DIR` is set), the agentsocks servers registered there would start inside OMP with no session to attribute their calls to; `install` and `doctor` warn, and `disabledProviders` is the fix. The extension runs inside OMP with OMP's privileges and spawns `agentsocks` with a trimmed environment.


**Codex threads in Claude Code's own `ListAgents` (experimental, Linux, off by default).** `agentsocks install --claude-listagents` makes the broker write one record per live Codex thread into Claude Code's session registry (`~/.claude/sessions`), the way [claude-uds-bridge](https://github.com/LeonKohli/claude-uds-bridge) does, so Claude's built-in `ListAgents` shows them and `SendMessage` reaches them. A small holder process per thread supplies the live pid the registry needs. The broker removes the records when a thread ends or the broker stops, deletes only records it wrote (its ledger names them), and never touches the records of real sessions. It stays off unless you ask, and it has not been run against a live Claude Code. `agentsocks uninstall` turns it off and removes what it wrote.

## Attention routing (v0.2)

A message does not always have to interrupt. agentsocks decides, per message, from what the receiver
is doing and how many messages it has already had:

| Route | Meaning | Claude receiver | Codex receiver |
|---|---|---|---|
| `now` | At the receiver's next tool call, or at once if it is idle | priority `next` | announced at the next tool call; wakes an idle session |
| `pause` | When the receiver's current turn ends | priority `later` | not announced mid-turn; blocks `Stop` once; wakes an idle session |
| `digest` | Batch it | held, then one combined message (split if it is large) when the session is idle or after 15 minutes | held, released when the session is idle, reads its inbox or after 15 minutes; never wakes anyone |
| `merge` | Same text already delivered in the last 10 minutes | recorded, not delivered | recorded, not delivered |

**The default is `now`**, because a native Claude message already lands at the next tool call; the
protection against floods is the receiver's budget. Rules run first, in this order: a duplicate of
something already delivered is merged; a sender past 10 messages in 10 minutes is batched (urgent
messages and answers to a message the receiver sent are exempt); `fyi` is batched; an idle receiver
gets it now; an answer to a `now` or `pause` message the receiver sent in the last 30 minutes gets it
now, outside the budget; `urgent` gets it now unless the receiver was already interrupted six times in
10 minutes. Everything else is delivered now unless the receiver was interrupted three times in the last
10 minutes, in which case it is **paused**, or smart routing says otherwise. A receiver whose
state is unknown is not treated as idle. Repeating a message that is still held or paused, or was
sent in a digest that the receiver has not yet been shown or read, promotes it (urgent beats a digest)
instead of being merged away. Claude's priority `now` (which aborts the running
turn) is never used.

Every decision is recorded with its rule or backend, confidence and a one-sentence reason; read it
with `agentsocks status <msg-id>`. A frame that reaches a Codex inbox from outside agentsocks (Claude's
own `SendMessage`, say) is routed the same way, but it has no outbox row: if it is merged, only the
audit log records that. What the sender is told is one sentence, for example "Delivered. They
see it at their next tool call, or right away if idle."

**Typing guard.** Before waking an idle Codex session agentsocks checks whether any Codex terminal
read input in the last 38 seconds (Linux only: on macOS it never holds, and `agentsocks doctor` says so. A terminal's
access time moves in steps of about 8 seconds). It holds and re-checks every 5 seconds; after 10 minutes it
delivers only into an 18-second quiet gap. A failed wake backs off from 30 seconds to 10 minutes and
does not use up the hourly limit of six; urgent messages and answers are exempt from that limit but have
their own of 20 an hour per thread, so two sessions answering each other cannot wake one forever.

### Smart routing

The rules decide most messages. For the ones they do not (a normal message to a busy session), agentsocks
asks a classifier whether the message needs the receiver to stop now, can wait until its current step
ends, or can be batched. The classifier is TypeSafe Jev, a small hosted model, and it is **off until you
turn it on** with `agentsocks classifier jev`. Until then the rules alone route every message and nothing
is sent anywhere. A `TYPESAFE_API_KEY` in your environment does not turn it on; `agentsocks install` and
`agentsocks doctor` tell you when one is there.

**Turn it on.** Get a key at https://console.typesafe.ai/keys, then give agentsocks the key in one of two ways:

```bash
agentsocks classifier jev --key-file ~/typesafe.env
printf '%s' "$TYPESAFE_API_KEY" | agentsocks classifier jev --key -
```

The first points agentsocks at a `KEY=VALUE` file that has a `TYPESAFE_API_KEY` line and reads the key from
it. The second reads the key from stdin, stores it in `~/.config/agentsocks/env` (mode 600) and never prints
it. Neither puts the key on a command line, where it can end up in your shell history and in `ps`. Typing
`--key -` and pasting at the prompt is not a reliable form: a terminal needs Ctrl-D twice when the paste has no
trailing newline. Giving the key as `--key <key>` also works.
Once Jev is on, the broker looks for `TYPESAFE_API_KEY` in the config's `apiKeyFile` first, then in that env
file, then in its own environment, so a key you stored on purpose wins over one a shell happened to export
and takes effect in a running broker. An install that already names an `apiKeyFile` in its config, or has a
key stored in the env file, keeps working unchanged. The env file is there because Codex starts MCP servers with a small
environment and the broker is started by whichever client runs first. `agentsocks classifier` and
`agentsocks doctor` say which source holds the key in use, and say so when your shell has a key but the
running broker reports its classifier off.
If `config.json` or the env file is a symlink, the commands write through it to the file it points to.
`agentsocks uninstall` leaves the env file in place and prints the command that removes it.

**Change it.** `agentsocks classifier` shows what is in effect (backend, url, whether a key was found,
whether it is remote). The commands write `config.json` atomically, keep its other keys, and the daemon
picks the change up on its own.

```bash
agentsocks classifier jev [--key - | --key-file <path>]        # hosted TypeSafe Jev (off until you turn it on)
agentsocks classifier local <url> [--backend systemone|gliner2] [--allow-remote]  # your own hardware
agentsocks classifier off                                       # rules only
```

An agent that is asked to change it can run these in a shell. No MCP tool changes the classifier, so a
message from a peer cannot talk an agent into pointing it at another host.

**What leaves your machine.** Only for a message the rules do not decide, and only to the configured
classifier. Exactly two things are sent: the message text (secrets redacted, at most 2,000 characters),
and the receiver context. For a Codex receiver that is its kind, its last tool and its latest prompt. For
a Claude receiver it is its kind and its latest typed prompt, or the session's name and working directory
when no prompt is found. A prompt has secrets redacted and is cut to 200 characters, and it is never
written to disk or logs. Tasks never go to the classifier: an assignment and its notices are decided by
the rules alone. The assignment is urgent for risk `high` and normal otherwise; a notice is normal when the
task is done, failed or cancelled and fyi for any other change, whatever the risk. A failure, a timeout or
low confidence leaves the default route, and the confidence is the probability the classifier gave the route
it chose.
[SECURITY.md](../SECURITY.md) has the full list.

**On your own hardware.** For data sovereignty, a bigger box, or a model you fine-tune on your own
traffic, run Laya (it speaks the same API as Jev) or GLiNER2 yourself and point agentsocks at it:

```bash
agentsocks classifier local http://127.0.0.1:8765 --backend gliner2
```

A classifier on this machine sends nothing off it. Any other host must be `https` and needs
`--allow-remote`, which records that message text is allowed to go there; without the flag the command
refuses and says why. To run the GLiNER2 backend (`fastino/GLiNER2.5-Decide`):

```bash
pip install gliner2 torch            # in a virtualenv
python3 contrib/gliner2_server.py 8765
```

It listens on `127.0.0.1` only and loads the model once at start-up.

`agentsocks eval-router --backend config` scores the classifier in effect on
`contrib/router-eval.json` against the no-classifier baseline (everything delivered now). Run it
on your own data before you trust a local model.

#### Measured

On the 40-case set `contrib/router-eval.json` (receiver busy):

| Backend | Accuracy | `now` precision / recall | p50 latency |
|---|---|---|---|
| TypeSafe Jev, hosted (`jev-1.13.0`) | 92.5 to 95% over two runs | 0.89 / 1.00 | about 235 ms |
| Laya base checkpoint, local CPU, 4 threads | 55% | 0.67 / 0.71 | 965 ms |
| Fastino GLiNER2.5-Decide, local CPU, 4 threads | 50% | 1.00 / 0.71 | about 4 s on a loaded 16-vCPU host |
| Rules alone (everything delivered now) | 42.5% | 0.43 / 1.00 | 0 ms |

Jev's own choice is right on 39 of the 40 cases. The default confidence threshold of 0.5 sends the
borderline answers (where no route holds half of the probability) to the default route, which is
why the end-to-end figure is a little lower. The threshold was chosen after looking at this same set,
so treat the Jev figure as a measurement on that set and not as a held-out result.

**Hand-written config.** `~/.config/agentsocks/config.json` (or the file named by `AGENTSOCKS_CONFIG`).
With no file, or a file without a `classifier` key, no classifier is used (rules only), unless a key is
already stored in the env file. `{"classifier":
{"backend": "none"}}` turns it off, and a config that cannot be read turns it off too.

```json
{ "classifier": { "backend": "gliner2", "url": "http://127.0.0.1:8765", "threshold": 0.5, "timeoutMs": 1500 } }
```

| Field | |
|---|---|
| `backend` | `none`, `systemone` (TypeSafe Jev hosted, or Laya self-hosted: same API) or `gliner2` |
| `url` | The service. A host other than `localhost`, `127.0.0.1` or `::1` is refused unless `allowRemote` is `true`, and must then be `https` |
| `allowRemote` | `true` to let message text and the receiver's task leave this machine for another host. The built-in Jev preset does not need it |
| `apiKeyEnv`, `apiKeyFile` | Name of the environment variable holding the key (default `AGENTSOCKS_CLASSIFIER_KEY`), and optionally a `KEY=VALUE` file to read it from (a leading `~/` is expanded) |
| `model` | Passed to `systemone` |
| `threshold` | Minimum confidence, default 0.5 |
| `timeoutMs` | Hard limit per message, default 1500, at most 5000 |

If the config names a key (`apiKeyEnv` or `apiKeyFile`) that cannot be found, the classifier stays off
and `agentsocks classifier` says `key MYKEY not set: classifier off`. `agentsocks install` and
`agentsocks doctor` print one line saying whether smart routing is on.

## Tasks

`send_task` creates a durable task (`T-` and six hex characters) and sends the assignee one message
with the details, the acceptance criteria and how to update it. Risk `high` is sent as urgent. The
assignee moves it with `update_task` (accepted, in progress, done or failed, with a result and
evidence); only the assignee moves a task forward and only the creator cancels. The creator is told
about every change, and `update_task` says whether that notice was sent, batched or could not be sent.
Between two Claude sessions agentsocks tracks the task but posts nothing, for the same reason as above:
`send_task` creates it and returns a block to send to the assignee with the built-in `SendMessage`, and
`update_task` says the other side was not notified automatically and gives one line to send. The expiry
of such a task is not posted either. Tasks between Codex and Claude, and between two Codex sessions, are
posted and notified as before.
Tasks expire after 24 hours unless the creator sets another time; the assignee can still report a late
`done` or `failed` on an expired task. Tasks are matched by session as well as by address, so a Claude
session that restarts keeps its tasks and gets their notices. When a task finishes, progress notices
still waiting in a digest are dropped. A session lists only the tasks it created or was assigned
(`agentsocks tasks` needs to run inside a session). A task's "on behalf of" field is a claim by the
sender; it never counts as approval.

## Workers and drivers (v0.4, experimental)

A worker session (OMP, Codex, any broker-managed inbox) has at most one driver: the orchestrator whose
instructions it follows. It names the driver itself, with the `set_driver` tool (`agentsocks_set_driver`
in OMP) or `agentsocks driver <peer|none>` from inside a Codex shell (a worker driven by Claude binds itself with its own session's tool; the Claude host has no set_driver); only the session itself can use them, though any same-user process can write the broker op directly, so this is coordination, not a boundary.
Everyone else's messages still arrive, but as digests (a reply to the worker's own message arrives as a pause) labelled information-only, never as competing orders,
and the sender is told the worker may not act on them. A `send_task` from anyone but the driver is refused.
The worker's reports to a driver that instructed it floor at pause, at most 12 an hour per pair, the 13th routing normally; a duplicate of something already delivered merges instead (never a second interruption). An instruction is a task the driver assigned it or a direct message or delivered native frame from it (replies count; channel posts and broadcasts never do), recorded as a timestamp when delivered and honored for 24 hours. `read_inbox` groups messages under the driver and
everyone else; `list`, `peer_status` and `top` show the driver when one is set, and notices say when it is
offline. The binding is coordination, not a boundary (see SECURITY). Claude Code receivers are out of scope:
native SendMessage does not pass through the broker.

## Channels and broadcast (v0.4, experimental)

A channel is a `#topic` that sessions subscribe to. `subscribe` and `unsubscribe` are tools, and a
channel exists while it has a subscriber. Subscriptions are kept in the database, so they survive a
restart of the broker; one whose session has not been alive for 30 days is dropped.

A message to `#deploys` (`send_message` with `to` set to `#deploys`, or `agentsocks send '#deploys'
"..."`) is fanned out by the broker. Every subscriber except the sender gets its own delivery, routed by
the same rules, budgets and classifier as any other message, so a busy subscriber can have it paused or
batched while an idle one gets it now, and a sender past ten messages in ten minutes to one subscriber
has the rest of its posts to that subscriber batched. The body starts with `[#deploys]`, the result lists
each delivery with its message id for `message_status`, and a subscriber that cannot be reached is
reported without stopping the others.

`broadcast` (the same as a post to `#all`) goes to every live Claude Code and Codex session on this machine except the sender (not to a remote peer, see "Beyond this machine"), as `fyi`
(batched; the default) or `normal`. An urgent broadcast is refused. A session holds at most 32
subscriptions and a post goes to at most 64 running sessions; subscribers that are not running are not
tried, are named in the result (up to ten) and stay subscribed. A Claude session cannot send to a
Claude session through agentsocks (it cannot attest its permission mode, see Security), so when one
posts to a channel its Claude subscribers are listed in the result and it reaches them with its built-in
`SendMessage`; Codex sessions and plain shells reach every subscriber. Tested against fake Claude and
Codex sessions; not yet run in live ones.

## Asking several sessions (v0.4, experimental)

`ask` sends one question to up to 16 sessions (names or refs from `list_peers`, and `#channel` names for
a channel's subscribers) and returns when all of them have answered or after `timeout_seconds` (60 by
default, at most 280). Each session gets its own routed message that carries an ask id and says to reply
with the `answer` tool. The answers come back together, labelled with who gave them, and the sessions that
did not answer are listed; an answer sent any other way, with `send_message`, still reaches the asker as an
ordinary message. A session answers once, in at most 4,000 characters, and only while the ask is open.
Asks and answers are kept for 14 days. Like `send_message`, a Claude session cannot ask Claude sessions
through agentsocks: they are listed in the result, and it reaches them with its built-in `SendMessage`.
An ask is routed like any message. A busy receiver may see it only when its turn ends (it was interrupted
lately, a classifier judges it can wait, or the sender has been rated down, see below) or in a digest (the
sender is past its budget, or a classifier judges it low priority). The result says how each question was
routed. An ask that is still open when the
broker stops is closed, and a late answer is told to use `send_message`. A channel's sessions that are not
running are left out of an ask.

`pick: "best"` also asks the smart-routing model, only if you turned one on (see Smart routing), which
reply answers the question best. The result shows every reply, then the model's choice with the
probability it gave each reply, or the reason there is no pick: no model, one reply, a confidence below the
model's threshold, a failure or a timeout. It is the model's opinion and never replaces the replies. It
sends the question and the replies, secrets redacted and cut to 1,000 and 1,500 characters, to that model,
which for hosted Jev is `api.typesafe.ai`. Tested against fake models only; the request for hosted Jev
follows the shape of its delivery question and has not been tried against the live API.

## Learning from ratings (v0.4, experimental)

A receiver tells agentsocks whether a message was worth the interruption with `rate_message`:
`useful-now`, `could-wait` or `noise`. A Codex session rates by the `id` its inbox shows; a Claude session
rates the latest message from a sender by name (as its envelope shows it, with or without "(codex)"), or
just the latest one. agentsocks adds three signals of its
own: a reply within ten minutes is `useful-now`, a duplicate it merged is `noise`, and a Codex message
still unread two hours later, although the session kept working, is `noise`. Everything is stored in the
local database for 180 days. Nothing is trained, and nothing is sent anywhere unless you replay the
text against a classifier that is not on this machine (see `--own` below).

What it changes: a sender that has at least five rated messages delivered now in the last 30 days, of
which 60% or more were rated could-wait or noise, has its grey-zone messages paused instead of delivered
now. The deliveries of one channel post or ask count as one send. A rating applies to the sender
everywhere, so a sender that is rated down is paused for every receiver until its ratings age out after 30
days or its other messages are rated well. The decision reason says so, for example "4 of 6 of this sender's earlier messages delivered now
were rated could-wait or noise by their receivers", and `agentsocks status <msg-id>` shows it. Urgent
and fyi messages and every other rule decide as before, and the adjustment never makes a route more urgent.

`agentsocks eval-router --own` replays the rated messages that kept their text through the classifier in
effect (a busy receiver and urgency normal, like the shipped set) and reports how the routes chosen at the
time compare with the labels. A classifier that is not on this machine, which is hosted Jev, gets that
text and the receivers' tasks only if you add `--allow-remote`; otherwise the command refuses. `agentsocks labels export` prints every label as one JSON object per line
(task, message, decision, and what was routed) so you can fine-tune a local model yourself; an agent is
refused, because the output is message text. Only an explicit rating carries text. A rated Codex message
keeps its text from the inbox; a Claude receiver's message only while it is still in the broker's memory
(two hours, secrets redacted, 2,000 characters), so a later rating is stored without it. A Claude
session's prompt is never stored, only its session name and folder.

## Watching it: `agentsocks top` (v0.4, experimental)

`agentsocks top` is a live terminal view (plain ANSI, no dependencies, redrawn every second; `q` or Ctrl-C
quits and restores the terminal). It lists each live session with its state, unread messages, digests held,
active tasks, when it last had a message and from whom, and a Codex session's current task (a Claude
session does not report one). Under it are today's counts since local midnight: messages routed,
interrupts avoided (paused, batched and merged), digests flushed, and the median time from sending to
shown. They are counts only: nothing estimates time saved. They cover messages sent through agentsocks and
those Claude's built-in `SendMessage` sends straight to a Codex session (counted when they arrive, but a
duplicate that was merged leaves only an audit-log line, so it is not counted); a message between two
Claude sessions is not seen. `top --once` prints one frame without a
terminal (names are framed when it is piped or an agent runs it), and `top --json` prints one snapshot as
plain data for a dashboard. It never starts a broker. Without a terminal, or run by an agent, it prints one
frame and exits.

## Is it getting there?

Delivery is tracked in states that are only reported when observed: **sent**, **held** (a receiver's
gate holds it, or it is waiting in a digest), **shown** (Codex: the session acknowledged reading it;
Claude: our message id appears in the receiver's transcript as a peer origin), **replied** (the
receiver wrote back to the sender after the message had been shown). A message that was merely queued
is never reported as shown, and a reply never makes a message shown.
`agentsocks status <peer>` compares what is asked of a session with what it is doing and flags drift:
idle with unread messages older than 5 minutes (a digest counts from when it was released), a task
accepted or in progress with no update for 2 hours, a task still open 30 minutes after it was created (which
also catches a Claude to Claude task its creator never forwarded), a Codex session busy with no hook activity
for 15 minutes. `agentsocks stats` reports, per destination, route counts, median time to shown and to reply,
interrupt precision (the share of `now` messages that interrupted a busy receiver and were answered
within 30 minutes) and escalations (a follow-up from the same sender, other than an fyi, while an
earlier one is still held or paused). Transcripts are read only for our own message ids; their content
is never stored or logged. A message to a Claude session whose transcript cannot be found stays `sent`.
A background Claude session that is running subagents reports itself busy until they finish, so its
digests arrive at the 15-minute limit rather than when it goes idle.

## How delivery works

| To | Path |
|---|---|
| Claude Code | Posted to the session's own cross-session inbox socket (`$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`) in Claude Code's own frame format. Claude Code does the rest: it labels the message as coming from another session, never as your input, and applies the session's inbound settings. |
| Codex | Stored in that thread's agentsocks inbox. Codex is told a message is waiting by an agentsocks hook or, when the session is idle, by `codex queue`. The message text itself only reaches the model as the result of `read_inbox` or `wait_for_message`. |
| OpenCode, Hermes, Cursor, Copilot CLI, Gemini CLI, OMP | The same inbox, in the same way. The notice that a message is waiting comes from that agent's own hook, plugin or extension mechanism, and the text only reaches the model as the result of `read_inbox` or `wait_for_message`. Only OpenCode and OMP (and Hermes, when you give agentsocks its API key) can be woken when idle; the others are told at their next tool call and before they finish a turn. |

A per-user broker (`agentsocks daemon`, started on demand) keeps the Codex inboxes in SQLite and
serves one socket per Codex thread in the same format Claude Code uses, which is why Claude's built-in
`SendMessage` can reply to a Codex session directly. When Claude's own `cc-socks` directory exists the
inbox is advertised there under a hex name, so Claude also sends its held, denied and dropped receipts
back; the old `t/<thread>.sock` path stays bound as an alias. agentsocks never creates that directory
and never touches another file in it.

Upgrading: update the package (`npm update -g agentsocks`), then run `agentsocks install`: it stops
a running older broker (after checking that the process really is an agentsocks daemon, including a
same-version broker from a different build) so the next command starts the new one. Until then senders
say "The running agentsocks broker is an older version. Run `agentsocks install` (or stop pid N) and
retry.", or post straight to the inbox and say so; `agentsocks doctor` reports a version or build
mismatch.

## Beyond this machine (v0.4, experimental)

Everything here is off until you turn it on, and each part has an off switch. Nothing listens on a network interface, and nothing is sent anywhere, unless you run the command that starts it. [SECURITY.md](../SECURITY.md#gateway-v04-experimental) says what is exposed at each step, lists every route and how it is authenticated, and says what was and was not tested live.

The pieces share one idea. A **remote peer** is a peer that is not a Claude Code or Codex session on this machine: your phone, a model behind an API, ChatGPT, Grok, another machine's sessions. It shows in `list_peers` as kind `remote`, with how it connected (`via tailnet`, `token`, `oauth` or `api`) and which machine. It uses the same tools as a local agent, has a list of the names it may message, and goes through the same routing, budgets and rate limits. A message from a remote peer can never approve anything, and it carries no permission mode, so a Claude session that bypasses permissions holds it for your approval. Its from-name carries a marker: `<name> (remote)` for a token, OAuth or API peer, `name@host` for a linked machine's session, `<login> (phone)` for the phone app. A new peer name cannot contain `@` or brackets and cannot collide with a live local session, so the marker always tells the sender apart; where names still repeat, send by the ref in brackets.

### The gateway

```bash
agentsocks gateway on            # listens on 127.0.0.1 (a per-install random port) and prints the tailscale serve command it needs
agentsocks gateway on --serve    # the same, and runs that command after saying what it does
agentsocks gateway status        # listeners, peers with their may-message lists, token ids, the source-check verdict, last activity
agentsocks gateway off           # stops listeners, links, API peers and in-flight requests; undoes serve/funnel agentsocks set up
agentsocks gateway routes        # every route, which listener serves it, how it is authenticated
```

The listener binds `127.0.0.1` only. `tailscale serve` is what puts it on your tailnet over HTTPS, and it adds the identity of the caller. agentsocks accepts a request only when that identity checks out against tailscaled (`whois`, one wait capped at 300 s by `AGENTSOCKS_TAILSCALE_TIMEOUT_MS`), the node belongs to you (or to a login you named with `gateway allow --user`, which a tagged server needs; an admitted login starts with an empty may-message list while your own nodes keep `*`; peers made by an earlier build keep theirs until narrowed with `gateway may`) and is not tagged, and the request carries no Funnel marker. The gateway stays on across broker restarts until you run `gateway off`. `gateway off` stops the private and public listeners, federation links, API peers and in-flight requests, undoes any serve or funnel agentsocks set up, and prints what it stopped; `uninstall` runs the same stop, disables and revokes every token, grant and API peer (their families stop minting at once), and archives the gateway state into the backups directory (never deleted). Where the local source cannot be checked (same-user tailscaled, macOS), `gateway on` refuses unless `--allow-unverified-local-source` is passed, which means any program on this machine can present itself as a tailnet device. The kill switch answers 503 and closes the listeners. Running `agentsocks gateway on` from inside an agent session is refused: set it up yourself. That refusal is a guard against accidents, not a security boundary; an agent that shakes off its session can still act, and such a process is already inside the trust boundary.

An MCP client on another of your devices (Claude Code on a laptop, an agent framework) can use `https://<this machine>.<your tailnet>.ts.net/mcp` over streamable HTTP, with no sign-in beyond the tailnet itself. It gets the same tools as a local Codex session except `set_name` and `set_driver`, and the v0.4 tools described under "Channels, asks and ratings from a remote peer" below except `broadcast`. It appears as a remote peer named after its node (`hetzner-lab`); everything on one node shares that identity. Not tested against a real MCP client other than the SDK's.

### Your phone

Open `https://<this machine>.<your tailnet>.ts.net/app/` on a device signed in to your tailnet. It is a small web app with no build step: inbox, reply, send (with the urgency you pick), tasks and the peer list. On a phone, add it to the home screen. Turning notifications on (Web Push, from a tap) sends a push with no content when something is waiting; the app shows what. You appear to your agents as a peer named after your login, for example `sam (phone)`, once the app has connected. Push and the page on a real iPhone or in Safari have not been run yet.

### Channels, asks and ratings from a remote peer

The gateway has an explicit list of the tools each kind of remote peer may call, and a tool that is not on it is not there. A peer on your tailnet (your own machines and your phone) has `subscribe`, `unsubscribe`, `list_channels`, `ask`, `answer` and `rate_message`, and can post to a channel with `send_message` and a `#topic`. It does not have `broadcast`, a post to `#all` is refused, and so is asking `#all`. A public peer (token, OAuth or API) has only `answer` of these, so a local session can ask it a question and read its answer, and it cannot subscribe or post.

What a remote peer may do with a channel is cut down to the names on its list (`gateway may`). It subscribes only itself. It sees in `list_channels` and in a post's result only the members it may message, and a channel with none of them is not shown. A post or an ask to a channel goes to those members and no one else, and `answer` is refused when the asker is not on its list. `rate_message` rates only a message the peer was sent. `ask` with `pick` is refused, because it would send the replies to your classifier, and an ask waits at most 120 seconds.

In the other direction, a broadcast from a local session reaches local Claude Code and Codex sessions only, never a remote peer, because it names no one and a remote peer may be a service outside your machine. A remote peer that subscribed to a channel receives posts to it, and `agentsocks top` lists remote peers as `remote`. An explicit rating by a remote peer is stored with receiver kind `remote` and counts for the sender like any other. A session that is renamed off a peer's list is not reached by it, through a channel or directly. Tested against fake sessions and the gateway's own listeners; not run on real machines.

### Another machine's sessions

On the machine whose sessions you want to reach (`hetzner-lab`), allow the other one, and on this machine link to it:

```bash
agentsocks gateway on --serve && agentsocks gateway allow my-laptop     # on hetzner-lab
agentsocks link hetzner-lab                                             # on my-laptop
```

Its sessions then appear here as `name@hetzner-lab` and yours there as `name@my-laptop`. A message to one is forwarded and delivered the normal way on the far side (a Claude session receives it through its own cross-session inbox, a Codex session in its agentsocks inbox), and the sender is named `name@host`. Linking is opt-in on both ends, the traffic is outbound from the machine that linked, and a linked machine can reach only the other's Claude and Codex sessions. `agentsocks link --remove <host>` undoes it. Tested with two brokers in temporary directories; not yet on two real machines.

### ChatGPT, Grok and other remote clients

```bash
agentsocks gateway public --via funnel          # a second listener, still on 127.0.0.1 until you expose it
agentsocks gateway token add grok --may-message api-worker codex-web
agentsocks gateway pair chatgpt --may-message api-worker --redirect-host chatgpt.com   # optional: only an application that returns to that host may use the code
```

`gateway public` prints the exact `tailscale funnel` (or `cloudflared`) command and runs the funnel one only with `--yes`. `agentsocks gateway may <peer> [<name>...]` changes the names a peer may message later; a ref or session id survives a rename, so prefer it over a mutable name. A token is shown once and stored as a salted hash; send it as `Authorization: Bearer <token>`, or as `?key=<token>` where a client cannot set headers. A peer name cannot contain `@` or brackets, cannot collide with a live local session, and cannot carry the `(remote)` or `(phone)` markers, so no local session name can imitate a remote peer. Names an agent chooses (`set_name`, `register` with an explicit name) are refused with a suggested alternative; names agentsocks derives (hook-supplied names, Codex thread titles, folder defaults) fall back to the uniquified `<agent>-<folder>` default after NFKC normalization. ChatGPT's developer-mode connector uses OAuth: point it at `https://<public address>/mcp`, and when it sends you to the consent page type the six-digit code that `gateway pair chatgpt` printed (it works once and expires in ten minutes). A peer on the public listener has `list_peers`, `send_message`, `read_inbox`, `wait_for_message` and `answer`, sees only the peers it may message, cannot send `urgent`, and cannot post to a channel. Its messages reach you as `<name> (remote)`. **Both the ChatGPT and the Grok connector are experimental: the flows follow the documented shapes and were tested against fakes, and have not been run against the real services. Whether ChatGPT can write at all depends on its plan.**

### A model behind an API as a peer

```bash
agentsocks peer add grok --api xai --key-file ~/xai.env --may-message api-worker
agentsocks peer add chatgpt --api openai --key-file ~/openai.env --may-message api-worker
```

The peer is named `grok (api)` so nobody mistakes it for a session, and its messages reach you as `grok (api) (remote)`. When a message arrives, the broker calls the provider's Responses API with `list_peers`, `send_message`, `read_inbox` and `answer` as function tools; the first prompt carries no message text, so peer text reaches the model only as the result of `read_inbox`. The key comes from the file you name (`XAI_API_KEY=...` or `OPENAI_API_KEY=...`) each time it is used. An answer takes one to six paid calls (one for each round of tool use), capped at 30 calls an hour, counted across broker restarts (`--max-calls-per-hour`), and the peer is switched off when the provider rejects the key. Only fake servers were used; no real call has been made.

## Security

**Security.** Every release, 0.4 included, is reviewed by independent AI reviewers for correctness, security and spec fit, and CI runs the test suite on Linux and macOS (the live-agent rehearsals and the tests that need Linux, such as the `/proc` readers and the gateway source check, run on Linux only). CI scans the full git history for secrets on every push. See [SECURITY.md](../SECURITY.md) for what stays on your machine and what does not. *Argo, Aelethion's code security scanner, is coming soon.*

- **Same user only.** Sockets are `0600` in `0700` directories, as with Claude Code's own inbox.
  Symlinked or foreign-owned targets are refused. Any process of your user can reach the broker, so the
  per-session views of tasks and messages keep sessions out of each other's way; they do not stop another
  process of yours that can read the database file.
- **A peer is never your user.** Claude Code frames peer messages itself. In Codex, peer text only
  ever arrives as tool output, never in a hook, a Stop reason or a queued line, because Codex
  gives hook context developer authority and treats a Stop reason as a user prompt. Peer-written text in
  agentsocks tool output is framed the same way, and so is what the command line prints (`list`, `send`,
  `tasks`, `status`, `stats`, `inbox`, and the thread names in `doctor`) unless a person runs it at a terminal. It is framed when a Codex
  thread or a process under a Claude Code session runs it, when its output goes to a pipe or a file, and
  with `AGENTSOCKS_FRAME=1`. Only a command with no agent in its ancestry and a terminal for output prints
  plain text. `--json` output is plain data.
- **No approvals by message.** A message cannot approve a permission prompt or change settings, in
  either agent. Each session's own permission mode still applies to anything a peer asks for.
- **Sender mode.** A message from a local agent session tells Claude whether the sender asks before it
  acts. Only the modes that do are `prompting`: Codex `plan` (or approval policy `untrusted`), OMP
  `always-ask` and `always-ask-cached`. Everything else, Codex's Auto preset and `default` included, is
  `bypass`, and so is a session that never reported a mode, so a Claude session that bypasses permissions
  does not hold their messages for your approval. A plain shell and a remote peer report no mode, and their
  messages are still held. A digest claims the weakest mode among its messages.
- **Limits** mirror Claude Code's inbox: 64 KiB per message, 30 messages per sender with a refill of
  one every two seconds (checked before any routing work), identical text merged, at most 200 unread per
  Codex thread.
- **What is kept.** The audit log at `~/.local/state/agentsocks/audit.log` holds one line per send,
  receive, wake, route decision and receipt, with a hash of the body rather than the body. The outbox
  keeps a message's text only while it is held in a digest; messages in a Codex inbox are kept for 14
  days. The prompt a Codex session is working on is stored redacted (tokens, `Bearer` values, `key=`,
  `token=`, `password=` and `secret=` values in text or JSON, `--password` and `--token` flags, passwords
  in URLs, and 32-character runs that mix upper case, lower case and digits; paths, UUIDs and git hashes
  are left alone), cut to 200 characters, and shown to peers at 100. A bare `key`, `token`, `secret` or
  `password` followed by a plain word is prose and stays (`primary key: id`); a quoted value, a value
  with a digit, a symbol such as `$` or `@`, a capital inside the word, or a long run is redacted, and
  names such as `api_key` always are. A password that is a single-case word under 16 letters is not
  caught. A Claude session's prompt is read from its transcript only to be sent to the classifier; it is
  never written to disk or logs (a cache in memory holds the redacted 200 characters) and is not shown.
- **Classifier privacy.** Nothing leaves the machine unless you turned on hosted TypeSafe Jev with
  `agentsocks classifier jev` or the config names another host with `allowRemote: true`. Redirects are never followed, the response is capped at 100 kB,
  and keys are never logged or printed.
- **Kill switch:** `touch ~/.config/agentsocks/off`, or set `AGENTSOCKS_OFF=1`. It stops sends, classifier
  calls and wakes on every path.
