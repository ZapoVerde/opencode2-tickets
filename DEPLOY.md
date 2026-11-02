# Deploying the tickets board

Phase 1 is two independent halves. Deploying the board alone gives you a read-only
view. Registering the plugin is what makes tickets get created.

Everything below is outside this repository except the plugin itself.

## State, as handed over

- Plugin repo clean at `5287a41` (87 tests, typecheck clean).
- App changes are on branch **`tickets-phase-1-replay`**, based on current main
  `b4ea8435f4`, in the worktree `/tmp/opencode/replay`. Verified there:
  `typecheck:tsc` clean, `test:unit` 957/957, the two tickets e2e cases pass in
  built mode, and the core host test passes.
- `packages/app/dist` in that worktree is **built and contains the Tickets entry**.
- `/config/workspace/stacks/opencode2/compose.yaml` has the `tickets` service;
  `docker compose config` validates.
- `/config/workspace/stacks/opencode2/ui.conf` has the `/tickets` redirect and proxy.

The original `tickets-phase-1` branch is based on `3bc815bedf`, which main no longer
descends from (the permission patches were re-landed after the 2026-11-02 upstream
merge). A merge from it reports 31 conflicts; it is superseded by the replay. Delete or
ignore it.

## The order matters

### 1. Merge the replay branch

```sh
cd /config/workspace/opencode2
git checkout -b tickets-phase-1-merge   # or merge into whichever branch is live
git merge tickets-phase-1-replay
```

It should fast-forward or merge cleanly; the replay was cherry-picked onto `b4ea8435f4`
and conflicts on the way in were only upstream renames.

### 2. Register the plugin (without this, no tickets are ever created)

The live config at `/opencode2-state/config/opencode/opencode.json` lists only the usage
plugin today. Add the tickets plugin beside it:

```json
"plugins": [
  { "package": "/config/workspace/opencode2-usage" },
  { "package": "/config/workspace/opencode2-tickets" }
]
```

This is a host config change: the `opencode2` container must restart after it.

If you skip this step the board still works and reads the sidecar, but every `ticket_*`
tool call fails with "No tool named ticket_create". Tasks that shell out to the tools
fail loudly rather than silently passing.

### 3. Build the app into the served path

`opencode2-ui` serves `/home/ubuntu/appdata/vscfiles/vscode-config/workspace/opencode2/packages/app/dist`
(`docker inspect opencode2-ui` confirms this mount). A build from the replay worktree is
already there to copy:

```sh
cd /tmp/opencode/replay/packages/app
bun run build                     # already done; re-run after merging normally

rm -rf /config/workspace/opencode2/packages/app/dist
cp -a dist /config/workspace/opencode2/packages/app/dist
```

Do not skip this. The currently served dist predates the feature, so without it `/tickets/`
works but the app has no Tickets button.

### 4. Start the board and recreate the UI

```sh
cd /config/workspace/stacks/opencode2
docker compose up -d tickets
docker compose up -d --force-recreate opencode2-ui
docker compose up -d --force-recreate opencode2   # only for step 2
```

## Verify

```sh
docker logs --tail 20 opencode2-tickets
# expect: opencode2-tickets board: http://0.0.0.0:4600 (all interfaces)
#         sidecar: /opencode2-state/data/opencode/tickets.db

docker exec opencode2-usage true && curl -s http://127.0.0.1/tickets/api/meta
# via the UI container, not the server port
```

Expect `{"counts":{"needsYou":0,...}}` on first boot. The sidecar is created on the
first agent write, and a missing sidecar is served as an empty board on purpose.

Then open `/tickets/` from the app: Tickets beside Usage in the phone tabs drawer, or
in the Home column on desktop.

## Things that will bite

**The sidecar mount must stay read-write.** SQLite creates `-wal`/`-shm` beside a WAL
database; a read-only mount fails with `SQLITE_READONLY_DIRECTORY`. The board reports
that as a `503` naming the path rather than an empty board, so "Cannot read the ticket
sidecar" means the mount, not missing data. Do not "fix" it by tolerating the failure.

**The usage service mounts the same tree read-only and is fine.** Not a counter-example:
it only reads databases a live server already opened. The tickets board opens the
sidecar itself.

**No Tickets button means a stale bundle, not the proxy.** Load `/tickets/` directly
first; if the page works, rebuild and recopy dist.

**A missing `ticket_*` tool means step 2 is undone.**

## Done looks like

- An agent can call `ticket_create`, `ticket_stage`, `ticket_handover`, `ticket_artifact`.
- `/tickets/` lists it; `ready-to-deploy` and `held` show under "Needs you" with the
  attention dot on the Tickets entry.
- A trace entry links to `/server/<key>/session/<id>#message-<id>` and lands on the
  message.

## Rollback

Remove the `tickets` service and the two `ui.conf` locations, restore the previous
`dist`, recreate `opencode2-ui`, drop the plugin entry, restart `opencode2`. The
sidecar can stay; nothing else reads it.
