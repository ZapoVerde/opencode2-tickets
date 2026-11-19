# opencode2-tickets

An out-of-tree [OpenCode V2](https://opencode.ai) plugin that makes started-but-not-deployable work visible. A ticket is a durable record of intent, stage, owner, open question, artifacts, and the messages where the work happened. It lives in its own SQLite sidecar, outlives the sessions that served it, and never touches OpenCode's database.

Phase 1 is deliberately small: agent **writes** through tools, a **read-only** board over HTTP, and an entry point in the app. Nothing here changes permissions.

## Install

Register the directory in `opencode.json`:

```json
{
  "plugins": [{ "package": "/path/to/opencode2-tickets" }]
}
```

The plugin has no runtime dependencies: the host provides `@opencode/plugin`, and `bun:sqlite` ships with Bun. Do not add either to this directory's `node_modules`; the host refuses to load its own packages from a plugin.

### Options

| Option | Values | Default | Meaning |
| --- | --- | --- | --- |
| `dbPath` | path | XDG default | Sidecar location. |
| `enforce` | `off`, `build`, `all` | `off` | Whether the write gate is armed. `OPENCODE_TICKETS_ENFORCE` is read when the option is absent. |

```json
{
  "plugins": [
    { "package": "/path/to/opencode2-tickets", "options": { "enforce": "build" } }
  ]
}
```

`enforce` defaults to **off** on purpose: installing the plugin, or restarting a
server that already has it, must not start refusing writes in a session that is
mid-build. Arming the gate is a deliberate act, and it takes effect on the next
plugin load.

### Database path

1. plugin option `dbPath`
2. `OPENCODE_TICKETS_DB`
3. `${XDG_DATA_HOME ?? ~/.local/share}/opencode/tickets.db`

Opened with `PRAGMA journal_mode = WAL` and a 5 s busy timeout.

## Why a ticket, and why not a session

A session is the context container; a ticket is the project record. One session may serve several tickets over time, and a ticket outlives any session. That is why tickets are not session metadata, and why "ready-to-deploy" and "held" are **stages**, not new tickets.

## Model

### One ticket is one pass: plan → build → check → deploy

That is the whole shape. A ticket is one intent taken through one pass, and it
carries the lines the reviewer actually checks:

```
planned ──────────→ building ──────────→ ready-to-deploy ──────────→ deployed
(plan)              (do)                 (check: a person decides)    (ship)
                                            │
                                            └─→ building   (check says: not yet)
```

`ready-to-deploy` is the check point: the work exists and a person decides whether it ships. Nothing else waits on a person.

**`deployed` is a one-way door.** The only move out of it is `superseded`. A ticket never goes back to `building`, because a ticket records one intent and reopening it would blur what that intent was.

### Kind and done: what the reviewer checks

A ticket names its `kind` — `feature`, `fix`, `ui`, `refactor`, `ops`, or `research` — and carries up to six `done` lines: checkable statements, not a description of the work.

The kind sets the question the lines answer. A refactor is judged on "nothing changed". Ops is judged on "the send ran and the worktree is gone". A UI pass is judged on what the agent **exercised**: every shipped control, and the ones it could not exercise, named. Taste is not predicted in a line, because nobody can predict what they will hate on first look.

Moving to `ready-to-deploy` with no `done` lines is allowed and the tool says so, so a person is never told "done" without being told what would prove it.

### A check that finds the work wanting raises a new ticket

This is the common case — build, deploy, look at it, and decide it needs more — and the answer is a new ticket, not a reopened one:

1. The follow-up gets its own `ticket_create` with its own intent, so its remit stays clear enough to hand over.
2. It records `relation: fork` (the work came out of the deployed ticket) or `relation: supersedes` (it replaces it) pointing at the original.
3. The original stays `deployed` with its full log, including the deploy artifact that produced the follow-up.

Tickets are cheap. One intent per ticket is what makes "hand it over" mean something, and the relation is what keeps the chain readable instead of leaving a pile of unrelated rows.

### Stage set and legal moves

The set is closed and transitions are enforced in `src/ticket.ts`:

```
planned ──┬─→ building ──┬─→ ready-to-deploy ──┬─→ deployed ──→ superseded
          │              │                    │
          ├─→ ready-to-deploy                  ├─→ held ──┬─→ planned
          ├─→ held         └─→ deployed        │          ├─→ building
          └─→ abandoned / superseded           │          ├─→ ready-to-deploy
                                               │          ├─→ deployed
                                               │          └─→ abandoned / superseded
```

- `held` is a stage, not a new ticket: it can return to any live stage.
- `abandoned` and `superseded` are terminal.
- `planned → deployed` is refused: a ticket has to record a build or a check first.
- A move to the stage a ticket is already in is refused. Use a note or a handover for that.
- A deployed ticket can only be `superseded`. Follow-up work is a new ticket (above).

### Events, not state

Everything is an append-only event log (`ticket_event`). Current state is a fold over the ordered log, so replaying a log always gives the same answer and no write rewrites history.

`title`, `intent`, `kind` and `done` are the ticket's identity, not its history: they are written once, on the `ticket` row, the same way the existing fields are. A correction is a new ticket, which is what keeps the history honest.

| Kind | Meaning |
| --- | --- |
| `created` | The ticket, its title, intent, directory, repo, initial owner |
| `stage` | A stage move; carries no prose |
| `owner` | Set or clear the owner |
| `note` | One line of judgement |
| `handover` | Stage + one-line note + new owner, in one event |
| `artifact` | `branch` / `worktree` / `commit` / `deploy`, with a name and an immutable value |
| `question` | The single open question, or `null` when answered |
| `relation` | `fork` / `supersedes` / `blocks`, pointing at another ticket |

A handover note carries only what is **not** recorded elsewhere: judgement, caveats, what the next agent must know. It is folded to one line and must not be empty.

### Artifacts are facts; liveness is read

An artifact records an immutable value — a branch name, a worktree path, a commit SHA, a deploy id — plus a timestamp. It never stores "current head". The board asks git at read time (`src/liveness.ts`), with a 15 s cache per artifact:

| Kind | Read live as |
| --- | --- |
| `branch` | `present`, `merged` into `origin/HEAD`/`dev`/`main`, or `missing` |
| `worktree` | `clean`, `dirty` (with a changed-file count), or `missing` |
| `commit` | `present` in this repo, or `missing` |
| `deploy` | `unknown` — recorded, never inspected |

Anything unreadable is `unknown` with a short reason, never a guess.

### Stale at read

A ticket in `planned` or `building` with no activity for seven days **displays** as stale. The log keeps saying `building`, because that is what actually happened.

## Agent tools

Registered as `codemode: false` tools; every write records the calling session, message, and agent as its trace automatically.

| Tool | Purpose |
| --- | --- |
| `ticket_create` | `title`, `intent`, optional `kind`, `done[]`, `owner`, `repo` |
| `ticket_handover` | `ticket`, `stage`, `note`, optional `owner` |
| `ticket_stage` | `ticket`, `stage` |
| `ticket_owner` | `ticket`, `owner` (or `null`) |
| `ticket_note` | `ticket`, `note` |
| `ticket_artifact` | `ticket`, `kind`, `name`, `value` |
| `ticket_question` | `ticket`, `question` (or `null`) |
| `ticket_relation` | `ticket`, `relation`, `target` |

A refused write is a tool failure whose message is the rule, for example `cannot move from planned to deployed`. The pure module is the only source of those rules, so a tool cannot invent a transition.

There is no automatic ticket creation. Only an explicit tool call creates one.

## The write gate

With `enforce` set, an agent cannot change a file until a ticket for that
repository is `building` in this session or one of its parents:

- The hook is `permission.evaluate`, so it sees the action every file change
  carries. A deny reaches the model as the tool's error, with the recovery in
  the message: create a ticket, move it to `building`, retry.
- `edit` is the gated action. That covers the edit, write and patch tools and a
  shell redirect (`echo x > file`). Reads are never gated.
- A ticket authorizes a session when its log holds a write from that session or
  an ancestor. A sibling session cannot spend it, so adopting a ticket means
  handing it over to yourself, which is the record the board needs.
- A ticket in another repository never authorizes. Repositories are matched by
  Git common directory, so a worktree and its checkout are the same repo.
- `build` mode gates only sessions under the `build` agent, including subagents
  by ancestry. `all` gates every agent; `off` disables the gate.
- A sidecar that cannot be read **allows** the write. A broken database must
  never take the server down with it.

The gate is a forcing function, not a sandbox. Two writes bypass it by design:

- Shell commands that write without asserting `edit` — `sed -i`, `rm`, `mv`,
  `git checkout --`. Only redirects are classified as file writes.
- A tool that asserts its own action name, such as an MCP write tool.

## The board

```sh
bun run web
# opencode2-tickets board: http://127.0.0.1:4600 (loopback only)

bun run web --port 4601 --db ./tickets.db
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <number>` | `4600` | Port. `0` picks a free port. |
| `--host <address>` | `127.0.0.1` | `0.0.0.0` must be explicit. |
| `--db <path>` | `OPENCODE_TICKETS_DB`, then XDG default | Sidecar path. |

| Route | Returns |
| --- | --- |
| `GET /` | The board page (three files, no build step, no external assets) |
| `GET /api/board` | `{ generatedAt, counts, needsYou[], working[], closed[] }` |
| `GET /api/meta` | Resolved sidecar path, whether it exists, `capabilities: ["board"]` |

**The board is read-only.** There is no write route, which is why there is no CSRF or auth-on-write design to own. Every non-GET request is `405`.

The page groups work the way a person triages it:

1. **Needs you** — `ready-to-deploy` first, then `held`, then blocked work. A ticket is blocked while an unfinished ticket lists a `blocks` relation to it.
2. **Moving** — everything else still in progress. Stale tickets are flagged here rather than moved.
3. **Settled** — `deployed`, `abandoned`, `superseded`.

A healthy ticket takes no space: no accent rail, muted metadata, and only the flags that carry information.

Each trace entry is a link to `#message-<id>` in the session that produced it, which the app already understands. Traces are coalesced per message, so five writes from one message are one link, not five.

The sidecar is opened read-only per request, so a ticket written by a running agent appears on refresh, and a not-yet-created sidecar reads as an empty board rather than an error.

**The sidecar directory must be writable even though the board only reads.** SQLite needs to create `-wal` and `-shm` files beside a WAL database; on a read-only mount the open fails with `SQLITE_READONLY_DIRECTORY`. That is reported as a `503` naming the path, not as an empty board, so a deployment mistake cannot look like "no tickets".

## Deployment

`web/server.ts` is a plain HTTP server, so run it however you run sidecars:

```sh
bun run web/server.ts --port 4600
```

It serves the board, its JSON API, and the static page from `web/public/`. Keep the
sidecar directory writable (SQLite needs `-wal`/`-shm` beside it) and mount it
read-write into whatever container runs the board.

To hang it off the app under a path, put a reverse proxy in front and exclude the
prefix from the app's service-worker navigation fallback so an installed app does not
answer it with the app shell. `/tickets` redirecting to `/tickets/` is the shape that
works.

## Layout

```
server.ts            plugin entry: registers the tools and the write gate, derives the repo from git
src/ticket.ts        pure model: stages, kinds, transitions, fold, board grouping (no I/O)
src/gate.ts          pure write gate: which session, repository and stage authorizes an edit
src/store.ts         append-only SQLite store and migration
src/liveness.ts      live git reads: branch merged, worktree clean, commit present
src/tools.ts         agent tool surface, one thin translation per write
src/board.ts         board read model: grouping, liveness, coalesced traces
web/server.ts        read-only HTTP board
web/flags.ts         flags, kept apart so the entry point is importable
web/public/          board page: no build, no dependencies
```

## Development

```sh
bun install
bun run typecheck
bun test
```

The host-boundary test lives in the OpenCode checkout at `packages/core/test/plugin/tickets-plugin.test.ts`: it loads this plugin through the real Promise adapter, calls its tools with schema-validated input, and asserts both a successful write and a surfaced refusal. It skips when this directory is absent.

## Known limits

- **The gate is not a sandbox.** It refuses the `edit` action, which is every declared file write. A shell command that writes without asserting one (`sed -i`, `rm`, `mv`, `git checkout --`) and a tool that asserts its own action name (an MCP write tool) both pass. See "The write gate".
- **The gate is off by default.** Arming it is a config change, so a restart never refuses writes in a session that is already building.
- **No concurrency guardrails.** Serial use is a norm, not an enforced rule. Two agents writing the same ticket interleave append-only events; the fold stays consistent, but there is no conflict detection.
- **No automatic ticket creation.** Nothing derives a ticket from events. The gate forces one before the first write; it cannot judge whether the ticket is honest.
- **No reviewer or capability changes.**
- **Staleness only applies to live stages.** Waiting work is not called stale, because waiting is the ticket doing its job.
- **A deployed ticket never goes stale.** Nothing chases a deploy that was never checked; the follow-up is a ticket somebody has to raise. That is the deliberate trade for keeping one ticket to one pass.
- **The board never writes.** Fixing a wrong ticket means an agent appends a correcting event.
- **`done` lines are not verified.** They are the reviewer's checklist, not an assertion the store can check. Nothing prevents a ticket reaching `ready-to-deploy` with a line that is false.
