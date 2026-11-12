/**
 * The write gate: a permission evaluation that refuses to let an agent change
 * files until a ticket for that repository is `building` in this session or a
 * parent session.
 *
 * The rule is deliberately narrow. It gates `edit` — the action the edit, write
 * and patch tools assert, and the action a shell redirect asserts — because that
 * is the action every file change carries. Reads are never gated, and neither is
 * a tool that asserts its own action name (MCP tools, for example), so this is a
 * forcing function rather than a sandbox.
 *
 * Nothing here touches the host or SQLite: the caller resolves the session chain
 * and reads the board, and this module decides.
 */

import { type TicketEvent, derive } from "./ticket"

export const ENFORCE = ["off", "build", "all"] as const
export type Enforce = (typeof ENFORCE)[number]

export function isEnforce(value: unknown): value is Enforce {
  return ENFORCE.some((mode) => mode === value)
}

/** The action every file write carries, whether it arrives from a tool or a redirect. */
const GATED_ACTIONS: readonly string[] = ["edit"]

/** What the gate needs to know about one session in the chain. Bodies are not read. */
export type GateSession = {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
}

export type GateTicket = {
  readonly id: string
  readonly repo: string | null
  readonly directory: string
  readonly events: readonly TicketEvent[]
}

export type GateDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string }

export type GateInput = {
  readonly enforce: Enforce
  readonly action: string
  /** The agent the evaluation is for; the chain supplies ancestors. */
  readonly agent: string
  readonly repo: string | null
  readonly directory: string
  /** This session first, then its ancestors. */
  readonly chain: readonly GateSession[]
  readonly tickets: readonly GateTicket[]
}

export function gate(input: GateInput): GateDecision {
  if (input.enforce === "off") return allow()
  if (!GATED_ACTIONS.includes(input.action)) return allow()
  if (input.enforce === "build" && !underBuild(input)) return allow()

  const held = input.tickets.find((ticket) => authorizes(ticket, input))
  if (held !== undefined) return allow()
  return deny()
}

/** `build` is the agent that writes; subagents inherit it by ancestry rather than by their own name. */
function underBuild(input: GateInput) {
  if (input.agent === "build") return true
  return input.chain.some((session) => session.agent === "build")
}

/**
 * A ticket authorizes a session when it is `building` for the same repository and
 * some event on its log was written from this session or an ancestor. That is
 * what makes adopting a ticket a real move: a fresh session cannot spend a
 * sibling session's authorization, so it has to hand the ticket over to itself.
 */
function authorizes(ticket: GateTicket, input: GateInput) {
  if (!ticketAtBuilding(ticket) || !sameRepo(ticket, input)) return false
  const sessions = new Set(input.chain.map((session) => session.id))
  return ticket.events.some((event) => event.sessionID !== null && sessions.has(event.sessionID))
}

function ticketAtBuilding(ticket: GateTicket) {
  return derive(ticket.events).stage === "building"
}

/**
 * A worktree and its checkout share a Git common directory, so the repo is the
 * identity when there is one. A plugin activated outside Git falls back to the
 * directory, which is then the only identity available.
 */
function sameRepo(ticket: GateTicket, input: GateInput) {
  if (input.repo !== null) return ticket.repo === input.repo
  return ticket.directory === input.directory
}

/** The reason names the fix, in order, so the agent can recover without asking. */
function deny(): GateDecision {
  return {
    allow: false,
    reason: [
      "No ticket is building for this repository in this session, so file writes are blocked.",
      "Call ticket_create (title, intent, kind, and the checkable done lines), then ticket_stage to building, then retry.",
      "Reads are unaffected; ticket_create and ticket_stage are never blocked.",
    ].join(" "),
  }
}

function allow(): GateDecision {
  return { allow: true }
}
