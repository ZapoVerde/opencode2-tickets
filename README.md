# opencode2-tickets

An out-of-tree [OpenCode V2](https://opencode.ai) plugin that makes started-but-not-deployable work visible. A ticket is a durable record of intent, stage, owner, open question, artifacts, and the messages where the work happened. It lives in its own SQLite sidecar, outlives the sessions that served it, and never touches OpenCode's database.

Phase 1 is deliberately small: agent **writes** through tools, a **read-only** board over HTTP, and an entry point in the app. Nothing here changes permissions.

## Install

Register the directory in `opencode.json`:

```json
{
  "plugins": [{ "package": "/config/workspace/opencode2-tickets" }]
}
```

The plugin has no runtime dependencies: the host provides `@opencode/plugin`, and `bun:sqlite` ships with Bun. Do not add either to this directory's `node_modules`; the host refuses to load its own packages from a plugin.

### Database path

1. plugin option `dbPath`
2. `OPENCODE_TICKETS_DB`
3. `${XDG_DATA_HOME ?? ~/.local/share}/opencode/tickets.db`

Opened with `PRAGMA journal_mode = WAL` and a 5 s busy timeout.

## Why a ticket, and why not a session

A session is the context container; a ticket is the project record. One session may serve several tickets over time, and a ticket outlives any session. That is why tickets are not session metadata, and why "ready-to-deploy" and "held" are **stages**, not new tickets.

## Model

### One ticket is one pass: plan → build → check → deploy

That is the whole shape. A ticket is one intent taken through one pass:

```
planned ──────────→ building ──────────→ ready-to-deploy ──────────→ deployed
(plan)              (do)                 (check: a person decides)    (ship)
                                            │
                                            └─→ building   (check says: not yet)
```

`ready-to-deploy` is the check point: the work exists and a person decides whether it ships. Nothing else waits on a person.

**`deployed` is a one-way door.** The only move out of it is `superseded`. A ticket never goes back to `building`, because a ticket records one intent and reopening it would blur what that intent was.

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
| `ticket_create` | `title`, `intent`, optional `owner`, optional `repo` |
| `ticket_handover` | `ticket`, `stage`, `note`, optional `owner` |
| `ticket_stage` | `ticket`, `stage` |
| `ticket_owner` | `ticket`, `owner` (or `null`) |
| `ticket_note` | `ticket`, `note` |
| `ticket_artifact` | `ticket`, `kind`, `name`, `value` |
| `ticket_question` | `ticket`, `question` (or `null`) |
| `ticket_relation` | `ticket`, `relation`, `target` |

A refused write is a tool failure whose message is the rule, for example `cannot move from planned to deployed`. The pure module is the only source of those rules, so a tool cannot invent a transition.

There is no automatic ticket creation. Only an explicit tool call creates one.

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

## Deployment

The stack runs the board as its own container, mirroring the usage sidecar:

- `/config/workspace/stacks/opencode2/compose.yaml` → `tickets` service (`opencode2-tickets`, port 4600)
- `/config/workspace/stacks/opencode2/ui.conf` → `/tickets` redirect and `/tickets/` proxy

Only `opencode2-ui` and `opencode2-tickets` need recreating when those change; the main server is untouched.

## Layout

```
server.ts            plugin entry: registers the tools, derives the repo from git
src/ticket.ts        pure model: stages, transitions, fold, board grouping (no I/O)
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

## Known limits (phase 1)

- **No permission change.** Grants keep clearing on agent switch. "A ticket authorizes Boss" is phase 2, deliberately parked.
- **No concurrency guardrails.** Serial use is a norm, not an enforced rule. Two agents writing the same ticket interleave append-only events; the fold stays consistent, but there is no conflict detection.
- **No automatic ticket creation.** Nothing derives a ticket from events.
- **No reviewer or capability changes.**
- **Staleness only applies to live stages.** Waiting work is not called stale, because waiting is the ticket doing its job.
- **A deployed ticket never goes stale.** Nothing chases a deploy that was never checked; the follow-up is a ticket somebody has to raise. That is the deliberate trade for keeping one ticket to one pass.
- **The board never writes.** Fixing a wrong ticket means an agent appends a correcting event.
