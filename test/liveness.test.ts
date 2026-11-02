import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createLiveness, parseWorktrees } from "../src/liveness"

const root = mkdtempSync(path.join(os.tmpdir(), "opencode2-tickets-git-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

/** A repo with a `dev` base, one merged branch, one unmerged branch, and one worktree. */
function fixture(name: string) {
  const repo = path.join(root, name)
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "dev")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "test")
  writeFileSync(path.join(repo, "a.txt"), "a\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "base")
  git(repo, "branch", "merged-work")
  git(repo, "switch", "-q", "-c", "open-work")
  writeFileSync(path.join(repo, "b.txt"), "b\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "work")
  git(repo, "switch", "-q", "dev")
  const worktree = path.join(root, `${name}-worktree`)
  git(repo, "worktree", "add", "-q", worktree, "open-work")
  return { repo, worktree, head: git(repo, "rev-parse", "HEAD") }
}

const artifact = (kind: "branch" | "worktree" | "commit" | "deploy", value: string) => ({
  kind,
  name: kind,
  value,
})

describe("liveness", () => {
  test("a commit is present when it resolves and missing when it does not", () => {
    const { repo, head } = fixture("commits")
    const liveness = createLiveness()
    expect(liveness.check(repo, artifact("commit", head))).toMatchObject({ state: "present" })
    expect(liveness.check(repo, artifact("commit", "0".repeat(40)))).toMatchObject({ state: "missing" })
  })

  test("a branch is merged when it is an ancestor of dev, and present when it is not", () => {
    const { repo } = fixture("branches")
    const liveness = createLiveness()
    expect(liveness.check(repo, artifact("branch", "merged-work"))).toMatchObject({
      state: "merged",
      detail: "merged",
    })
    expect(liveness.check(repo, artifact("branch", "open-work"))).toMatchObject({
      state: "present",
      detail: "",
    })
    expect(liveness.check(repo, artifact("branch", "gone"))).toMatchObject({
      state: "missing",
      detail: "branch not found",
    })
  })

  test("a worktree is clean or dirty as it is right now, not as it was recorded", () => {
    const { repo, worktree } = fixture("worktrees")
    const liveness = createLiveness()
    expect(liveness.check(repo, artifact("worktree", worktree))).toMatchObject({
      state: "clean",
      detail: "clean",
    })
    writeFileSync(path.join(worktree, "dirty.txt"), "x\n")
    // A fresh reader, because the first answer is cached for the TTL.
    expect(createLiveness().check(repo, artifact("worktree", worktree))).toMatchObject({
      state: "dirty",
      detail: "1 changed file",
    })
  })

  test("a deploy is recorded but never inspected", () => {
    const liveness = createLiveness()
    expect(liveness.check("/nowhere", artifact("deploy", "deploy-42"))).toMatchObject({
      state: "unknown",
      detail: "recorded",
    })
  })

  test("a directory outside any repository reports unknown instead of throwing", () => {
    const liveness = createLiveness()
    expect(liveness.check(root, artifact("branch", "dev"))).toMatchObject({
      state: "unknown",
      detail: "not a git repository",
    })
    expect(liveness.check(root, artifact("worktree", root))).toMatchObject({ state: "unknown" })
  })

  test("results are cached per artifact so a board refresh does not spawn git per row", () => {
    const { repo } = fixture("cache")
    const liveness = createLiveness()
    const first = liveness.check(repo, artifact("branch", "dev"))
    // Mutating the repo behind the cache cannot change an already-cached answer.
    git(repo, "branch", "-m", "dev", "renamed")
    expect(liveness.check(repo, artifact("branch", "dev"))).toEqual(first)
    expect(createLiveness().check(repo, artifact("branch", "dev"))).toMatchObject({
      state: "missing",
      detail: "branch not found",
    })
  })
})

describe("parseWorktrees", () => {
  test("reads paths, heads, and branches from porcelain output", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/dev",
      "",
      "worktree /repo-wt",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/open-work",
      "",
      "worktree /repo-detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
    ].join("\n")
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/repo", head: "1111111111111111111111111111111111111111", branch: "dev" },
      { path: "/repo-wt", head: "2222222222222222222222222222222222222222", branch: "open-work" },
      { path: "/repo-detached", head: "3333333333333333333333333333333333333333", branch: null },
    ])
  })
})
