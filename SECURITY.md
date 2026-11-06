# Security

## Trust boundary

agentsocks trusts the operating-system user it runs as, and nothing else.

- Sockets are `0600` in `0700` directories, as with Claude Code's own inbox. A symlinked or
  foreign-owned target is refused.
- Every process of your user can reach the broker. The per-session views of tasks and messages keep
  sessions out of each other's way. They do not stop another process of yours that can read the database
  file.
- A Claude Code session is recognised from its registry record, `~/.claude/sessions/<pid>.json`. The
  session list, and the search for the session a command runs inside, require a live pid and a socket at the
  record's `messagingSocketPath`; on Linux they also require the record's `procStart` to equal the start
  time in `/proc/<pid>/stat`, so a process that takes over a dead session's pid does not inherit its record.
  macOS has no `/proc` and agentsocks has no start-time proof there, and Termux is not compared until
  that has been verified on a device. Where the proof is missing, a record left behind by a crashed
  session whose socket file is still there, and whose pid another process of yours has since taken, is
  listed as a peer (a message to it fails at the socket) and makes a command run by that process look
  like it runs inside that Claude session. Deciding whether to frame peer text asks a weaker question than
  who the command is: it needs the record to name the pid and the start time to match, not the socket, so
  a session whose socket has gone still gets its command output framed.
- A peer is never your user. Claude Code frames peer messages itself. In Codex, peer text only arrives
  as tool output, and text a peer wrote that agentsocks prints is inside a marked block. The command
  line prints that block unless a person runs it at a terminal: it frames when it finds an agent (a Codex
  thread, or a process under a Claude Code session), when its output is not a terminal (a pipe or a file),
  and with `AGENTSOCKS_FRAME=1`. It prints plain text only when it finds no agent and its output is a
  terminal, and never frames `--json`. An agent that agentsocks does not recognise, such as a command that
  detached itself from the session or a sandbox that hides the parent process, is still framed whenever it
  captures the output. One that reads a pseudo-terminal looks like a person; set `AGENTSOCKS_FRAME=1`
  where that can happen. A message cannot approve a permission prompt or change settings in either agent.
- `send_message` and `agentsocks send` do not send from a Claude session to a Claude session.
  agentsocks cannot attest a Claude sender's permission mode, so those messages go through Claude
  Code's own `SendMessage`, which carries it. A task between two Claude sessions is tracked by
  agentsocks but not posted: `send_task` returns the assignment to send with `SendMessage`, and task
  notices between the two are not posted either.
- That redirect is advisory. It protects against a mistake, not against a process of yours that wants
  to get around it. The `agentsocks send` check finds the calling session by walking up the process
  tree, so a command that detached itself from it is treated as a plain shell, and any local process of
  your user can claim a Codex identity by naming a Codex thread. Under the trust boundary above that
  gains nothing a process of your user could not already do. The permission mode agentsocks attaches to
  a local agent session's messages is that of the session it names: the mode its hook last reported (OMP's
  extension reports `tools.approvalMode`), or for Codex before any hook has reported, the thread's approval
  policy in the Codex state. Only a mode that asks before acting counts as prompting (Codex `plan` or
  `untrusted`, OMP `always-ask` or `always-ask-cached`); every other mode counts as bypass, and so does a
  session that never reported one. That last rule is a choice, not an observation: a session that asks
  before acting but whose mode could not be read is sent as bypass, and a bypassing Claude receiver does
  not hold its message. Plain shells and remote peers attest no mode. The attestation is about the named
  session, not about the process that asked.

## Channels and asks

An ask is stored with its question, its recipients and their answers (at most 4,000 characters each) for 14
days, in the same 0600 database. An answer reaches the asker only as tool output inside the peer-text frame,
and only a session that was asked can give one. A channel subscription is a row (channel, session name, inbox address, session id) in the agentsocks
database, in the state directory, mode 0600. A post to a channel is an ordinary message to each
subscriber: the same size limit, the same per-sender limiter, and the same router budgets for each
subscriber, and it can never approve anything. Any process of your user can subscribe a session or post to
a channel, which is within the trust boundary above. `#all` and `broadcast` reach every live Claude Code and Codex session of
your user on this machine and no remote peer (see Gateway), so an urgent broadcast is refused and fyi is the default. A Claude session's post is not sent
to Claude subscribers, for the same reason `send_message` does not send between Claude sessions. A session
holds at most 32 subscriptions, a post goes to at most 64 sessions, and an asker is limited to a burst of 30
asks, so a looping agent cannot fan out or fill the database without bound.

## Ratings

