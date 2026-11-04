# Changelog

## 0.4.1 (2026-11-03)

### Fixed

- **Idle Codex sessions are woken again when the folder the broker started in is gone.** The broker kept the working directory of whatever started it and ran `codex queue` there, so once that folder was removed (a finished git worktree, say) every wake failed with `failed to resolve config cwd`. The broker now starts in and moves to the home directory, and runs every child process there. `startBroker` no longer passes the caller's directory or `PWD` along, and relative path variables (`AGENTSOCKS_RUNTIME_DIR`, `AGENTSOCKS_STATE_DIR`, `AGENTSOCKS_CONFIG` and the rest) are resolved against the caller's directory first, so they mean what they meant before. The starter also works out the final runtime and state directories (with the short-path fallback) and hands them to the broker, so both always use the same socket.

### Changed

- A sender to an idle Codex session is told whether the wake went out: "Delivered, and Codex accepted the request to wake them, ...", "Queued, NOT woken: <reason>. ..." (the wake's error, the retry wait, the hourly limit, the typing guard, an earlier wake still pending, or waking turned off), or that the wake has not answered within 10 seconds. It is no longer told "right away if idle" when nothing woke them. `send_message` and `agentsocks send` to such a session now answer after the wake attempt, usually within 2 to 3 seconds.
- A wake's latest failure is kept on the thread. `agentsocks status <msg-id>` / `message_status` and `agentsocks status <session>` / `peer_status` show it, along with whether a wake was accepted for the message.
- `agentsocks doctor` reports the broker's working directory, fails when that directory no longer exists, and says it is unknown when it cannot be read.

### Upgrading

Rebuild or update, then run `agentsocks install` (or stop the running broker) so the new broker starts. One migration step adds `wake_error`, `wake_failed_at` and `wake_failures` to `threads`. Sessions whose agentsocks MCP server started before the update keep the old sender wording until that server restarts.

## 0.4.0 (2026-10-19)

Local channels, a tailnet gateway, more agents, and workers with drivers.

### New

- **A wordmark at install.** At a terminal, `agentsocks install` sweeps in the agentsocks wordmark, agent in white and socks in teal. It never appears when the output is piped, in CI, or when a Claude Code or Codex session runs the command; `NO_COLOR` gets a still one without color, and a terminal narrower than the wordmark gets only the version line.
- **Channels, asks and labels.** `subscribe`, `unsubscribe`, `list_channels` and `broadcast` tools, `agentsocks channels`, and `send_message` to `#topic`. `ask` sends one question to up to 16 sessions or channels and returns the answers together. `rate_message` records whether a message was useful, and `agentsocks top` shows sessions and routing counts live.
- **Gateway (experimental).** Reach this machine's broker from your tailnet: `agentsocks gateway on` prints the `tailscale serve` command it needs. Your phone gets an inbox at `/app`, another machine's sessions appear as `name@host` after `agentsocks link`, and a second public listener offers bearer tokens and ChatGPT OAuth. Every remote peer has a list of names it may message, shown and changed with `gateway status` and `gateway may`.
- **More agents.** OpenCode, Hermes, Cursor, GitHub Copilot CLI and Gemini CLI sessions can register as peers with their own inboxes, and `install`, `uninstall` and `doctor` know each of them. An OMP session works the same way through one generated extension file. None of these has been run live against this release; `doctor` says so.
- **Workers and drivers (experimental).** A worker session names one driver with `set_driver`; everyone else's messages arrive labelled information-only. Reports to a driver that instructed it pause instead of batching, at most 12 an hour per pair, for 24 hours after the instruction. Binding a driver starts without an instruction stamp: the floor begins with the driver's first direct message or task.

### Changed

- Hosted classification is opt-in: it turns on only after `agentsocks classifier jev`. A key in the environment no longer switches it on. An install whose config already names an `apiKeyFile`, or whose env file already holds a key, keeps hosted Jev on.
- A broadcast or `#all` post from a local session no longer includes remote peers.
- Tailnet peers gain the channel tools (`subscribe`, `unsubscribe`, `list_channels`, `ask`, `answer`, `rate_message`); token, OAuth and API peers gain `answer`. `broadcast`, `set_name` and `set_driver` are never offered remotely.
- Generated default names uniquify with -2, -3 suffixes; names you choose are refused with a suggested alternative when they imitate a remote peer, while derived names fall back to the folder default.
- `gateway off` stops every gateway path and says what it stopped; `uninstall` stops the broker, restores files it never created to absent, archives gateway state only when there is any, and keeps your message history, audit.log and daemon.log in the state directory (delete the directory to remove everything).
- The database file is created 0600, and lax modes are fixed on open. `install` replaces a running broker whose build differs even at the same version. Every command answers `--help` without running.
- Guest tailnet logins start with an empty may-message list while your own nodes keep `*`; guests made by an earlier build keep their list until narrowed with `gateway may`.
- Remote peers arrive marked `(remote)`, `(phone)` or `name@host`, and new peer names cannot imitate those markers; `gateway status` shows the source-check verdict and each node's may-message list; revocation ends in-flight requests at once; `gateway on` refuses where the source cannot be checked unless `--allow-unverified-local-source` is passed; non-canonical paths are refused.

### Upgrading

Update the package (`npm update -g agentsocks`), then run `agentsocks install` again so new agent wiring and the rebuilt broker take effect. Database migrations run on open (twenty steps in all) and keep everything from 0.3.x. If you set `AGENTSOCKS_TAILSCALE_TIMEOUT_MS`, one wait is capped at 300 seconds and the off/uninstall client bound is a fixed 605 seconds.

### Off by default

The gateway and its listeners, hosted classification, and Codex threads in Claude Code's peer list.
On after install: channels, asks, labels and top; the new agent integrations wire every agent found
(`install` names what it did); learning from ratings collects signals with no switch.

## 0.3.1 (2026-10-11)

Fixes from the first macOS CI run and from the review of 0.3.0.

- **The command line no longer cuts its output short when stdout or stderr is a pipe.** On macOS `agentsocks list --json` printed 8192 bytes and stopped: pipes take writes asynchronously there, and the command called `process.exit()` as soon as it returned. Every exit (the command, its error exit, `hook codex`, the daemon's shutdown) now waits for stdout and stderr to take what was written. Linux cut the output the same way once it outgrew the socket buffer behind a slow reader, and a test now pipes about 360 KB of `list --json` to a reader that starts late.
- **On macOS a refused connection no longer proves a socket stale by itself.** A unix listener with a full backlog refuses connections there, so a live listener that was only busy could be taken for a dead one and have its socket replaced. A refusal now counts only for a name the broker derived from its own runtime directory while it holds the broker lock: its control socket and each thread's inbox. Any other name is left alone, like a timeout. Linux behaves as before.
- **`doctor` frames the Claude session name** on its "running inside Claude Code" line, like every other name it prints.
- **The session list applies the start-time proof.** On Linux a record whose `procStart` does not match `/proc/<pid>/stat` is no longer listed, as it was already not taken for the session a command runs inside. The comparison runs on Linux only: Termux has `/proc` but is not compared until it is verified there. SECURITY.md says that macOS and Termux have no start-time proof and what that lets through.
- **Framing needs less proof than identity.** Whether peer text is framed asks if an agent may be reading, so a Claude Code ancestor whose record names the pid and whose start time matches is enough, even when its socket is gone. Who a command is, as `whoami`, `send` and `doctor` use it, still needs the socket.
- **A Claude Code that retitles itself is recognised at pid 1.** A lone argument that starts with `claude ` (the title `claude bg-spare`) and a binary called `claude.exe` now count as Claude Code, next to `claude` and the install paths.
- **Tests.** `test/support.ts` drops `TYPESAFE_API_KEY` and every `AGENTSOCKS_` variable itself, and refuses to load when `HOME` is not inside a temporary directory, so a file run without the preload cannot reach a real home.

## 0.3.0 (2026-10-09)

Launch round: macOS support written to Claude Code's own rules, a quieter command line, and a package that ships only what runs.

- **macOS.** Claude Code's `cc-socks` directory is found the way Claude Code finds it (`$XDG_RUNTIME_DIR`, then the temp directory, then `/tmp/cc-socks-<uid>`; `$PREFIX/tmp` on Termux), and an inbox name is only placed where it fits `sun_path` (103 bytes on macOS, 107 on Linux). On a Mac the runtime directory is `<temp dir>/agentsocks-<uid>`, or `/tmp/agentsocks-<uid>` when the per-user temp directory is too long for a thread socket. Parent pid and command line come from `ps` where there is no `/proc`. The typing guard does nothing off Linux, so a wake is never held there. Not yet run on a Mac; see the limit in `docs/SPEC.md`.
- **The command line frames peer text unless a person runs it at a terminal.** `list`, `send`, `tasks`, `status`, `stats`, `inbox` and the thread names in `doctor` print the untrusted-text frame when a Codex thread or a Claude Code session runs them, when their output is not a terminal (a pipe or a file), and with `AGENTSOCKS_FRAME=1`. Only a command with no agent in its ancestry and a terminal for output prints plain text, so an agent that agentsocks does not recognise is still framed when it captures the output. `--json` is never framed. The search for the Claude Code ancestor now reaches pid 1, and it takes a registry record only with proof that the record is that process: a socket that exists, a start time that matches on Linux, and, at pid 1, a process that is Claude Code. A stale or foreign `1.json` no longer makes a plain shell a Claude session.
- **Codex passes `TMPDIR` to the MCP server**, so a broker started there finds the same temp directory Claude Code uses.
- **A python3 older than 3.11 (no `tomllib`) no longer rolls back a good Codex config** when agentsocks has to edit it directly. It means "cannot check", not "invalid".
- **On Linux the runtime directory is the one v0.2.0 chose**: `$XDG_RUNTIME_DIR/agentsocks`, else `/run/user/<uid>/agentsocks` when that exists, else `<os.tmpdir()>/agentsocks-<uid>`. An upgrade finds its broker where the last one left it. The only exception is an `$XDG_RUNTIME_DIR` so long that the broker socket would not fit `sun_path` (107 bytes), which falls back to `/tmp/agentsocks-<uid>`.
- **The router's labelled set moved from `test/fixtures/` to `contrib/router-eval.json`**, so `agentsocks eval-router` works from an installed package.
- **Package.** Ships `dist`, `contrib`, the README, SECURITY.md and the licence. `npm run build` never deletes `dist`, so building in a checkout that something runs from does not break it; `npm run clean` removes it, and `npm pack` runs clean and then build. Declares `repository` and keywords, and does not restrict `os`: the code fails open where a platform is unsupported, and npm would refuse the install on Termux.
- **Tests clean up after themselves** and keep socket paths short. The redaction tests build their fake credentials at run time, and `.gitleaksignore` lists exactly the 24 older findings, one fingerprint each, instead of exempting every test file.
- CI on Linux and macOS, Node 22.13 and 24, with a secret scan of the full history.

## 0.2.0 (2026-10-09)

Attention, tasks and verification.

- **Attention routing.** Each message is routed `now`, `pause`, `digest` or `merge` from what the receiver is doing and how many messages it has had, by rules first and then an optional classifier. Hosted TypeSafe Jev is the default once it has a key; a classifier on your own hardware is supported; with no key nothing leaves the machine.
- **Tasks.** `send_task`, `update_task` and `list_tasks` hand a session tracked work with acceptance criteria and tell the creator when it moves.
- **Honest delivery.** Messages are reported as sent, held, shown or replied, only when observed. `message_status`, `peer_status` and `agentsocks stats` show routing, drift and per-destination metrics.
- **Typing guard.** A wake waits while someone is typing in a Codex terminal (Linux).
- **Codex inboxes are advertised in Claude Code's `cc-socks` directory** under a hex name, so Claude's own `SendMessage` can reply and its receipts come back. The v0.1 path stays bound as an alias.
- **Privacy.** Prompts and messages are redacted before they are stored or classified. Peer text is framed in tool output and in command-line output. A kill switch stops sends, classifier calls and wakes.
- `agentsocks classifier`, `eval-router`, `status`, `stats` and `tasks`. Sessions started before the install are reached and listed as not connected yet.

## 0.1.0 (2026-10-08)

First release.

- Claude Code and Codex sessions on one machine message each other. A Claude session receives through its own cross-session inbox exactly as it receives from another Claude session. A Codex session receives through hooks, MCP tools and `codex queue`, and peer text only ever arrives as tool output.
- `agentsocks install`, `uninstall`, `doctor`, `list`, `send` and `inbox`. Nothing is typed into a terminal.
