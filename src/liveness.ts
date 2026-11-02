/**
 * Liveness is read live from git at read time and never stored. A ticket
 * remembers a branch name or a SHA — an immutable fact — while "is it merged?",
 * "is the worktree clean?" and "where does that branch point now?" are
 * questions only git can answer.
 */

export type ArtifactKind = "branch" | "worktree" | "commit" | "deploy"

export type Artifact = {
  readonly kind: ArtifactKind
  readonly name: string
  readonly value: string
}

export type ArtifactState = "present" | "merged" | "clean" | "dirty" | "missing" | "unknown"

export type ArtifactLiveness = Artifact & {
  readonly state: ArtifactState
  /** Short human sentence for the board; empty when there is nothing to add. */
  readonly detail: string
  /** Where the branch or worktree points right now, when that is knowable. */
  readonly head: string | null
}

const CACHE_MS = 15_000

/**
 * Git is an external process, so the read path checks each artifact once per
 * TTL and shares the answer. Liveness is never persisted: a board refresh after
 * the TTL asks git again.
 */
export function createLiveness(options: { readonly timeoutMs?: number } = {}) {
  const cache = new Map<string, { readonly at: number; readonly value: ArtifactLiveness }>()
  const repositories = new Map<string, boolean>()
  const timeout = options.timeoutMs ?? 2_000

  return {
    check(directory: string, artifact: Artifact): ArtifactLiveness {
      const key = `${directory}\u0000${artifact.kind}\u0000${artifact.value}`
      const hit = cache.get(key)
      if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value
      const value = inspect(directory, artifact, timeout, repositories)
      cache.set(key, { at: Date.now(), value })
      return value
    },
  }
}

function inspect(
  directory: string,
  artifact: Artifact,
  timeoutMs: number,
  repositories: Map<string, boolean>,
): ArtifactLiveness {
  if (artifact.kind === "deploy") return { ...artifact, state: "unknown", detail: "recorded", head: null }
  if (!isRepository(directory, timeoutMs, repositories))
    return { ...artifact, state: "unknown", detail: "not a git repository", head: null }
  if (artifact.kind === "commit") return commitState(directory, artifact, timeoutMs)
  if (artifact.kind === "branch") return branchState(directory, artifact, timeoutMs)
  return worktreeState(directory, artifact, timeoutMs)
}

function isRepository(directory: string, timeoutMs: number, repositories: Map<string, boolean>) {
  const hit = repositories.get(directory)
  if (hit !== undefined) return hit
  const value = git(directory, ["rev-parse", "--git-dir"], timeoutMs) !== null
  repositories.set(directory, value)
  return value
}

function commitState(directory: string, artifact: Artifact, timeoutMs: number): ArtifactLiveness {
  const resolved = git(directory, ["rev-parse", "--verify", "--quiet", `${artifact.value}^{commit}`], timeoutMs)
  if (resolved === null) return { ...artifact, state: "missing", detail: "commit not in this repository", head: null }
  return { ...artifact, state: "present", detail: "", head: short(resolved) }
}

function branchState(directory: string, artifact: Artifact, timeoutMs: number): ArtifactLiveness {
  const local = git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${artifact.value}`], timeoutMs)
  if (local === null) {
    const remote = git(
      directory,
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${artifact.value}`],
      timeoutMs,
    )
    if (remote === null) return { ...artifact, state: "missing", detail: "branch not found", head: null }
    return { ...artifact, state: "present", detail: "remote only", head: short(remote) }
  }
  const merged = mergedIntoBase(directory, artifact.value, timeoutMs)
  return {
    ...artifact,
    state: merged === null ? "present" : merged ? "merged" : "present",
    detail: merged === true ? "merged" : merged === null ? "no base branch" : "",
    head: short(local),
  }
}

/**
 * The base is `origin/HEAD` when the clone has one, otherwise `dev`, then
 * `main`. `null` means no base could be found and merge state is unknowable.
 */
function mergedIntoBase(directory: string, branch: string, timeoutMs: number): boolean | null {
  const base =
    git(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], timeoutMs)?.replace(
      /^origin\//,
      "",
    ) ??
    (git(directory, ["rev-parse", "--verify", "--quiet", "refs/heads/dev"], timeoutMs) === null ? null : "dev") ??
    (git(directory, ["rev-parse", "--verify", "--quiet", "refs/heads/main"], timeoutMs) === null ? null : "main")
  if (base === null) return null
  if (base === branch) return true
  const merged = git(directory, ["branch", "--merged", base, "--format=%(refname:short)"], timeoutMs)
  return merged === null ? null : merged.split("\n").includes(branch)
}

function worktreeState(directory: string, artifact: Artifact, timeoutMs: number): ArtifactLiveness {
  const listed = git(directory, ["worktree", "list", "--porcelain"], timeoutMs)
  if (listed === null) return { ...artifact, state: "unknown", detail: "git worktree list failed", head: null }
  const entry = parseWorktrees(listed).find((worktree) => worktree.path === artifact.value)
  if (entry === undefined) return { ...artifact, state: "missing", detail: "worktree not registered", head: null }
  // `status` must run inside the worktree itself, or it reports the wrong tree.
  const status = git(entry.path, ["status", "--porcelain"], timeoutMs)
  if (status === null) return { ...artifact, state: "unknown", detail: "", head: entry.head?.slice(0, 7) ?? null }
  const changed = status.length === 0 ? 0 : status.split("\n").length
  return {
    ...artifact,
    state: changed === 0 ? "clean" : "dirty",
    detail: changed === 0 ? "clean" : `${changed} changed ${changed === 1 ? "file" : "files"}`,
    head: entry.head?.slice(0, 7) ?? null,
  }
}

export type WorktreeEntry = {
  readonly path: string
  readonly head: string | null
  readonly branch: string | null
}

export function parseWorktrees(porcelain: string): readonly WorktreeEntry[] {
  return porcelain
    .split("\n\n")
    .flatMap((block) => {
      const lines = block.split("\n")
      const path = lines.find((line) => line.startsWith("worktree "))
      if (path === undefined) return []
      const head = lines.find((line) => line.startsWith("HEAD "))
      const branch = lines.find((line) => line.startsWith("branch "))
      return [
        {
          path: path.slice("worktree ".length),
          head: head?.slice("HEAD ".length) ?? null,
          branch: branch?.slice("branch ".length).replace("refs/heads/", "") ?? null,
        },
      ]
    })
}

const short = (sha: string) => sha.slice(0, 7)

function git(directory: string, args: readonly string[], timeoutMs: number): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, ...args],
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
  })
  if (result.exitCode !== 0) return null
  return result.stdout.toString().trim()
}
