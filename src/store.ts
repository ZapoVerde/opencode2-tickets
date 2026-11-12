import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  type ArtifactKind,
  type EventFields,
  type Kind,
  type Relation,
  type TicketEvent,
  type TicketRecord,
  type Trace,
  type Write,
  derive,
  doneLines,
  isArtifactKind,
  isKind,
  isRelation,
  isStage,
  plan,
} from "./ticket"

/**
 * Append-only ticket store in its own SQLite file. Tickets and their events live
 * here; nothing else does. Every write goes through `append`, which refuses a
 * write the pure module rejects, so an illegal transition cannot reach disk.
 */
export type TicketStore = {
  readonly path: string
  create(input: CreateInput): TicketRecord
  append(ticketID: string, write: Write, trace: Trace, now?: number): TicketEvent
  get(ticketID: string): TicketRecord | undefined
  events(ticketID: string): readonly TicketEvent[]
  tickets(): readonly TicketRecord[]
  /** Every ticket with its log, the read the board folds. */
  board(): readonly { readonly ticket: TicketRecord; readonly events: readonly TicketEvent[] }[]
  close(): void
}

export type CreateInput = {
  readonly title: string
  readonly intent: string
  /** Defaults to `feature`; the tool surface validates the closed set, so an unknown value never arrives. */
  readonly kind?: Kind
  readonly done?: readonly string[]
  readonly directory: string
  readonly repo: string | null
  readonly owner: string | null
  readonly trace: Trace
}

export const SCHEMA_VERSION = 2

const schema = `
CREATE TABLE IF NOT EXISTS ticket (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'feature',
  done TEXT NOT NULL DEFAULT '[]',
  directory TEXT NOT NULL,
  repo TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_created ON ticket(created_at);

CREATE TABLE IF NOT EXISTS ticket_event (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- created | stage | owner | note | handover | artifact | question | relation
  stage TEXT,                      -- closed set, see STAGES
  owner TEXT,
  text TEXT,
  artifact_kind TEXT,              -- branch | worktree | commit | deploy
  artifact_name TEXT,
  artifact_value TEXT,             -- immutable SHA or path; never "current head"
  relation TEXT,                   -- fork | supersedes | blocks
  related_ticket_id TEXT,
  session_id TEXT,
  message_id TEXT,
  agent TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (ticket_id, seq)
);
CREATE INDEX IF NOT EXISTS ticket_event_ticket ON ticket_event(ticket_id, seq);
CREATE INDEX IF NOT EXISTS ticket_event_message ON ticket_event(session_id, message_id);

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);
`

export function defaultDatabasePath() {
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "tickets.db")
}

/** `dbPath` plugin option wins over `OPENCODE_TICKETS_DB`, which wins over the XDG default. */
export function resolveDatabasePath(options: Readonly<Record<string, unknown>>) {
  const configured = options.dbPath
  if (typeof configured === "string" && configured.length > 0) return configured
  return process.env.OPENCODE_TICKETS_DB ?? defaultDatabasePath()
}