A rating (`rate_message`) is stored in the database for 180 days with the sender's name, how the message was
routed, the receiver's task as the router saw it (a Codex session's redacted prompt, or a Claude session's
name and folder, never a Claude prompt) and, for an explicit rating, the message text with secrets redacted
and cut to 2,000 characters. The text of a Claude receiver's message is held in the broker's memory for two
hours for this purpose and nowhere else. Signals agentsocks derives itself carry no text. No model is
trained. `agentsocks labels export` prints that text, so it refuses to run under an agent (advisory, like
the other agent checks). `eval-router --own` prints counts only, but it replays the rated text and the
receivers' tasks through the classifier in effect, so against a classifier that is not on this machine it
refuses unless you pass `--allow-remote`. Any session, and any remote peer on the tailnet, can rate the messages it received, so a session
that is told to can earn a sender a pause for its grey-zone messages, for every receiver, for up to 30
days. That is the only effect a rating has: never a faster route, nothing dropped, and no approval.

## top

`agentsocks top` reads the broker and prints session names, state, counts and a Codex session's redacted
task (cut to 100 characters). Nothing is stored or sent. Its text is framed like `list` unless a person
runs it at a terminal, and `--json` is plain data, as everywhere.

## More agents (OpenCode, Hermes, Cursor, Copilot CLI, Gemini CLI, OMP)

These agents are peers in the same inbox as Codex, and the same rules hold: peer text reaches a model only as the result of a tool call, in the marked frame. Their hooks, plugin notices, wake lines and finish-time nudges carry counts and the sender's kind, never a message, a task field or a name a peer wrote. A message cannot approve anything for them.

- **Which session is calling.** These agents' MCP calls do not say which session made them. Their pre-tool hook (which does know) adds `_session` to the arguments of agentsocks tools only, as `<session id>.<mac>`, where the mac is an HMAC-SHA256 over the agent's name and the session id with a random key in `~/.local/state/agentsocks/stamp.key` (mode 600, created by the first hook that needs it). `agentsocks mcp --agent <id>` takes the session from a valid stamp and nothing else: a call with no stamp, a stamp with the wrong mac, a stamp made for another agent, or a bare session id is refused with an error that points at `agentsocks doctor`. A model that writes `_session` into a tool call itself therefore does not become another session. This is a same-user boundary, not a wall: a process of yours that can read the key file can make a stamp, which it could already do by naming a Codex thread id. What it does give is protection from text: a model that writes `_session` into a call, or that is talked into doing so by a peer or a web page, does not become another session. These agents can all run shell commands, and a model that reads the key file with one can forge a stamp, so do not read the stamp as protection from a model that has a shell. A call that arrives with no stamp is also what you see when the kill switch has silenced the hooks. The MCP server and the hooks must resolve the same state directory (`AGENTSOCKS_STATE_DIR` or `XDG_STATE_HOME`), which the installers record when they are set at install time.
- **A session's identity is its agent and its id.** The inbox of a session is named `<agent>_<session id>`, so a Cursor conversation and a Gemini session with the same id are two inboxes, and one agent's stamp is not valid for another.
- **Plugin tools take the session from the plugin.** OpenCode's plugin has its own session id and calls `agentsocks tool opencode <tool> --session <id>`. That command takes `--session` from its caller, like `CODEX_THREAD_ID` for the command line, so any process of yours can claim an OpenCode session. The plugin file is code that runs inside OpenCode with OpenCode's privileges; agentsocks generates it, marks it, and removes it on uninstall.
- **OMP's extension takes the session from OMP, and its lines arrive as the developer role.** The generated `extensions/agentsocks.ts` reads the session id from OMP's session manager each time it acts (`/new`, `/resume` and forks change it), never from the model: arguments that name a session or carry a `_session` are dropped by OMP's schema and by the command. It serves only OMP's main agent (`ctx.agent.kind === "main"`); subagents, advisors and a context with no identity get no tools, no hook calls and no wake. It calls `agentsocks tool omp <tool> --session <id>` and `agentsocks hook omp <event>`, with the same caller-supplied `--session` limit as OpenCode's plugin. The one line it adds after a tool result (`additionalContext`), the hidden note before a turn, the wake line and the finish-time line are all fixed text that starts with `📨 agentsocks:`, built by the broker from a count and a sender kind, and the extension drops any line of the broker's reply that does not start with that prefix and any wake over 600 characters. OMP sends a custom message or `additionalContext` to the model as the **developer** role, which some providers deliver as a user turn. That is why no peer text, name or task field is ever put in one: they reach the model only as the result of `read_inbox` or `wait_for_message`. The extension never calls `sendUserMessage`, so nothing it sends is recorded as typed by you. It runs inside OMP with OMP's privileges, spawns `agentsocks` with the same trimmed environment as the OpenCode plugin, and is generated, marked on its first line, and deleted by `uninstall` only while it carries the marker. If OMP is set to read Claude Code's or Codex's config, the agentsocks MCP servers registered there would start inside OMP and could not tell its sessions apart (Claude's falls back to an unregistered name, Codex's refuses): `doctor` and `install` warn, and `disabledProviders` in OMP's `config.yml` is the fix.
- **Hooks do not carry the agent's credentials to the broker.** A hook can be the process that starts the broker, so `agentsocks hook <agent>` first drops every environment variable except the ones agentsocks and its tools need (`PATH`, `HOME`, `TMPDIR`, `XDG_*`, `NODE_*`, `LC_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGENTSOCKS_*`). The OpenCode plugin does the same for the commands it spawns. A broker started from a hook therefore has no `TYPESAFE_API_KEY` from the shell either; keep that key in `~/.config/agentsocks/env`.
- **Cursor cannot narrow the stamp to our server.** Cursor's `preToolUse` input is not documented to say which MCP server a tool belongs to, so the hook selects agentsocks tools by name. Another MCP server that has a tool with one of those names (`send_message` is common) would be sent a `_session` argument and the user a prompt for it. The stamp is only meaningful to our stdio server, and the live run has to show what Cursor sends.
- **Wake lines.** OpenCode's plugin and OMP's extension wake an idle session with a one-line prompt (OMP: a custom message) that starts with `📨 agentsocks:` and holds a count and a sender kind. The broker does not connect to either and holds none of their credentials: it hands the line to the plugin or extension over the broker's own socket. Hermes can be woken through its API server only if you put its API key where agentsocks can read it (`~/.config/agentsocks/env`, mode 600, or a file named in `config.json`); the URL must be this machine unless you allow an `https` host on purpose, redirects are not followed, and the key is never logged. The key is sent as a bearer token to whatever answers on that loopback port, so on a machine shared with other users, where one of them could bind the port while Hermes is down, leave the API wake off. Cursor, Copilot CLI and Gemini CLI cannot be woken: they are told at their next tool call and before they finish a turn, and the nudge has a cap (three consecutive finish-time nudges) well inside what each agent allows.
- **Config files agentsocks edits.** Only the files named in the README, each backed up before the first write, each edit marked so uninstall removes exactly it. A file that does not parse is never rewritten. agentsocks writes nothing into Claude Code's own files for these agents.
- **Untested live.** Until a real run of an agent passes, `doctor` and the README say `untested live` for it. The hook formats are taken from each agent's documentation and tested against fixtures made from it.

