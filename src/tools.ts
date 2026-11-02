import {
  ARTIFACT_KINDS,
  RELATIONS,
  STAGES,
  type Stage,
  type Trace,
  type Write,
  derive,
  singleLine,
} from "./ticket"
import type { TicketStore } from "./store"

/**
 * The agent-facing write surface. Every tool is a thin translation from input
 * to log appends; the rules live in `./ticket.ts`, so a tool cannot invent a
 * transition the pure module would refuse.
 *
 * Inputs are plain JSON Schema: the host validates them before `execute`, and
 * the plugin then needs no runtime dependency beyond `bun:sqlite`.
 */

/** The slice of the host tool context this surface reads. */
export type ToolContext = {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
}

type ToolResult = {
  readonly content: string
  readonly metadata?: Record<string, unknown>
}

export type TicketTool = {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly options: { readonly codemode: false }
  readonly execute: (input: any, context: ToolContext) => Promise<ToolResult>
}

const stageDescription = `One of: ${STAGES.join(", ")}`

export type ToolDeps = {
  readonly store: TicketStore
  readonly directory: string
  readonly repo: string | null
}

export function tools(deps: ToolDeps): readonly TicketTool[] {
  const append = (ticketID: string, write: Write, context: ToolContext) =>
    deps.store.append(ticketID, write, trace(context))

  const requireTicket = (ticketID: string) => {
    if (deps.store.get(ticketID) === undefined) throw new Error(`unknown ticket ${ticketID}`)
  }

  return [
    {
      name: "ticket_create",
      description: [
        "Create a durable ticket for work that has started but is not deployable yet.",
        "Use it only when the work will outlive this session; do not ticket finished or trivial tasks.",
        "The intent is the one line that should be true when the ticket is done.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short list title, e.g. 'WhatsApp send retry'" },
          intent: { type: "string", description: "One line: what should be true when this is done" },
          owner: { type: "string", description: "Agent owning the work now" },
          repo: { type: "string", description: "Repository directory, when this is a worktree of it" },
        },
        required: ["title", "intent"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const title = singleLine(String(input.title ?? ""))
        const intent = singleLine(String(input.intent ?? ""))
        if (title.length === 0) throw new Error("title is empty")
        if (intent.length === 0) throw new Error("intent is empty")
        const owner = typeof input.owner === "string" ? input.owner.trim() : ""
        const ticket = deps.store.create({
          title,
          intent,
          directory: deps.directory,
          repo: typeof input.repo === "string" && input.repo.length > 0 ? input.repo : deps.repo,
          owner: owner.length === 0 ? null : owner,
          trace: trace(context),
        })
        return {
          content: `Created ${ticket.id}: ${ticket.title}`,
          metadata: { ticketID: ticket.id },
        }
      },
    },
    {
      name: "ticket_handover",
      description: [
        "Hand this ticket to another agent, or to the person reviewing it.",
        "The note carries only what is NOT recorded elsewhere: judgement, caveats, and what the next agent must know.",
        "Do not restate the work or the artifacts; the message link already points at them.",
        "Pass the current stage to hand over without changing it.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          stage: { type: "string", enum: [...STAGES], description: stageDescription },
          note: {
            type: "string",
            description: "One line the next agent must know that is written nowhere else",
          },
          owner: { type: "string", description: "Agent taking over; omit to clear the owner" },
        },
        required: ["ticket", "stage", "note"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        const owner = typeof input.owner === "string" && input.owner.trim().length > 0 ? input.owner.trim() : null
        const event = append(
          input.ticket,
          { kind: "handover", stage: input.stage as Stage, note: String(input.note ?? ""), owner },
          context,
        )
        return {
          content: `Handed over ${input.ticket} at ${event.stage}${event.owner === null ? "" : ` to ${event.owner}`}`,
          metadata: { ticketID: input.ticket, eventID: event.id },
        }
      },
    },
    {
      name: "ticket_stage",
      description: [
        "Move a ticket to another stage.",
        stageDescription + ".",
        "Use ready-to-deploy when the work is done and waiting on a person, and held when it is deliberately parked.",
        "ready-to-deploy and held are stages, not new tickets.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          stage: { type: "string", enum: [...STAGES], description: stageDescription },
        },
        required: ["ticket", "stage"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        const previous = derive(deps.store.events(input.ticket)).stage
        const event = append(input.ticket, { kind: "stage", stage: input.stage as Stage }, context)
        return {
          content: `${input.ticket}: ${previous} → ${event.stage}`,
          metadata: { ticketID: input.ticket, eventID: event.id },
        }
      },
    },
    {
      name: "ticket_owner",
      description: "Set or clear the agent responsible for a ticket.",
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          owner: { type: ["string", "null"], description: "Agent id, or null to clear" },
        },
        required: ["ticket", "owner"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        const owner = typeof input.owner === "string" && input.owner.trim().length > 0 ? input.owner.trim() : null
        append(input.ticket, { kind: "owner", owner }, context)
        return {
          content: owner === null ? `Cleared owner of ${input.ticket}` : `${input.ticket} owned by ${owner}`,
          metadata: { ticketID: input.ticket },
        }
      },
    },
    {
      name: "ticket_note",
      description: [
        "Append one line of judgement to a ticket: a decision, a caveat, or something surprising.",
        "Do not use it to restate progress or to copy text that already exists in a message.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          note: { type: "string", description: "One line" },
        },
        required: ["ticket", "note"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        append(input.ticket, { kind: "note", text: String(input.note ?? "") }, context)
        return {
          content: `Noted on ${input.ticket}`,
          metadata: { ticketID: input.ticket },
        }
      },
    },
    {
      name: "ticket_artifact",
      description: [
        "Record where the work is: a branch, a worktree path, a commit SHA, or a deploy.",
        "Record an immutable value, never 'current head'; liveness is read live from git when the board loads.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "branch | worktree | commit | deploy" },
          name: { type: "string", description: "Short label, e.g. 'feature branch' or 'production'" },
          value: { type: "string", description: "Branch name, worktree path, commit SHA, or deploy id" },
        },
        required: ["ticket", "kind", "name", "value"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        append(
          input.ticket,
          {
            kind: "artifact",
            artifactKind: input.kind,
            name: String(input.name ?? ""),
            value: String(input.value ?? ""),
          },
          context,
        )
        return {
          content: `Recorded ${input.kind} ${input.value} on ${input.ticket}`,
          metadata: { ticketID: input.ticket },
        }
      },
    },
    {
      name: "ticket_question",
      description: [
        "Record the single open question a ticket is waiting on, or clear it with null once answered.",
        "The board shows it first, so keep it to one line.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          question: { type: ["string", "null"], description: "The open question, or null when answered" },
        },
        required: ["ticket", "question"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        const question = typeof input.question === "string" ? input.question : null
        append(input.ticket, { kind: "question", text: question }, context)
        return {
          content: question === null ? `Cleared question on ${input.ticket}` : `Question on ${input.ticket}`,
          metadata: { ticketID: input.ticket },
        }
      },
    },
    {
      name: "ticket_relation",
      description: [
        "Link two tickets: fork when this one was split off, supersedes when it replaces another,",
        "blocks when the other cannot finish until this one does.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          ticket: { type: "string", description: "Ticket id" },
          relation: { type: "string", enum: [...RELATIONS], description: "fork | supersedes | blocks" },
          target: { type: "string", description: "The other ticket id" },
        },
        required: ["ticket", "relation", "target"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        requireTicket(input.ticket)
        if (input.target === input.ticket) throw new Error("a ticket cannot relate to itself")
        requireTicket(input.target)
        append(input.ticket, { kind: "relation", relation: input.relation, ticketID: input.target }, context)
        return {
          content: `${input.ticket} ${input.relation} ${input.target}`,
          metadata: { ticketID: input.ticket },
        }
      },
    },
  ]
}

const trace = (context: ToolContext): Trace => ({
  sessionID: context.sessionID,
  messageID: context.messageID,
  agent: context.agent,
})

/** Tool names the plugin registers, exported so tests and docs cannot drift. */
export const TOOL_NAMES = [
  "ticket_create",
  "ticket_handover",
  "ticket_stage",
  "ticket_owner",
  "ticket_note",
  "ticket_artifact",
  "ticket_question",
  "ticket_relation",
] as const
