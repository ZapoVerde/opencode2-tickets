/**
 * Pure ticket model: the closed stage set, the transition rules, and the fold
 * from an append-only event log to current state.
 *
 * Nothing here touches SQLite, the clock, or the host. The store owns identity
 * and ordering; this module owns meaning, so every rule below can be tested
 * without a database.
 */

export const STAGES = [
  "planned",
  "building",
  "ready-to-deploy",
  "deployed",
  "held",
  "abandoned",
  "superseded",
] as const
export type Stage = (typeof STAGES)[number]

/** Stages a ticket never leaves. */
export const TERMINAL_STAGES: readonly Stage[] = ["abandoned", "superseded"]

export const ARTIFACT_KINDS = ["branch", "worktree", "commit", "deploy"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const RELATIONS = ["fork", "supersedes", "blocks"] as const
export type Relation = (typeof RELATIONS)[number]

/**
 * One ticket is one pass of plan → build → check → deploy, and nothing else.
 *
 *   planned ─────────────→ building ─────────→ ready-to-deploy ─────────→ deployed
 *   (plan)                 (do)                (check: waits on a person)  (deploy)
 *
 * `ready-to-deploy` is the check point: the work exists and a person decides
 * whether it ships. `deployed` is a one-way door — the only way out is
 * `superseded`, because a ticket does not go back to building.
 *
 * A check that finds the work wanting is a NEW ticket, not a reopened one.
 * Tickets are cheap and one-intent is the point: "add retry with backoff" and
 * "cap retries at five" are two intents, so they are two tickets, and the
 * second one says `fork` or `supersedes` so the chain stays readable. That is
 * what keeps every ticket's remit clear enough to hand over.
 */
const TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  planned: ["building", "ready-to-deploy", "held", "abandoned", "superseded"],
  building: ["ready-to-deploy", "deployed", "held", "abandoned", "superseded"],
  "ready-to-deploy": ["building", "deployed", "held", "abandoned", "superseded"],
  deployed: ["superseded"],
  held: ["planned", "building", "ready-to-deploy", "deployed", "abandoned", "superseded"],
  abandoned: [],
  superseded: [],
}

export function isStage(value: unknown): value is Stage {
  return STAGES.some((stage) => stage === value)
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return ARTIFACT_KINDS.some((kind) => kind === value)
}

export function isRelation(value: unknown): value is Relation {
  return RELATIONS.some((relation) => relation === value)
}

export function isTerminal(stage: Stage) {
  return TERMINAL_STAGES.includes(stage)
}

/**
 * `deployed` is finished in the sense that matters to the board: nothing more
 * happens to this ticket. A follow-up is a new ticket. It is not in
 * `TERMINAL_STAGES` only because `superseded` is still a legal last move.
 */
export function isFinished(stage: Stage) {
  return stage === "deployed" || isTerminal(stage)
}

/** A transition to the same stage is not a transition; use a note or handover for that. */
export function canTransition(from: Stage, to: Stage) {
  return TRANSITIONS[from].includes(to)
}

export type TicketRecord = {
  readonly id: string
  readonly title: string
  readonly intent: string
  /** Absolute path the work lives in; also the repo identity for a plain clone. */
  readonly directory: string
  readonly repo: string | null
  readonly createdAt: number
}

export type EventKind =
  | "created"
  | "stage"
  | "owner"
  | "note"
  | "handover"
  | "artifact"
  | "question"
  | "relation"

/**
 * One immutable line in a ticket's log. Every row may carry the trace that
 * proves where the work happened; the log never stores work itself.
 */
export type TicketEvent = {
  readonly id: string
  readonly ticketID: string
  readonly seq: number
  readonly kind: EventKind
  readonly stage: Stage | null
  readonly owner: string | null
  readonly text: string | null
  readonly artifactKind: ArtifactKind | null
  readonly artifactName: string | null
  readonly artifactValue: string | null
  readonly relation: Relation | null
  readonly relatedTicketID: string | null
  readonly sessionID: string | null
  readonly messageID: string | null
  readonly agent: string | null
  readonly createdAt: number
}

export type Artifact = {
  readonly kind: ArtifactKind
  readonly name: string
  readonly value: string
  readonly at: number
  readonly eventID: string
}

export type TicketState = {
  readonly stage: Stage
  readonly owner: string | null
  /** The current open question, or null once answered. */
  readonly question: string | null
  readonly artifacts: readonly Artifact[]
  readonly relations: readonly TicketRelation[]
  readonly lastEventAt: number
  readonly lastStageAt: number
}

export type TicketRelation = {
  readonly relation: Relation
  readonly ticketID: string
  readonly at: number
}

/**
 * Fold the ordered log. Stage starts at `planned`; each later stage event wins,
 * so replaying the same log always produces the same state and a ticket whose
 * log is empty is still well defined.
 */