## Claude ListAgents records (experimental, off by default)

`agentsocks install --claude-listagents` lets the broker write into Claude Code's own session registry, which is another tool's private state, so it is off until you ask, Linux only, and not yet run against a live Claude Code. What it does: one JSON record `<pid>.json` per live Codex thread in `~/.claude/sessions`, created with `link(2)` (never overwriting) and updated by `rename`, each owned by a small holder process of ours that supplies the live pid the registry needs and exits within a few seconds of the broker's pid disappearing. What it never does: touch a record it did not write, signal a process whose start time does not match the one recorded when it was started, follow a symlink, create the registry directory, or write anywhere else under `~/.claude`. Removal is driven by a ledger in the state directory and only for a record that still carries our entrypoint, the holder's pid, the thread's session id and the holder's start time. The record holds the thread's name (cut to a restricted slug, so a prompt-derived title never reaches a Claude model as free text), its working directory (cleaned and cut to 200 characters, but free text: a folder named like an instruction would be shown to whatever reads Claude's registry) and its state, no message text and no secret. If a Claude Code in another PID namespace shares `~/.claude`, it will see the holder pid as dead and delete the record. The broker then stops listing that thread. `docs/SPEC.md` has the design, the invariants and the live-test checklist.

## What leaves your machine

To route a message, only the classifier input goes anywhere, only to the configured classifier, and only for
a message the routing rules do not decide. Two other commands can send text to it, and only when asked
(below). Nothing else is sent anywhere under the defaults; a remote classifier or link you configure is your choice to make.

The classifier input for routing is exactly two things:

- the message text, with secrets redacted and cut to 2,000 characters;
- the receiver context: its kind (`claude` or `codex`, where `codex` also stands for any agent that reads an
  agentsocks inbox) and, for those, the name of its last tool, plus its current task. For a Codex session that is its latest prompt. For a Claude session it is the latest
  prompt typed in its transcript, or the session name and working directory when no prompt is found.
  A prompt has secrets redacted and is cut to 200 characters.

