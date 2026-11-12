import { Plugin } from "@opencode/plugin"
import { type Enforce, gate, isEnforce } from "./src/gate"
import { openStore, resolveDatabasePath } from "./src/store"
import { tools } from "./src/tools"

/** The slice of a host session the gate reads. */
type SessionRef = { readonly id: string; readonly parentID?: string; readonly agent?: string }

/**
 * Out-of-tree ticket plugin. Tickets are a project record, not a session record:
 * they live in a sidecar SQLite database and outlive the sessions that served
 * them. This entry point registers the write tools and, when asked, the write
 * gate; the board reads the same file over HTTP from `web/server.ts`, so it
 * answers even when no agent runs.
 */
export default Plugin.define({
  id: "opencode2-tickets",
  async setup(context) {
    const store = openStore(resolveDatabasePath(context.options))
    const repo = detectRepo(context.location.directory)
    const enforce = resolveEnforce(context.options)
    const registered = await context.tool.transform((editor) => {
      for (const tool of tools({ store, directory: context.location.directory, repo })) editor.add(tool)
    })

    // The gate is a permission rule, not a tool wrapper, so it sees the action
    // every file write carries — including a redirect inside a shell command and
    // a write from a subagent — and a denial reaches the model with the reason.
    const gated = await context.permission.hook("evaluate", async (event) => {
      if (enforce === "off" || event.action !== "edit") return
      // A broken sidecar must never stop the server from working, so an
      // unreadable store allows the write and the board reports the fault.
      const decision = await decide(event.sessionID, event.agent ?? "", event.action).catch(() => undefined)
      if (decision === undefined || decision.allow) return
      event.effect = "deny"
      event.message = decision.reason
    })

    async function decide(sessionID: string, agent: string, action: string) {
      const chain = await chainOf(sessionID)
      return gate({
        enforce,
        action,
        agent,
        repo,
        directory: context.location.directory,
        chain,
        tickets: store.board().map(({ ticket, events }) => ({
          id: ticket.id,
          repo: ticket.repo,
          directory: ticket.directory,
          events,
        })),
      })
    }

    async function chainOf(sessionID: string) {
      const chain: { id: string; parentID?: string; agent?: string }[] = []
      let id: string | undefined = sessionID
      // Bounded: a malformed parent chain must not walk forever.
      for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
        const session: { readonly data: SessionRef } | undefined = await context.session
          .get({ sessionID: id })
          .catch(() => undefined)
        if (session === undefined) break
        chain.push({ id: session.data.id, parentID: session.data.parentID, agent: session.data.agent })
        id = session.data.parentID
      }
      return chain
    }

    return () => {
      registered.dispose()
      gated.dispose()
      store.close()
    }
  },
})

/**
 * `off` unless the plugin option or `OPENCODE_TICKETS_ENFORCE` says otherwise.
 * The default is off so installing or restarting the plugin cannot block a
 * session that is already mid-build; arming it is a deliberate act.
 */
function resolveEnforce(options: Readonly<Record<string, unknown>>): Enforce {
  const configured = options.enforce ?? process.env.OPENCODE_TICKETS_ENFORCE
  return isEnforce(configured) ? configured : "off"
}

/**
 * Artifacts group by repository, and a worktree's directory is not its
 * repository. Record the common Git directory when there is one; a failure here
 * only means the board shows the checkout path instead.
 */
function detectRepo(directory: string): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    stdout: "pipe",
    stderr: "ignore",
    timeout: 2_000,
  })
  if (result.exitCode !== 0) return null
  const common = result.stdout.toString().trim()
  if (!common.endsWith("/.git")) return null
  return common.slice(0, -"/.git".length)
}
