import { describe, expect, test } from "bun:test"
import {
  STAGES,
  type TicketEvent,
  board,
  canTransition,
  derive,
  isTerminal,
  plan,
  singleLine,
} from "../src/ticket"

let seq = 0

const event = (fields: Partial<TicketEvent> = {}): TicketEvent => ({
  id: `tev_${++seq}`,
  ticketID: "tick_1",
  seq,
  kind: "note",
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
  createdAt: 1_000,
  ...fields,
})

const index = (events: readonly TicketEvent[]) => events.map((item, order) => ({ ...item, seq: order }))

const empty = derive([])

describe("stage set", () => {
  test("is closed and includes the two terminal stages", () => {
    expect([...STAGES]).toEqual([
      "planned",
      "building",
      "ready-to-deploy",
      "deployed",
      "held",
      "abandoned",
      "superseded",
    ])
    expect(STAGES.filter(isTerminal)).toEqual(["abandoned", "superseded"])
  })

  test("deployed is not terminal: shipped work can still be superseded", () => {
    expect(isTerminal("deployed")).toBe(false)
    expect(canTransition("deployed", "superseded")).toBe(true)
    expect(canTransition("deployed", "building")).toBe(false)
  })

  test("terminal stages never move again", () => {
    for (const stage of STAGES) {
      expect(canTransition("abandoned", stage)).toBe(false)
      expect(canTransition("superseded", stage)).toBe(false)
    }
  })

  test("held is a stage, not a new ticket: it can return to any live stage", () => {
    expect(canTransition("held", "building")).toBe(true)
    expect(canTransition("held", "ready-to-deploy")).toBe(true)
    expect(canTransition("held", "planned")).toBe(true)
  })

  test("a ticket cannot go straight from planned to deployed without being ready", () => {
    expect(canTransition("planned", "deployed")).toBe(false)
  })
})

describe("derive", () => {
  test("an empty log is still planned and ownerless", () => {
    expect(empty.stage).toBe("planned")
    expect(empty.owner).toBeNull()
    expect(empty.question).toBeNull()
    expect(empty.artifacts).toEqual([])
  })

  test("the newest stage event wins regardless of insertion order", () => {
    const events = index([
      event({ kind: "created", stage: "planned" }),
      event({ kind: "stage", stage: "building" }),
      event({ kind: "stage", stage: "ready-to-deploy" }),
    ])
    expect(derive([...events].reverse()).stage).toBe("ready-to-deploy")
  })

  test("owner follows the newest owner or handover, and creation seeds it", () => {
    const events = index([
      event({ kind: "created", stage: "planned", owner: "build" }),
      event({ kind: "owner", owner: "plan" }),
      event({ kind: "handover", stage: "building", owner: "build", text: "take it" }),
    ])
    expect(derive(events).owner).toBe("build")
    expect(derive(index([event({ kind: "created", stage: "planned", owner: "build" })])).owner).toBe("build")
    expect(derive(events.slice(0, 2)).owner).toBe("plan")
  })

  test("a note does not clear the owner", () => {
    const events = index([
      event({ kind: "owner", owner: "build" }),
      event({ kind: "note", text: "a caveat", owner: null }),
    ])
    expect(derive(events).owner).toBe("build")
  })

  test("an empty question event clears the open question", () => {
    const events = index([
      event({ kind: "question", text: "ship on Friday?" }),
      event({ kind: "question", text: null }),
    ])
    expect(derive(events).question).toBeNull()
  })

  test("artifacts accumulate and keep their original timestamp", () => {
    const events = index([
      event({ kind: "artifact", artifactKind: "branch", artifactName: "feature", artifactValue: "tickets-phase-1", createdAt: 10 }),
      event({ kind: "artifact", artifactKind: "commit", artifactName: "fix", artifactValue: "abc1234", createdAt: 20 }),
    ])
    expect(derive(events).artifacts).toEqual([
      { kind: "branch", name: "feature", value: "tickets-phase-1", at: 10, eventID: events[0]!.id },
      { kind: "commit", name: "fix", value: "abc1234", at: 20, eventID: events[1]!.id },
    ])
  })

  test("a partial artifact event is skipped rather than producing a half record", () => {
    const events = index([event({ kind: "artifact", artifactKind: "branch", artifactName: "x", artifactValue: null })])
    expect(derive(events).artifacts).toEqual([])
  })
})