Two more things can go to the classifier, and only when asked for. `eval-router --own --allow-remote` sends
your rated message text and the receivers' tasks, redacted, to a classifier that is not on this machine; the
flag is for a person, and an agent that passes it is refused (advisory, like the other agent checks).
And `ask` with `pick: "best"` sends
the question and the replies it collected (secrets redacted, the question cut to 1,000 characters and each
reply to 1,500) to the configured classifier, so it can say which reply answers best. Nothing is sent
unless that parameter is set and a classifier is on; with hosted Jev that is `api.typesafe.ai`. The answer is
shown with every reply and is stored as names and probabilities, not text.

Tasks never go to the classifier. A task assignment and its notices are decided by the rules alone (the
assignment is urgent for risk `high` and normal otherwise; a notice is normal when the task is done, failed
or cancelled and fyi for any other change, whatever the risk), so a task's title, details, result and
evidence are not sent.

Secrets are redacted from the task and the message before they are sent: known token prefixes, prefixed
lowercase API keys such as TypeSafe's and DigitalOcean's, `Bearer` values, assignments to names such as
`api_key`, `password` or `secret` when the value looks like a secret, `--password`, `--token` and `--key`
flags, passwords in URLs, private key blocks, and long mixed-case runs. Redaction looks at the first
4,000 characters and runs in linear time. It is a heuristic and cannot catch every secret.

Hosted TypeSafe Jev at `api.typesafe.ai` is off until you run `agentsocks classifier jev`. A
`TYPESAFE_API_KEY` in the environment of the broker or of any shell never switches it on: `install` and
`doctor` say when one is there and what to run. An install whose config already names an `apiKeyFile`, or
whose env file already holds a key, keeps hosted Jev on. An agent that runs `agentsocks classifier jev` in
a shell does turn it on; no MCP tool can, and the MCP instructions tell an agent to run it only when its
user asks. Until it is on the input is never built and nothing is sent. A classifier on this machine (`localhost`,
`127.0.0.1` or `::1`) sends nothing off it. Any other host must be `https` and be allowed in the
config (`agentsocks classifier local <url> --allow-remote` writes that on purpose). Redirects are never followed, responses are capped at 100 kB, and keys are never logged or
printed. The key is read from the config's `apiKeyFile`, then `~/.config/agentsocks/env` (mode 600),
then the environment, and `agentsocks classifier` and `doctor` say which one is in use.

What agentsocks keeps on disk is described in the README under "Security". The audit log holds a hash
of each body, not the text. A Claude session's prompt is read only to build the classifier input. It is
never written to disk or logs, and not shown; a cache in memory holds the redacted 200 characters per
transcript until the file changes. Only regular files are read as transcripts: a symlink, a pipe or a device
in their place is ignored.

## Gateway (v0.4, experimental)

Everything in this section is off by default and reversible. With the gateway off, the rest of this document is the whole story: agentsocks trusts the operating-system user it runs as, and nothing else.

### What is exposed, and when

| You ran | What listens | Who can reach it |
|---|---|---|
| nothing | nothing | nobody |
| `agentsocks gateway on` | one HTTP listener on `127.0.0.1` (a per-install random port kept in gateway state; the private listener) | every process on this machine that can open a TCP connection. It still refuses a request that does not carry the identity `tailscale serve` adds (see below). |
| and then the `tailscale serve` command it printed | the same listener, now also behind your tailnet's HTTPS name | the user who owns this node, from their own devices, and nothing else |
| `agentsocks gateway public --via funnel` (or `cloudflared`) | a second listener on `127.0.0.1` (another per-install random port; the public listener) | still only this machine, until you run the printed `tailscale funnel` or `cloudflared` command. `--yes` runs the funnel command for you. agentsocks never starts a `cloudflared` tunnel itself. |
| and then that command | the public listener | the internet. It serves five things: OAuth metadata, client registration, the consent page and the token endpoint, and `/mcp` with a token. Every other path is a 404. |
| `agentsocks link <host>` | no listener. This machine's broker makes outbound HTTPS requests to `<host>`'s private listener. | `<host>` must have run `agentsocks gateway allow <this machine>` |
| `agentsocks peer add <name> --api xai\|openai` | no listener. The broker calls the provider's API when a message arrives. | nobody inbound. Each answer is a paid call. |

