import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openStore } from "../src/store"
import { parseArguments } from "../web/flags"

const root = mkdtempSync(path.join(os.tmpdir(), "opencode2-tickets-web-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ok = (argv: string[]) => {
  const result = parseArguments(argv)
  if (!result.ok) throw new Error(result.message)
  return result.options
}

const error = (argv: string[]) => {
  const result = parseArguments(argv)
  return result.ok ? null : result.message
}

describe("server flags", () => {
  test("defaults to loopback on the documented port with the resolved sidecar", () => {
    expect(ok([])).toEqual({ port: 4600, host: "127.0.0.1", db: null })
  })

  test("accepts --port and --host, in both spaced and inline form", () => {
    expect(ok(["--port", "0", "--host", "0.0.0.0"])).toEqual({ port: 0, host: "0.0.0.0", db: null })
    expect(ok(["--port=4610", "--host=127.0.0.1", "--db=/tmp/x.db"])).toEqual({
      port: 4610,
      host: "127.0.0.1",
      db: "/tmp/x.db",
    })
  })

  test("refuses a host other than loopback or all interfaces", () => {
    expect(error(["--host", "192.168.1.5"])).toBe("--host must be 127.0.0.1 or 0.0.0.0")
  })

  test("refuses a bad port and an unknown flag", () => {
    expect(error(["--port", "http"])).toBe("--port expects an integer between 0 and 65535")
    expect(error(["--port", "70000"])).toBe("--port expects an integer between 0 and 65535")
    expect(error(["--verbose"])).toBe("unknown argument --verbose")
  })
})

describe("server routes", () => {
  // The handler is exercised through the real process so the test covers
  // routing and the per-request sidecar open, not a copy of that logic.
  const serve = async (dbPath: string) => {
    const child = Bun.spawn({
      cmd: ["bun", "run", path.join(import.meta.dir, "..", "web", "server.ts"), "--port", "0", "--db", dbPath],
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let banner = ""
    while (!banner.includes("board: http://")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`server exited: ${decoder.decode()}`)
      banner += decoder.decode(chunk.value)
    }
    const port = /:(\d+)/.exec(banner)![1]!
    return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() }
  }

  test("serves the board, its page, and nothing writable", async () => {
    const dbPath = path.join(root, "routes.db")
    const server = await serve(dbPath)
    try {
      // The sidecar does not exist yet: that is an empty board, not an error.
      const board = await fetch(`${server.base}/api/board`)
      expect(board.status).toBe(200)
      expect(await board.json()).toMatchObject({
        counts: { total: 0 },
        needsYou: [],
        working: [],
        closed: [],
      })

      const page = await fetch(`${server.base}/`)
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      expect(await page.text()).toContain("Needs you")

      const meta = await fetch(`${server.base}/api/meta`)
      expect(await meta.json()).toMatchObject({ capabilities: ["board"] })

      // A ticket written by an agent appears on the next refresh without a restart.
      const store = openStore(dbPath)
      const ticket = store.create({
        title: "From an agent",
        intent: "appear without a restart",
        directory: "/repo",
        repo: null,
        owner: "build",
        trace: { sessionID: "ses_web", messageID: "msg_web", agent: "build" },
      })
      store.close()
      const refreshed = await (await fetch(`${server.base}/api/board`)).json()
      expect(refreshed.counts.total).toBe(1)
      expect(refreshed.working[0].id).toBe(ticket.id)

      expect((await fetch(`${server.base}/api/unknown`)).status).toBe(404)
      expect((await fetch(`${server.base}/api/board`, { method: "POST" })).status).toBe(405)
      expect((await fetch(`${server.base}/nope`)).status).toBe(404)
    } finally {
      server.stop()
    }
  })
})