export function derive(events: readonly TicketEvent[]): TicketState {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const stage = ordered.filter((event) => event.stage !== null).at(-1)?.stage ?? "planned"
  const questionEvent = ordered.filter((event) => event.kind === "question").at(-1)
  const question = questionEvent?.text === "" ? null : (questionEvent?.text ?? null)
  const artifacts = ordered.flatMap((event) =>
    event.kind === "artifact" && event.artifactKind && event.artifactName && event.artifactValue
      ? [
          {
            kind: event.artifactKind,
            name: event.artifactName,
            value: event.artifactValue,
            at: event.createdAt,
            eventID: event.id,
          },
        ]
      : [],
  )
  const relations = ordered.flatMap((event) =>
    event.kind === "relation" && event.relation && event.relatedTicketID
      ? [{ relation: event.relation, ticketID: event.relatedTicketID, at: event.createdAt }]
      : [],
  )
  const stageEvents = ordered.filter((event) => event.stage !== null)
  const ownerEvent = ordered
    .filter((event) => event.kind === "created" || event.kind === "owner" || event.kind === "handover")
    .at(-1)
  return {
    stage,
    owner: ownerEvent?.owner ?? null,
    question,
    artifacts,
    relations,
    lastEventAt: ordered.at(-1)?.createdAt ?? 0,
    lastStageAt: stageEvents.at(-1)?.createdAt ?? 0,
  }
}

/** The trace a write was performed from, if the caller knows one. */
export type Trace = {
  readonly sessionID: string | null
  readonly messageID: string | null
  readonly agent: string | null
}

export type Write =
  | { readonly kind: "stage"; readonly stage: Stage }
  | { readonly kind: "owner"; readonly owner: string | null }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "handover"; readonly stage: Stage; readonly note: string; readonly owner: string | null }
  | { readonly kind: "artifact"; readonly artifactKind: ArtifactKind; readonly name: string; readonly value: string }
  | { readonly kind: "question"; readonly text: string | null }
  | { readonly kind: "relation"; readonly relation: Relation; readonly ticketID: string }

export type EventFields = Omit<TicketEvent, "id" | "ticketID" | "seq" | "createdAt">

export type Planned =
  | { readonly ok: true; readonly event: EventFields }
  | { readonly ok: false; readonly reason: string }

/**
 * Decide whether a write is allowed against current state and turn it into the
 * event fields the store will persist. Supporting detail lives below the main
 * entry point; the happy path reads as the list of write kinds.
 */
export function plan(state: TicketState, write: Write): Planned {
  switch (write.kind) {
    case "stage":
      return planStage(state, write.stage)
    case "owner":
      return planned({ kind: "owner", owner: normalizeOwner(write.owner) })
    case "note":
      return planText("note", write.text)
    case "handover":
      return planHandover(state, write)
    case "artifact":
      return planArtifact(write)
    case "question":
      return planned({ kind: "question", text: write.text === null ? null : singleLine(write.text) })
    case "relation":
      if (write.ticketID.length === 0) return rejected("relation needs a target ticket")
      return planned({ kind: "relation", relation: write.relation, relatedTicketID: write.ticketID })
  }
}

function planStage(state: TicketState, stage: Stage): Planned {
  if (!isStage(stage)) return rejected(`unknown stage ${String(stage)}`)
  if (stage === state.stage) return rejected(`ticket is already ${stage}`)
  if (!canTransition(state.stage, stage))
    return rejected(`cannot move from ${state.stage} to ${stage}`)
  return planned({ kind: "stage", stage })
}

function planHandover(
  state: TicketState,
  write: Extract<Write, { kind: "handover" }>,
): Planned {
  if (!isStage(write.stage)) return rejected(`unknown stage ${String(write.stage)}`)
  // A handover to the current stage is a legitimate pass of the baton, so it
  // skips the transition check but still records the new owner and note.
  if (write.stage !== state.stage && !canTransition(state.stage, write.stage))
    return rejected(`cannot move from ${state.stage} to ${write.stage}`)
  const note = singleLine(write.note)
  if (note.length === 0) return rejected("handover needs a one-line note")
  return planned({ kind: "handover", stage: write.stage, text: note, owner: normalizeOwner(write.owner) })
}

function planArtifact(write: Extract<Write, { kind: "artifact" }>): Planned {
  if (!isArtifactKind(write.artifactKind)) return rejected(`unknown artifact kind ${String(write.artifactKind)}`)
  const name = singleLine(write.name)
  const value = write.value.trim()
  if (name.length === 0) return rejected("artifact needs a name")
  if (value.length === 0) return rejected("artifact needs an immutable value (a SHA or a path)")
  if (/\s/.test(value)) return rejected("artifact value must be a single token: a SHA or a path")
  return planned({
    kind: "artifact",
    artifactKind: write.artifactKind,
    artifactName: name,
    artifactValue: value,
  })
}