`agentsocks gateway off`, `gateway public off`, `link --remove` and `peer remove` undo each of these. The kill switch (below) stops all of them without removing them. `agentsocks gateway status` shows what is listening, the source-check verdict, each peer with its may-message list, token ids and last activity. `gateway on` refuses when its port is already held by another process, and `gateway off` undoes a serve agentsocks set up so nothing points at a port the broker no longer holds; when an off command fails the flags stay set and the output says so. A worker's driver binding is coordination between your own sessions, not a security boundary (the floor exempts at most 12 reports an hour per pair from batching; a same-socket re-bind only moves a binding whose stored session is dead elsewhere): every process of your user can already reach the broker socket as any session, so the same-user trust of the whole tool applies.

`agentsocks gateway on`, `gateway public`, `gateway token add`, `gateway pair`, `gateway may`, `gateway allow` (hosts and users), `link` and `peer add` refuse to run when an agent session runs them (a Codex thread, or a process under Claude Code). Setting up network access and credentials is for a person at a terminal. That refusal is a guard against accidents, not a security boundary: the check finds the caller the same way `agentsocks send` does, so a process that detaches itself from its agent, or talks to the broker socket directly, is not stopped. Such a process is already inside the trust boundary.

### Threat model

| Threat | What agentsocks does | What it does not do |
|---|---|---|
| **A local process forges the tailnet identity headers.** The private listener is on loopback, so any local process can connect and write `Tailscale-User-Login` itself. | The listener requires `Tailscale-User-Login` and an `X-Forwarded-For` source (the last value, the one `tailscale serve` appended; only the last value is trusted, which holds because the listener binds loopback and serve is the sole ingress that appends it), asks tailscaled (LocalAPI `whois` on its unix socket, else `tailscale whois --json` from the fixed `/usr/bin/tailscale` or `/usr/local/bin/tailscale`, never `PATH`, with `$AGENTSOCKS_TAILSCALE_BIN` as an operator-only override; a definitive LocalAPI 404 denies without asking the command) who that address is, and refuses unless the answer names the same login, the node is not tagged, and the user is the one who owns this node (or a login you added with `gateway allow --user`, which a tagged node needs). On Linux, when tailscaled runs as a different user than agentsocks, it also refuses any connection that user did not open (read from `/proc/net/tcp`). | It cannot tell a local process from tailscaled when tailscaled runs as the same user (userspace networking, for example) or on macOS. `agentsocks gateway status` says `not enforced` in that case, and then any local process can claim to be your phone. A process of your own user could read the database anyway. On a shared machine, leave the gateway off or run tailscaled as root. |
| **Funnel and serve confusion.** Traffic from the internet reaches the private listener. | The private listener refuses any request with `Tailscale-Funnel-Request`, and funnel traffic carries no identity headers and a public source address, so it fails the checks above twice. The public listener is a different port and never reads a `Tailscale-*` header. | It cannot stop you running `tailscale funnel` against the private port. The result is refusals, not exposure. |
| **DNS rebinding and cross-site requests** against the browser routes. | `Host` must be this node's tailnet name or a loopback name (a header the page writes itself, such as `X-Forwarded-Host`, counts for nothing). A request with an `Origin` must carry one of those names; `Sec-Fetch-Site` must be `same-origin` or `none`; every POST must be `application/json` (the OAuth consent and token endpoints take a form). The app's `/app/api/*` routes also need an `X-Agentsocks-App` header, which a page on another site cannot add, so a browser that sends no `Origin` or `Sec-Fetch-Site` still cannot be made to read or consume the inbox. | Failed identity checks are answered 429 at 20/min per WhoIs identity once tailscaled names the caller; failures before WhoIs are not throttled. |
| **Token theft or guessing.** | Tokens are 32 random bytes. Only a salted SHA-256 is stored, compared in constant time. A token is shown once, is bound to one peer with its own list of names it may message, and is revocable. Revocation and `gateway off` end in-flight requests for the affected peers at once, and revocation drops their push subscriptions; the kill switch answers 503 at once and closes listeners on the next sweep (about 5 s). Twenty failed attempts a minute from one source (the last `X-Forwarded-For` value) are answered with 429; a request that carries a valid token is not slowed by someone else's failures. | `?key=` puts the token in a URL, which proxies and tunnels may log. Use the `Authorization` header wherever the client lets you. A token is a bearer credential: whoever holds it is that peer. If the tunnel in front does not put the real client address last in `X-Forwarded-For`, every failed attempt counts against one shared source (a valid token is never slowed by that). |
| **OAuth abuse (ChatGPT).** | OAuth 2.1 with PKCE `S256` only, public clients only, exact `redirect_uri` match against what the client registered (https, or loopback http), authorization codes valid 60 seconds and once (a replayed code revokes the grant it produced), access tokens one hour, refresh tokens thirty days and rotated on every use (a replayed refresh token revokes the grant). Consent needs a one-time 6-digit pairing code that `agentsocks gateway pair chatgpt` printed on this machine, valid ten minutes. Five wrong codes in ten minutes from one source lock the consent page for that source, and thirty from all sources lock it for everyone, so a guess cannot be spread out to get through. `gateway pair chatgpt --redirect-host <host>` pins a code to the host the application returns to. Anyone may register a client, so registration is rate-limited and capped at 50 clients; at the cap new registrations are refused (a grant that exists is never evicted), and a registration that produced no grant expires after ten minutes. | Whoever has the pairing code and a browser can complete consent: the code is the only proof of presence. The consent page names the application and the host it returns to; read them, or pin the host. A stranger can fill the client cap for ten minutes at a time, or lock pairing with thirty wrong codes; both only deny. |
| **Prompt injection and the confused deputy.** A remote peer, or text it relays, talks an agent into acting. | Peer text reaches a model only as tool output, framed, or in Claude Code's own cross-session envelope, exactly as for a local peer. A remote peer sends no permission mode, so a Claude session that bypasses permissions holds its messages for the user's approval. A message cannot approve anything. Every remote peer has a list of names it may message, enforced where all sends pass (`routeSend`), and a peer that is not on the list is not even shown by `list_peers`. A peer on the public listener cannot send `urgent`. Messages from a linked machine arrive named `name@host` and can reach only that machine's local Claude and Codex sessions, never its remote peers. | A remote peer can still ask a session to do something, and the session's own permission settings are then the only control. Any local agent may message any remote peer, so a session talked into it can send text to a peer you gave a token. Give a token only to a peer you want to talk to, and keep `--may-message` short. |
| **A remote peer reaches further than its list through channels, asks or ratings.** | The gateway offers a tool only if `TOOL_SURFACES` (`src/gateway/gtools.ts`) lists it for that kind of peer, and a test fails until every tool has a row. Tailnet peers get `subscribe`, `unsubscribe`, `list_channels`, `ask`, `answer` and `rate_message`; token, OAuth and API peers get `answer` only; `broadcast`, `set_name` and `set_driver` are never offered. A remote peer subscribes only itself, because who it is comes from the connection and the tools take no member. Channel members, a post's recipients and an ask's recipients are cut to the names on its list in the channel service, which every path passes, and `routeSend` checks the receiver's current name as well as the name it was sent with, so a session renamed off a list does not stay reachable. `#all` is refused for a remote sender, `ask` resolves names among the peers it may see, `ask` with `pick` is refused (it would send the replies to your classifier) and its wait is cut to 120 seconds, `answer` is refused when the asker is not on its list, and `rate_message` rates only a message delivered to that peer. A broadcast from a local session never reaches a remote peer, and a public peer cannot post to a channel. | A tailnet peer whose list is `*`, the default for your own nodes, reaches every channel's members, and by rating can lower a sender's standing for every receiver, as any session can. A subscription left behind by a peer that was then switched off stays in the table; a post does not try it, because a switched-off peer is not live. |
| **Floods.** | The existing 30 messages per sender with a refill of one every two seconds, and the router's budgets, apply per remote peer. A peer also has 60 requests of burst and one a second, bodies are capped (256 KiB on `/mcp`, 128 KiB on the app, 16 KiB on OAuth) and must arrive within ten seconds, `wait_for_message` is cut to 50 seconds on the public listener and 120 on the tailnet, and the listeners hold at most 512 transport connections (hard cap), 128/64 requested (public/private), 128/64 pending and 32/16 per source, with a 10 s header budget and a 30 s timeout on non-poll routes (knobs `AGENTSOCKS_GATEWAY_HEADERS_MS`, `_REQUEST_MS`, `_SOURCE_CONNS`, `_PENDING_CONNS`, `_BODY_MS`). `AGENTSOCKS_TAILSCALE_TIMEOUT_MS` caps one tailscaled wait at 300 s; the `gateway off`/`uninstall` client bound is a fixed 605 s covering two capped windows plus slack, so a knob set in only one environment cannot time out an op that finishes. | |
| **Web Push.** | The push carries no payload, so a push service learns that a push happened and nothing else. Subscription endpoints must be `https` on a known push service (Google, Apple, Mozilla, Windows), no redirect is followed, and a 404 or 410 deletes the subscription. The VAPID private key lives in the database file, which sits in the 0700 state directory. | `AGENTSOCKS_PUSH_HOSTS` lets you add hosts for self-hosted push; it is a knob for tests. |
| **API peers spending money or leaking.** | The key is read from the file you named each time it is used and is never logged or printed. The model gets `list_peers`, `send_message`, `read_inbox` and `answer` and a content-free first prompt, so peer text reaches it only as tool output. A peer is capped at 30 calls an hour by default (`--max-calls-per-hour`, each reply and each tool call spends budget, refilling as calls slide out of the window), counted in the database so a restart does not reset it, and is switched off when the provider rejects its key. The kill switch stops its calls, in the middle of an answer too. A plain-text answer is never forwarded to another API peer, so two API peers that may message each other talk until the budget is spent, which refills as calls slide out of the window. `--may-message` is required. | Whatever you send to `grok (api)` goes to xAI (or OpenAI). That is the point of the peer. |
| **Federation.** | Both ends opt in (`gateway allow` there, `link` here). The linked machine is identified by the same tailnet checks, and must be a machine of the owner's (or of a login admitted with `gateway allow --user`, whose sessions arrive marked `(remote)`). An admitted login's peers start with an empty may-message list; peers made by an earlier build keep theirs until narrowed with `gateway may`, which `gateway status` shows. The traffic is outbound from the machine that linked. A linked machine can list at most 200 sessions here (proxies not seen for a week are hidden). A message the far side cannot hand to its session fails with the reason and is not retried; network errors are retried. | A linked machine can message any Claude or Codex session on this one, as `name@host`. Treat a link as trust in that machine. |
| **Lost availability.** | The kill switch answers 503 on both listeners and a sweep closes them. | |