describe("plan", () => {
  const building = derive(index([event({ kind: "created", stage: "planned" }), event({ kind: "stage", stage: "building" })]))

  test("stage accepts a legal move and carries no prose", () => {
    const decision = plan(building, { kind: "stage", stage: "ready-to-deploy" })
    expect(decision.ok && decision.event).toMatchObject({ kind: "stage", stage: "ready-to-deploy", text: null })
  })

  test("stage rejects the stage it is already in", () => {
    expect(plan(building, { kind: "stage", stage: "building" })).toEqual({
      ok: false,
      reason: "ticket is already building",
    })
  })

  test("stage rejects a skip the transition table does not allow", () => {
    const planned = derive(index([event({ kind: "created", stage: "planned" })]))
    expect(plan(planned, { kind: "stage", stage: "deployed" })).toEqual({
      ok: false,
      reason: "cannot move from planned to deployed",
    })
  })

  test("a handover to the current stage passes the baton without a transition", () => {
    const decision = plan(building, {
      kind: "handover",
      stage: "building",
      note: " the retry loop is untested on mobile ",
      owner: "plan",
    })
    expect(decision).toEqual({
      ok: true,
      event: {
        kind: "handover",
        stage: "building",
        text: "the retry loop is untested on mobile",
        owner: "plan",
        artifactKind: null,
        artifactName: null,
        artifactValue: null,
        relation: null,
        relatedTicketID: null,
        sessionID: null,
        messageID: null,
        agent: null,
      },
    })
  })

  test("a handover needs a note, and folds multi-line prose to one line", () => {
    expect(plan(building, { kind: "handover", stage: "building", note: "  ", owner: null })).toEqual({
      ok: false,
      reason: "handover needs a one-line note",
    })
    const decision = plan(building, { kind: "handover", stage: "building", note: "a\nb\tc", owner: null })
    expect(decision.ok && decision.event.text).toBe("a b c")
  })

  test("a handover cannot also skip stages", () => {
    const planned = derive(index([event({ kind: "created", stage: "planned" })]))
    expect(plan(planned, { kind: "handover", stage: "deployed", note: "shipped", owner: null }).ok).toBe(false)
  })

  test("artifact values must be a single immutable token", () => {
    expect(plan(building, { kind: "artifact", artifactKind: "commit", name: "c", value: "abc 123" })).toEqual({
      ok: false,
      reason: "artifact value must be a single token: a SHA or a path",
    })
    expect(plan(building, { kind: "artifact", artifactKind: "commit", name: "c", value: " " }).ok).toBe(false)
    expect(plan(building, { kind: "artifact", artifactKind: "commit", name: "", value: "abc" }).ok).toBe(false)
  })

  test("an artifact name is required but may contain spaces", () => {
    const decision = plan(building, {
      kind: "artifact",
      artifactKind: "deploy",
      name: "production deploy",
      value: "deploy-2026-11-02",
    })
    expect(decision.ok && decision.event.artifactName).toBe("production deploy")
  })

  test("an unknown artifact kind is refused before it can reach disk", () => {
    // The tool schema also restricts this; the pure module is the second gate.
    const decision = plan(building, {
      kind: "artifact",
      artifactKind: "tarball" as never,
      name: "x",
      value: "y",
    })
    expect(decision).toEqual({ ok: false, reason: "unknown artifact kind tarball" })
  })

  test("notes and questions fold to one line and reject emptiness", () => {
    expect(plan(building, { kind: "note", text: "  a\n\nb  " })).toEqual({
      ok: true,
      event: expect.objectContaining({ kind: "note", text: "a b" }),
    })
    expect(plan(building, { kind: "note", text: "\n" }).ok).toBe(false)
    expect(plan(building, { kind: "question", text: "ship today?\nreally?" })).toEqual({
      ok: true,
      event: expect.objectContaining({ kind: "question", text: "ship today? really?" }),
    })
  })

  test("a relation needs a target and records its direction from the authored ticket", () => {
    expect(plan(building, { kind: "relation", relation: "blocks", ticketID: "" }).ok).toBe(false)
    expect(plan(building, { kind: "relation", relation: "blocks", ticketID: "tick_2" })).toEqual({
      ok: true,
      event: expect.objectContaining({ kind: "relation", relation: "blocks", relatedTicketID: "tick_2" }),
    })
  })

  test("owner normalizes blank strings to a cleared owner", () => {
    expect(plan(building, { kind: "owner", owner: "  " })).toEqual({
      ok: true,
      event: expect.objectContaining({ kind: "owner", owner: null }),
    })
  })
})

describe("singleLine", () => {
  test("collapses whitespace so a list row stays one row", () => {
    expect(singleLine("  add   WhatsApp\n send  retry ")).toBe("add WhatsApp send retry")
  })
})

const ticket = (id: string, title = id) => ({ id, title, intent: `${title} intent`, directory: "/repo", repo: null, createdAt: 0 })