function planText(kind: "note", text: string): Planned {
  const note = singleLine(text)
  if (note.length === 0) return rejected("note is empty")
  return planned({ kind, text: note })
}

function planned(event: Partial<EventFields> & Pick<EventFields, "kind">): Planned {
  return {
    ok: true,
    event: {
      stage: null,
      owner: null,
      text: null,
      artifactKind: null,
      artifactName: null,
      artifactValue: null,
      relation: null,
      relatedTicketID: null,
      sessionID: null,
      messageID: null,
      agent: null,
      ...event,
    },
  }
}

function rejected(reason: string): Planned {
  return { ok: false, reason }
}

function normalizeOwner(owner: string | null | undefined) {
  const trimmed = owner?.trim() ?? ""
  return trimmed.length === 0 ? null : trimmed
}

/** Intent, notes, and handovers are one line by contract; fold anything longer rather than reject it. */
export function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

/** How long a ticket may sit in planned/building before the board calls it stale. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type BoardTicket = {
  readonly ticket: TicketRecord
  readonly state: TicketState
  readonly stale: boolean
  readonly blocked: boolean
  readonly waiting: boolean
  readonly blockers: readonly string[]
}

export type Board = {
  readonly needsYou: readonly BoardTicket[]
  readonly working: readonly BoardTicket[]
  readonly closed: readonly BoardTicket[]
  readonly counts: {
    readonly needsYou: number
    readonly working: number
    readonly closed: number
    readonly stale: number
  }
}

type Entry = { readonly ticket: TicketRecord; readonly events: readonly TicketEvent[] }

/**
 * Group a whole board. A ticket needs a person when it is waiting on a decision
 * (ready-to-deploy, held) or is blocked; everything else that is still moving
 * collapses into `working`, and finished work into `closed`.
 *
 * Staleness is computed here, at read time, and never written back: the log
 * keeps saying `building` because that is what actually happened.
 */
export function board(entries: readonly Entry[], now: number, staleAfter = STALE_AFTER_MS): Board {
  const derived = entries.map((entry) => ({ entry, state: derive(entry.events) }))
  const rows = derived.map(({ entry, state }) => buildRow(entry.ticket, state, derived, now, staleAfter))
  const needsYou = rows
    .filter((row) => row.waiting || row.blocked)
    .sort(compareNeedsYou)
  const working = rows
    .filter((row) => !row.waiting && !row.blocked && !isFinished(row.state.stage))
    .sort(compareRecent)
  const closed = rows
    .filter((row) => !row.waiting && !row.blocked && isFinished(row.state.stage))
    .sort(compareRecent)
  return {
    needsYou,
    working,
    closed,
    counts: {
      needsYou: needsYou.length,
      working: working.length,
      closed: closed.length,
      stale: working.filter((row) => row.stale).length,
    },
  }
}

/** Waiting on a person outranks blocked; within a rank, the newest activity first. */
function compareNeedsYou(left: BoardTicket, right: BoardTicket) {
  return rank(left) - rank(right) || compareRecent(left, right)
}

/**
 * A ticket is blocked while another ticket that is still in flight lists a
 * `blocks` relation to it. A shipped or closed blocker has stopped blocking,
 * because nothing else is going to happen to it.
 */
function buildRow(
  ticket: TicketRecord,
  state: TicketState,
  derived: readonly { readonly entry: Entry; readonly state: TicketState }[],
  now: number,
  staleAfter: number,
): BoardTicket {
  const blockers = derived.flatMap((other) => {
    if (other.entry.ticket.id === ticket.id) return []
    if (isFinished(other.state.stage)) return []
    const blocks = other.state.relations.some(
      (relation) => relation.relation === "blocks" && relation.ticketID === ticket.id,
    )
    return blocks ? [other.entry.ticket.id] : []
  })
  const blocked = blockers.length > 0
  const waiting = state.stage === "ready-to-deploy" || state.stage === "held"
  const stale =
    (state.stage === "planned" || state.stage === "building") && now - state.lastEventAt >= staleAfter
  return { ticket, state, stale, blocked, waiting, blockers }
}

/** The board's order is the reader's order: ready-to-deploy, then held, then blocked. */
function rank(row: BoardTicket) {
  if (row.state.stage === "ready-to-deploy") return 0
  if (row.state.stage === "held") return 1
  if (row.blocked && row.state.question !== null) return 2
  return 3
}

function compareRecent(left: BoardTicket, right: BoardTicket) {
  return right.state.lastEventAt - left.state.lastEventAt || left.ticket.id.localeCompare(right.ticket.id)
}