What is stored: `gateway_peers` (names, how each connected, allowed names), `gateway_tokens` (salted hashes only), OAuth clients, codes, token hashes and pairing-code hashes, Web Push subscriptions and the VAPID key pair, linked machines. All of it is in `agentsocks.db`, which is created `0600` in the `0700` state directory, like the messages. The audit log records listener starts and stops, OAuth consent, token issue, pushes and federation errors, never a token, a code or message text.

### Every route, and how it is authenticated

Known accepted limits: a tailscaled running as the same user can forge the tailnet identity headers, which is why `gateway on` refuses where the source cannot be checked; only the last `X-Forwarded-For` value is trusted, which holds while `tailscale serve` is the sole ingress that appends it; a pairing code can be relayed by whoever reads the terminal it was printed on; a linked machine may create up to 200 proxy peers here; the fixed `tailscale` paths are Linux-only, so macOS uses the operator's `$AGENTSOCKS_TAILSCALE_BIN` override; a raw broker caller can forge `from.session` and be treated as the driver for that one message (same-user trust boundary), but a refresh never moves a binding whose stored identity is still live at another socket, so the real driver keeps it; while the real Claude driver is offline, a same-user raw broker caller forging its session id can move the binding to another socket until the real driver's next message; a rotated `X-Forwarded-For` cannot be isolated pre-auth without identity, so XFF flooding counts against the shared bucket under serve (documented trust limit); listener tuning knobs are `AGENTSOCKS_GATEWAY_HEADERS_MS` (10 s), `_REQUEST_MS` (30 s, non-poll routes), `_SOURCE_CONNS` (32/16), `_PENDING_CONNS` (128/64) and `_BODY_MS` (10 s).