export function openStore(dbPath: string, options: { readonly readonly?: boolean } = {}): TicketStore {
  const connection = connect(dbPath, options.readonly === true)
  return {
    path: dbPath,
    create(input) {
      const now = Date.now()
      const ticket: TicketRecord = {
        id: newID("tick"),
        title: input.title.trim(),
        intent: input.intent.trim(),
        kind: input.kind ?? "feature",
        done: doneLines(input.done),
        directory: input.directory,
        repo: input.repo,
        createdAt: now,
      }
      connection.writes().ticket.run({
        $id: ticket.id,
        $title: ticket.title,
        $intent: ticket.intent,
        $kind: ticket.kind,
        $done: JSON.stringify(ticket.done),
        $directory: ticket.directory,
        $repo: ticket.repo,
        $created_at: ticket.createdAt,
      })
      appendEvent(
        connection,
        ticket.id,
        {
          kind: "created",
          stage: "planned",
          owner: input.owner,
          text: null,
          artifactKind: null,
          artifactName: null,
          artifactValue: null,
          relation: null,
          relatedTicketID: null,
          sessionID: input.trace.sessionID,
          messageID: input.trace.messageID,
          agent: input.trace.agent,
        },
        now,
      )
      return ticket
    },
    append(ticketID, write, trace, now = Date.now()) {
      if (connection.getTicket.get(ticketID) === null) throw new TicketWriteError(`unknown ticket ${ticketID}`)
      const decision = plan(derive(readEvents(connection, ticketID)), write)
      if (!decision.ok) throw new TicketWriteError(decision.reason)
      return appendEvent(
        connection,
        ticketID,
        {
          ...decision.event,
          sessionID: trace.sessionID,
          messageID: trace.messageID,
          agent: trace.agent,
        },
        now,
      )
    },
    get(ticketID) {
      const row = connection.getTicket.get(ticketID)
      return row === null ? undefined : toTicket(row)
    },
    events(ticketID) {
      return readEvents(connection, ticketID)
    },
    tickets() {
      return connection.listTickets.all().map(toTicket)
    },
    board() {
      return connection.listTickets
        .all()
        .map(toTicket)
        .map((ticket) => ({ ticket, events: readEvents(connection, ticket.id) }))
    },
    close() {
      connection.db.close()
    },
  }
}

/** A write the pure module refused. The message is already model-facing prose. */
export class TicketWriteError extends Error {}

function appendEvent(connection: Connection, ticketID: string, fields: EventFields, now: number): TicketEvent {
  const event: TicketEvent = {
    id: newID("tev"),
    ticketID,
    seq: connection.nextSeq.get(ticketID)?.next ?? 0,
    ...fields,
    createdAt: now,
  }
  connection.writes().event.run({
    $id: event.id,
    $ticket_id: event.ticketID,
    $seq: event.seq,
    $kind: event.kind,
    $stage: event.stage,
    $owner: event.owner,
    $text: event.text,
    $artifact_kind: event.artifactKind,
    $artifact_name: event.artifactName,
    $artifact_value: event.artifactValue,
    $relation: event.relation,
    $related_ticket_id: event.relatedTicketID,
    $session_id: event.sessionID,
    $message_id: event.messageID,
    $agent: event.agent,
    $created_at: event.createdAt,
  })
  return event
}

type Connection = ReturnType<typeof connect>

function connect(dbPath: string, readonly: boolean) {
  if (!readonly && dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: !readonly, readonly })
  db.exec("PRAGMA busy_timeout = 5000")
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL")
    migrate(db)
  }
  // The board reads read-only, so it cannot migrate. A sidecar written by an
  // older build is read with the defaults for the columns it does not have yet,
  // which keeps a board deployed before the next agent load from failing shut.
  const present = new Set(db.query<{ name: string }, []>("PRAGMA table_info(ticket)").all().map((column) => column.name))
  const kind = present.has("kind") ? "kind" : "'feature' AS kind"
  const done = present.has("done") ? "done" : "'[]' AS done"
  const select = `SELECT id, title, intent, ${kind}, ${done}, directory, repo, created_at FROM ticket`
  // Write statements are prepared on first use: a read-only connection cannot
  // prepare an INSERT against a column the file does not have yet, and the board
  // never writes anyway.
  let prepared: { readonly ticket: Statement; readonly event: Statement } | undefined
  const writes = () =>
    (prepared ??= {
      ticket: db.prepare(
        `INSERT INTO ticket (id, title, intent, kind, done, directory, repo, created_at)
         VALUES ($id, $title, $intent, $kind, $done, $directory, $repo, $created_at)`,
      ),
      event: db.prepare(
        `INSERT INTO ticket_event (
           id, ticket_id, seq, kind, stage, owner, text, artifact_kind, artifact_name,
           artifact_value, relation, related_ticket_id, session_id, message_id, agent, created_at
         ) VALUES (
           $id, $ticket_id, $seq, $kind, $stage, $owner, $text, $artifact_kind, $artifact_name,
           $artifact_value, $relation, $related_ticket_id, $session_id, $message_id, $agent, $created_at
         )`,
      ),
    })
  return {
    db,
    writes,
    getTicket: db.query<RawTicket, [string]>(`${select} WHERE id = ?`),
    listTickets: db.query<RawTicket, []>(`${select} ORDER BY created_at DESC`),
    nextSeq: db.query<{ next: number }, [string]>(
      "SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM ticket_event WHERE ticket_id = ?",
    ),
    events: db.query<RawEvent, [string]>("SELECT * FROM ticket_event WHERE ticket_id = ? ORDER BY seq"),
  }
}

