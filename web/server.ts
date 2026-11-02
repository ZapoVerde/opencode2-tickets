#!/usr/bin/env bun
import { existsSync } from "node:fs"
import path from "node:path"
import { emptyBoard, readBoard, type BoardResponse } from "../src/board"
import { createLiveness } from "../src/liveness"
import { openStore, resolveDatabasePath } from "../src/store"
import { ALL_INTERFACES, LOOPBACK, parseArguments, usage } from "./flags"

/**
 * Read-only board over HTTP. There are no write routes by design: writes happen
 * only through the agent tools, which is why there is no CSRF or auth-on-write
 * story to own.
 */
const staticFiles = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
])

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log(usage)
  process.exit(0)
}

const parsed = parseArguments(process.argv.slice(2))
if (!parsed.ok) {
  console.error(`error: ${parsed.message}`)
  console.error("")
  console.error(usage)
  process.exit(2)
}

const dbPath = parsed.options.db ?? resolveDatabasePath({})

const server = Bun.serve({
  hostname: parsed.options.host,
  port: parsed.options.port,
  fetch: requestHandler,
})

const schemeAndHost =
  parsed.options.host === ALL_INTERFACES
    ? `http://${ALL_INTERFACES}:${server.port}`
    : `http://${LOOPBACK}:${server.port}`
console.log(`opencode2-tickets board: ${schemeAndHost} (${parsed.options.host === ALL_INTERFACES ? "all interfaces" : "loopback only"})`)
console.log(`sidecar: ${dbPath}`)

const liveness = createLiveness()

function readNow(): BoardResponse {
  const store = openStore(dbPath, { readonly: true })
  try {
    return readBoard(store, Date.now(), liveness)
  } finally {
    store.close()
  }
}

function requestHandler(request: Request) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
  const url = new URL(request.url)
  if (url.pathname === "/api/board") {
    // Opened read-only per request so a ticket written by a running agent shows
    // up on refresh without a restart, and so the board never holds a writer.
    // A sidecar that does not exist yet reads as an empty board, not an error:
    // the board is often deployed before any agent has written a ticket.
    return json(existsSync(dbPath) ? readNow() : emptyBoard(Date.now()), 200)
  }
  if (url.pathname === "/api/meta") {
    return json({ sidecar: dbPath, sidecarExists: existsSync(dbPath), capabilities: ["board"] }, 200)
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404)
  return serveStatic(url.pathname)
}

async function serveStatic(pathname: string) {
  const entry = staticFiles.get(pathname)
  if (entry === undefined) return json({ error: "not found" }, 404)
  const file = Bun.file(path.join(import.meta.dir, "public", entry[0]))
  if (!(await file.exists())) return json({ error: "not found" }, 404)
  return new Response(file, { headers: { ...headers, "content-type": entry[1] } })
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  })
}