This table is generated from the route table in `src/gateway/` and `test/gatewaydocs.test.ts` fails when it drifts. `agentsocks gateway routes` prints the same list from the code.

<!-- gateway-routes:start -->
| Listener | Method | Path | Authentication |
|---|---|---|---|
| private | POST | `/mcp` | tailnet identity (via tailscale serve) |
| public | POST | `/mcp` | bearer token or OAuth access token |
| private | GET | `/app` | tailnet identity (via tailscale serve) |
| private | GET | `/app/` | tailnet identity (via tailscale serve) |
| private | GET | `/app/manifest.webmanifest` | tailnet identity (via tailscale serve) |
| private | GET | `/app/sw.js` | tailnet identity (via tailscale serve) |
| private | GET | `/app/icon.png` | tailnet identity (via tailscale serve) |
| private | GET | `/app/api/state` | tailnet identity (via tailscale serve) |
| private | GET | `/app/api/inbox` | tailnet identity (via tailscale serve) |
| private | GET | `/app/api/history` | tailnet identity (via tailscale serve) |
| private | POST | `/app/api/send` | tailnet identity (via tailscale serve) |
| private | GET | `/app/api/tasks` | tailnet identity (via tailscale serve) |
| private | POST | `/app/api/tasks/update` | tailnet identity (via tailscale serve) |
| private | POST | `/app/api/push/subscribe` | tailnet identity (via tailscale serve) |
| private | POST | `/app/api/push/unsubscribe` | tailnet identity (via tailscale serve) |
| private | POST | `/federation/peers` | tailnet identity of an allowed machine |
| private | POST | `/federation/send` | tailnet identity of an allowed machine |
| private | GET | `/federation/pull` | tailnet identity of an allowed machine |
| private | POST | `/federation/ack` | tailnet identity of an allowed machine |
| public | GET | `/.well-known/oauth-protected-resource` | none |
| public | GET | `/.well-known/oauth-protected-resource/mcp` | none |
| public | GET | `/.well-known/oauth-authorization-server` | none |
| public | POST | `/oauth/register` | none |
| public | GET | `/oauth/authorize` | one-time pairing code |
| public | POST | `/oauth/authorize` | one-time pairing code |
| public | POST | `/oauth/token` | none |
<!-- gateway-routes:end -->

