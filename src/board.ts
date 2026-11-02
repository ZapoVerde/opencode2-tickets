import { type ArtifactLiveness, createLiveness } from "./liveness"
import type { TicketStore } from "./store"
import type { TicketEvent } from "./ticket"
import { type Board, type BoardTicket, board } from "./ticket"

export type BoardRow = {
  readonly id: string
  readonly title: string
  readonly intent: string
  readonly stage: string
  readonly owner: string | null
  readonly directory: string
  readonly repo: string | null
  readonly question: string | null
  readonly stale: boolean
  readonly blocked: boolean
  readonly blockers: readonly string[]
  readonly artifacts: readonly ArtifactLiveness[]
  readonly relations: readonly { readonly relation: string; readonly ticketID: string }[]
  readonly traces: readonly BoardTrace[]
  readonly createdAt: number
  readonly lastEventAt: number
}

export type BoardTrace = {
  readonly sessionID: string | null
  readonly messageID: string | null
  readonly agent: string | null
  readonly at: number
  readonly kind: string
  readonly text: string | null
}

export type BoardResponse = {
  readonly generatedAt: number
  readonly counts: Board["counts"] & { readonly total: number }
  readonly needsYou: readonly BoardRow[]
  readonly working: readonly BoardRow[]
  readonly closed: readonly BoardRow[]
}

/** The board before any ticket exists. Also what a not-yet-created sidecar reads as. */
export function emptyBoard(now: number): BoardResponse {
  return {
    generatedAt: now,
    counts: { needsYou: 0, working: 0, closed: 0, stale: 0, total: 0 },
    needsYou: [],
    working: [],
    closed: [],
  }
}

/**
 * Build the read-only board. Staleness, blocking, and artifact liveness are all
 * derived here from the log plus live git; nothing is written back, so the
 * board can be regenerated at any time and never disagrees with the record.
 */
export function readBoard(store: TicketStore, now: number, liveness = createLiveness()): BoardResponse {
  const entries = store.board()
  const summary = board(entries, now)
  const titles = new Map(entries.map((entry) => [entry.ticket.id, entry.ticket.title] as const))

  const toRow = (row: BoardTicket): BoardRow => {
    const events = store.events(row.ticket.id)
    return {
      id: row.ticket.id,
      title: row.ticket.title,
      intent: row.ticket.intent,
      stage: row.state.stage,
      owner: row.state.owner,
      directory: row.ticket.directory,
      repo: row.ticket.repo,
      question: row.state.question,
      stale: row.stale,
      blocked: row.blocked,
      blockers: row.blockers.map((id) => titles.get(id) ?? id),
      artifacts: row.state.artifacts.map((artifact) => liveness.check(row.ticket.directory, artifact)),
      relations: row.state.relations.map((relation) => ({
        relation: relation.relation,
        ticketID: titles.get(relation.ticketID) ?? relation.ticketID,
      })),
      traces: coalesceTraces(events),
      createdAt: row.ticket.createdAt,
      lastEventAt: row.state.lastEventAt,
    }
  }

  return {
    generatedAt: now,
    counts: {
      ...summary.counts,
      total: summary.counts.needsYou + summary.counts.working + summary.counts.closed,
    },
    needsYou: summary.needsYou.map(toRow),
    working: summary.working.map(toRow),
    closed: summary.closed.map(toRow),
  }
}

/**
 * One entry per message. A ticket usually takes several writes from the same
 * message, and repeating that link five times hides the others. The newest
 * write's timestamp wins, its prose is kept, and the kinds are folded into one
 * label so the reader still sees what happened there.
 */
function coalesceTraces(events: readonly TicketEvent[]): readonly BoardTrace[] {
  type Pending = { -readonly [Key in keyof BoardTrace]: BoardTrace[Key] } & { kinds: string[] }
  const bySessionMessage = new Map<string, Pending>()
  for (const event of events) {
    if (event.sessionID === null && event.messageID === null) continue
    const key = `${event.sessionID ?? ""}\u0000${event.messageID ?? ""}`
    const existing = bySessionMessage.get(key)
    const text = event.kind === "note" || event.kind === "handover" ? event.text : null
    if (existing === undefined) {
      bySessionMessage.set(key, {
        sessionID: event.sessionID,
        messageID: event.messageID,
        agent: event.agent,
        at: event.createdAt,
        kind: event.kind,
        text,
        kinds: [event.kind],
      })
      continue
    }
    existing.kinds.push(event.kind)
    existing.at = Math.max(existing.at, event.createdAt)
    existing.kind = existing.kinds.join(", ")
    if (text !== null) existing.text = text
  }
  return [...bySessionMessage.values()].map(({ kinds, ...trace }) => trace)
}