/** Create the current schema, then add anything an older sidecar is missing. */
export function migrate(db: Database) {
  db.exec(schema)
  // `CREATE TABLE IF NOT EXISTS` cannot add a column to a v1 sidecar, so the
  // additions are checked by name. Adding a column is the only migration this
  // store performs; no row is ever rewritten.
  ensureColumn(db, "ticket", "kind", "TEXT NOT NULL DEFAULT 'feature'")
  ensureColumn(db, "ticket", "done", "TEXT NOT NULL DEFAULT '[]'")
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_meta").get()
  if (row === null) db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION)
  else db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION)
  return SCHEMA_VERSION
}

function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  if (columns.some((item) => item.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

type RawTicket = {
  readonly id: string
  readonly title: string
  readonly intent: string
  readonly kind: string
  readonly done: string
  readonly directory: string
  readonly repo: string | null
  readonly created_at: number
}

function toTicket(row: RawTicket): TicketRecord {
  return {
    id: row.id,
    title: row.title,
    intent: row.intent,
    kind: isKind(row.kind) ? row.kind : "feature",
    done: parseDone(row.done),
    directory: row.directory,
    repo: row.repo,
    createdAt: row.created_at,
  }
}

/** A hand-edited or older row must not fail a read; anything unreadable reads as no checklist. */
function parseDone(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? doneLines(parsed.filter((line): line is string => typeof line === "string")) : []
  } catch {
    return []
  }
}

function readEvents(connection: Connection, ticketID: string): readonly TicketEvent[] {
  return connection.events.all(ticketID).map(toEvent)
}

type RawEvent = {
  readonly id: string
  readonly ticket_id: string
  readonly seq: number
  readonly kind: string
  readonly stage: string | null
  readonly owner: string | null
  readonly text: string | null
  readonly artifact_kind: string | null
  readonly artifact_name: string | null
  readonly artifact_value: string | null
  readonly relation: string | null
  readonly related_ticket_id: string | null
  readonly session_id: string | null
  readonly message_id: string | null
  readonly agent: string | null
  readonly created_at: number
}

// Closed sets are enforced on write, so a value read back is already valid.
// Narrowing here keeps the fold total without re-validating in the reducer.
function toEvent(row: RawEvent): TicketEvent {
  return {
    id: row.id,
    ticketID: row.ticket_id,
    seq: row.seq,
    kind: row.kind as TicketEvent["kind"],
    stage: isStage(row.stage) ? row.stage : null,
    owner: row.owner,
    text: row.text,
    artifactKind: isArtifactKind(row.artifact_kind) ? row.artifact_kind : null,
    artifactName: row.artifact_name,
    artifactValue: row.artifact_value,
    relation: isRelation(row.relation) ? row.relation : null,
    relatedTicketID: row.related_ticket_id,
    sessionID: row.session_id,
    messageID: row.message_id,
    agent: row.agent,
    createdAt: row.created_at,
  }
}

function newID(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
}

export type { ArtifactKind, Relation, TicketEvent, TicketRecord }