The routes with authentication `none` are the OAuth protocol's own: metadata, client registration (rate-limited, public clients only, capped) and the token endpoint (PKCE and a single-use code required). The consent routes say `one-time pairing code` because the page asks for it; the metadata and registration cannot be used to read or send anything.

### What was and was not tested

Tested here, with a fake LocalAPI on a unix socket, a proxy that adds the headers `tailscale serve` adds, fake push and provider servers, and two real brokers in separate temporary directories: every authentication refusal in the table above, token handling, the OAuth flow including PKCE, code and refresh reuse and the pairing lockout, the tool sets and allowlists, channels, asks and ratings from a tailnet peer and a public peer, the kill switch on each part, federation both ways, the app's API, VAPID signatures, and the API peer loop.

**Not tested live, so treat these as experimental:** `tailscale serve` and `tailscale funnel` as the commands are printed (taken from Tailscale's documentation, not run); what `tailscale serve` really puts in `X-Forwarded-For` and `Host`; LocalAPI on a real tailscaled; `cloudflared`; ChatGPT's developer-mode connector (its plan limits decide whether it can write at all, and the flow follows the documented OAuth 2.1 shape without having met ChatGPT); the grok.com custom connector with a token; the xAI and OpenAI Responses APIs (the request shape follows their documentation; only fake servers were used); Web Push on iOS and Android (the first push, and whether an empty push shows on iOS); the page in Safari. The MCP transport is the SDK's stateless streamable HTTP; clients that insist on sessions may not connect.

Read `src/gateway/auth.ts` (identity and origin checks), `source.ts` (who opened the connection), `runtime.ts` (the request pipeline and the one place a route is matched, authenticated and run), `bearer.ts`, `tokens.ts`, `oauth.ts`, `policy.ts` (the allowlist at `routeSend`, and `mayReach`, which the channel and ask services use), `gtools.ts` (what each tool set does, in `TOOL_SURFACES`), `federation.ts`, `apipeer.ts`, `push.ts`. The tests are `test/gateway*.test.ts`. The defences in the table above, including the channel, ask and rating rows, were checked by mutation (the line removed, the test seen to fail), except where two layers guard the same thing and only the outer one is observable, such as the per-message kill-switch check in the federation push loop.

## Kill switch

`touch ~/.config/agentsocks/off`, or set `AGENTSOCKS_OFF=1`. Sends, classifier calls and wakes stop on
every path, and hooks do nothing. The gateway answers 503 on both listeners and closes them, federation links and API peers stop making requests, and Web Push stops. `agentsocks classifier off` turns the classifier off and leaves
everything else running.

## Reporting a vulnerability

Open a private security advisory on this repository on GitHub (the Security tab, then "Report a
vulnerability"). Please do not file a public issue for a vulnerability. Include the version
(`agentsocks --version`), what you did, and what you expected.

## How releases are checked

Every release, 0.4 included, is reviewed by independent AI reviewers for correctness, security and spec fit, and CI runs the test suite on Linux and macOS (the live-agent rehearsals and the tests that need Linux, such as the `/proc` readers and the gateway source check, run on Linux only); see above for how to report a problem.
CI scans the full git history for secrets with `gitleaks git --log-opts=--all`. The redaction tests build
their fake credentials at run time, so no source file contains one. `.gitleaksignore` lists the 24
findings in older commits, which are those same fake credentials as they were first committed, one
fingerprint (commit, file, rule, line) each, so nothing added later is covered.