describe("board", () => {
  const NOW = 1_000_000_000_000

  test("groups waiting, moving, and settled work, and only waiting work takes attention", () => {
    const entries = [
      {
        ticket: ticket("tick_wait"),
        events: index([event({ ticketID: "tick_wait", kind: "created", stage: "planned" }), event({ ticketID: "tick_wait", kind: "stage", stage: "ready-to-deploy" })]),
      },
      {
        ticket: ticket("tick_move"),
        events: index([event({ ticketID: "tick_move", kind: "created", stage: "planned", createdAt: NOW }), event({ ticketID: "tick_move", kind: "stage", stage: "building", createdAt: NOW })]),
      },
      {
        ticket: ticket("tick_done"),
        events: index([event({ ticketID: "tick_done", kind: "created", stage: "planned", createdAt: NOW }), event({ ticketID: "tick_done", kind: "stage", stage: "deployed", createdAt: NOW })]),
      },
    ]
    const result = board(entries, NOW)
    expect(result.needsYou.map((row) => row.ticket.id)).toEqual(["tick_wait"])
    expect(result.working.map((row) => row.ticket.id)).toEqual(["tick_move"])
    expect(result.closed.map((row) => row.ticket.id)).toEqual(["tick_done"])
    expect(result.counts).toEqual({ needsYou: 1, working: 1, closed: 1, stale: 0 })
    expect(result.working[0]!.waiting).toBe(false)
    expect(result.needsYou[0]!.waiting).toBe(true)
  })

  test("ready-to-deploy outranks blocked, and held outranks nothing", () => {
    const entries = [
      {
        ticket: ticket("tick_blocked"),
        events: index([event({ ticketID: "tick_blocked", kind: "created", stage: "planned", createdAt: NOW })]),
      },
      {
        ticket: ticket("tick_blocker"),
        events: index([
          event({ ticketID: "tick_blocker", kind: "created", stage: "planned", createdAt: NOW }),
          event({ ticketID: "tick_blocker", kind: "relation", relation: "blocks", relatedTicketID: "tick_blocked", createdAt: NOW }),
        ]),
      },
      {
        ticket: ticket("tick_ready"),
        events: index([
          event({ ticketID: "tick_ready", kind: "created", stage: "planned", createdAt: NOW }),
          event({ ticketID: "tick_ready", kind: "stage", stage: "ready-to-deploy", createdAt: NOW }),
        ]),
      },
      {
        ticket: ticket("tick_held"),
        events: index([
          event({ ticketID: "tick_held", kind: "created", stage: "planned", createdAt: NOW }),
          event({ ticketID: "tick_held", kind: "stage", stage: "held", createdAt: NOW }),
        ]),
      },
    ]
    const result = board(entries, NOW)
    expect(result.needsYou.map((row) => [row.ticket.id, row.blocked])).toEqual([
      ["tick_ready", false],
      ["tick_held", false],
      ["tick_blocked", true],
    ])
    expect(result.needsYou.find((row) => row.ticket.id === "tick_blocked")!.blockers).toEqual(["tick_blocker"])
  })

  test("a blocker that is already deployed or terminal stops blocking", () => {
    const entries = [
      {
        ticket: ticket("tick_blocked"),
        events: index([event({ ticketID: "tick_blocked", kind: "created", stage: "planned", createdAt: NOW })]),
      },
      {
        ticket: ticket("tick_done"),
        events: index([
          event({ ticketID: "tick_done", kind: "created", stage: "planned", createdAt: NOW }),
          event({ ticketID: "tick_done", kind: "relation", relation: "blocks", relatedTicketID: "tick_blocked", createdAt: NOW }),
          event({ ticketID: "tick_done", kind: "stage", stage: "deployed", createdAt: NOW }),
        ]),
      },
    ]
    expect(board(entries, NOW).needsYou).toEqual([])
  })

  test("stale is derived at read time and never rewrites the stage", () => {
    const startedAt = NOW - 30 * 24 * 60 * 60 * 1000
    const entries = [
      {
        ticket: ticket("tick_old"),
        events: index([
          event({ ticketID: "tick_old", kind: "created", stage: "planned", createdAt: startedAt }),
          event({ ticketID: "tick_old", kind: "stage", stage: "building", createdAt: startedAt }),
        ]),
      },
    ]
    const result = board(entries, NOW)
    expect(result.working[0]!.stale).toBe(true)
    expect(result.working[0]!.state.stage).toBe("building")
    expect(result.counts.stale).toBe(1)
    expect(board(entries, startedAt + 60_000).working[0]!.stale).toBe(false)
  })

  test("stale only applies to live stages, not to work waiting on a person", () => {
    const old = NOW - 30 * 24 * 60 * 60 * 1000
    const entries = [
      {
        ticket: ticket("tick_wait"),
        events: index([
          event({ ticketID: "tick_wait", kind: "created", stage: "planned", createdAt: old }),
          event({ ticketID: "tick_wait", kind: "stage", stage: "ready-to-deploy", createdAt: old }),
        ]),
      },
    ]
    expect(board(entries, NOW).needsYou[0]!.stale).toBe(false)
  })
})
