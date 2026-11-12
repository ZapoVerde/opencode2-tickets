import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SCHEMA_VERSION, TicketWriteError, migrate, openStore } from "../src/store"
import { derive } from "../src/ticket"

const root = mkdtempSync(path.join(os.tmpdir(), "opencode2-tickets-store-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const trace = { sessionID: "ses_1", messageID: "msg_1", agent: "build" }

const create = (store: ReturnType<typeof openStore>) =>
  store.create({
    title: "WhatsApp send retry",
    intent: "add retry with backoff to WhatsApp send",
    directory: "/repo",
    repo: "/repo",
    owner: "build",
    trace,
  })

describe("store", () => {
  test("create seeds a planned ticket with a traceable created event", () => {
    const store = openStore(":memory:")
    const ticket = create(store)
    expect(ticket.id.startsWith("tick_")).toBe(true)
    expect(store.get(ticket.id)).toEqual(ticket)
    const events = store.events(ticket.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: "created", stage: "planned", owner: "build", sessionID: "ses_1", messageID: "msg_1" })
    expect(derive(events).stage).toBe("planned")
  })

  test("appends are a sequence starting at zero, and the trace is stored per write", () => {
    const store = openStore(":memory:")
    const ticket = create(store)
    store.append(ticket.id, { kind: "stage", stage: "building" }, { sessionID: "ses_2", messageID: "msg_9", agent: "plan" })
    const events = store.events(ticket.id)
    expect(events.map((event) => event.seq)).toEqual([0, 1])
    expect(events[1]).toMatchObject({ kind: "stage", stage: "building", sessionID: "ses_2", messageID: "msg_9", agent: "plan" })
  })

  test("an illegal transition throws and writes nothing", () => {
    const store = openStore(":memory:")
    const ticket = create(store)
    expect(() => store.append(ticket.id, { kind: "stage", stage: "deployed" }, trace)).toThrow(TicketWriteError)
    expect(store.events(ticket.id)).toHaveLength(1)
  })

  test("the log is append-only: two events at the same stage keep their history", () => {
    const store = openStore(":memory:")
    const ticket = create(store)
    store.append(ticket.id, { kind: "stage", stage: "building" }, trace)
    store.append(ticket.id, { kind: "handover", stage: "building", note: "baton", owner: "plan" }, trace)
    store.append(ticket.id, { kind: "stage", stage: "ready-to-deploy" }, trace)
    expect(store.events(ticket.id).map((event) => event.kind)).toEqual(["created", "stage", "handover", "stage"])
    expect(derive(store.events(ticket.id))).toMatchObject({ stage: "ready-to-deploy", owner: "plan" })
  })

  test("artifacts are appended, never replaced, so an old SHA stays visible", () => {
    const store = openStore(":memory:")
    const ticket = create(store)
    store.append(ticket.id, { kind: "artifact", artifactKind: "commit", name: "head", value: "aaaa111" }, trace)
    store.append(ticket.id, { kind: "artifact", artifactKind: "commit", name: "head", value: "bbbb222" }, trace)
    expect(derive(store.events(ticket.id)).artifacts.map((artifact) => artifact.value)).toEqual(["aaaa111", "bbbb222"])
  })

  test("board returns every ticket with its log", () => {
    const store = openStore(":memory:")
    const first = create(store)
    const second = store.create({
      title: "second",
      intent: "second intent",
      directory: "/repo",
      repo: null,
      owner: null,
      trace,
    })
    const board = store.board()
    expect(board.map((entry) => entry.ticket.id).sort()).toEqual([first.id, second.id].sort())
    expect(board.find((entry) => entry.ticket.id === second.id)!.events).toHaveLength(1)
  })

  test("reopening an existing sidecar keeps its rows", () => {
    const file = path.join(root, "reopen.db")
    const first = openStore(file)
    const ticket = create(first)
    first.close?.()
    const second = openStore(file)
    expect(second.get(ticket.id)?.title).toBe("WhatsApp send retry")
    second.close?.()
  })

  test("round-trips kind and done through a reopened sidecar", () => {
    const file = path.join(root, "kind-done.db")
    const first = openStore(file)
    const ticket = first.create({
      title: "Reader controls",
      intent: "each control does something",
      kind: "ui",
      done: ["every shipped control was tapped", "the unexercised ones are named"],
      directory: "/repo",
      repo: "/repo",
      owner: "build",
      trace,
    })
    first.close()
    const second = openStore(file)
    expect(second.get(ticket.id)).toMatchObject({
      kind: "ui",
      done: ["every shipped control was tapped", "the unexercised ones are named"],
    })
    second.close()
  })

  test("an unknown ticket id is refused by the store, not just by the tools", () => {
    const store = openStore(":memory:")
    // A ticket is a row plus a log. Appending to a missing row would leave an
    // event no board read can ever show, so the store refuses it outright.
    expect(() => store.append("tick_missing", { kind: "note", text: "orphan" }, trace)).toThrow(TicketWriteError)
    expect(store.events("tick_missing")).toEqual([])
    expect(store.tickets()).toEqual([])
  })
})

describe("migration", () => {
  test("creating the schema twice is a no-op and records the current version", () => {
    const db = new Database(":memory:")
    expect(migrate(db)).toBe(SCHEMA_VERSION)
    expect(migrate(db)).toBe(SCHEMA_VERSION)
    expect(db.query("SELECT version FROM schema_meta").all()).toEqual([{ version: SCHEMA_VERSION }])
  })

  test("a v1 sidecar gains kind and done without losing a row", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE ticket (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL,
        directory TEXT NOT NULL, repo TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE ticket_event (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        stage TEXT, owner TEXT, text TEXT, artifact_kind TEXT, artifact_name TEXT,
        artifact_value TEXT, relation TEXT, related_ticket_id TEXT, session_id TEXT,
        message_id TEXT, agent TEXT, created_at INTEGER NOT NULL, UNIQUE (ticket_id, seq)
      );
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta (version) VALUES (1);
      INSERT INTO ticket (id, title, intent, directory, repo, created_at)
        VALUES ('tick_old', 'old', 'still readable', '/repo', '/repo', 1);
    `)
    migrate(db)
    // Reading through the same connection the migration ran on proves the row
    // survives and the new columns carry their defaults.
    const row = db
      .query<{ kind: string; done: string }, [string]>("SELECT kind, done FROM ticket WHERE id = ?")
      .get("tick_old")
    expect(row).toEqual({ kind: "feature", done: "[]" })
  })

  test("a v1 sidecar read read-only reports the defaults instead of failing", () => {
    const file = path.join(root, "v1-readonly.db")
    const db = new Database(file)
    db.exec(`
      CREATE TABLE ticket (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL,
        directory TEXT NOT NULL, repo TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE ticket_event (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        stage TEXT, owner TEXT, text TEXT, artifact_kind TEXT, artifact_name TEXT,
        artifact_value TEXT, relation TEXT, related_ticket_id TEXT, session_id TEXT,
        message_id TEXT, agent TEXT, created_at INTEGER NOT NULL, UNIQUE (ticket_id, seq)
      );
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta (version) VALUES (1);
      INSERT INTO ticket (id, title, intent, directory, repo, created_at)
        VALUES ('tick_old', 'old', 'still readable', '/repo', '/repo', 1);
    `)
    db.close()
    // The board opens read-only and cannot migrate, so a board deployed before
    // the next agent load must still read the older file.
    const store = openStore(file, { readonly: true })
    expect(store.get("tick_old")).toMatchObject({ kind: "feature", done: [] })
    expect(store.tickets()).toHaveLength(1)
    store.close()
  })

  test("the schema keeps closed sets as text and timestamps as epoch ms", () => {
    const db = new Database(":memory:")
    migrate(db)
    const columns = db.query<{ name: string; type: string }, []>("SELECT name, type FROM pragma_table_info('ticket_event')").all()
    expect(columns.find((column) => column.name === "stage")?.type).toBe("TEXT")
    expect(columns.find((column) => column.name === "created_at")?.type).toBe("INTEGER")
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "ticket_id",
      "seq",
      "kind",
      "stage",
      "owner",
      "text",
      "artifact_kind",
      "artifact_name",
      "artifact_value",
      "relation",
      "related_ticket_id",
      "session_id",
      "message_id",
      "agent",
      "created_at",
    ])
  })
})
