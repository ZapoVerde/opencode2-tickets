import { Plugin } from "@opencode/plugin"
import { openStore, resolveDatabasePath } from "./src/store"
import { tools } from "./src/tools"

/**
 * Out-of-tree ticket plugin. Tickets are a project record, not a session record:
 * they live in a sidecar SQLite database and outlive the sessions that served
 * them. This entry point only registers write tools; the board reads the same
 * file over HTTP from `web/server.ts`, so it answers even when no agent runs.
 */
export default Plugin.define({
  id: "opencode2-tickets",
  async setup(context) {
    const store = openStore(resolveDatabasePath(context.options))
    const repo = detectRepo(context.location.directory)
    const registered = await context.tool.transform((editor) => {
      for (const tool of tools({ store, directory: context.location.directory, repo })) editor.add(tool)
    })
    return () => registered.dispose()
  },
})

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
