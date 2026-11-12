import { describe, expect, test } from "bun:test"
import { type Enforce, type GateSession, gate, isEnforce } from "../src/gate"
import { openStore } from "../src/store"

const REPO = "/repo"
const OTHER = "/other"

const session = (id: string, agent = "build", parentID?: string): GateSession => ({ id, agent, parentID })

const setup = (sessionID = "ses_build") => {
  const store = openStore(":memory:")
  const trace = (id = sessionID) => ({ sessionID: id, messageID: `msg_${id}`, agent: "build" })
  const tickets = () =>
    store.board().map(({ ticket, events }) => ({
      id: ticket.id,
      repo: ticket.repo,
      directory: ticket.directory,
      events,
    }))
  const open = (repo = REPO) => {
    const ticket = store.create({
      title: "Reader controls",
      intent: "the font buttons change size",
      kind: "ui",
      done: ["each control moves before ready-to-deploy"],
      directory: repo,
      repo,
      owner: "build",
      trace: trace(),
    })
    store.append(ticket.id, { kind: "stage", stage: "building" }, trace())
    return ticket.id
  }
  const decide = (input: {
    enforce?: Enforce
    action?: string
    chain?: readonly GateSession[]
    repo?: string | null
    agent?: string
  } = {}) =>
    gate({
      enforce: input.enforce ?? "build",
      action: input.action ?? "edit",
      agent: input.agent ?? "build",
      repo: input.repo === undefined ? REPO : input.repo,
      directory: REPO,
      chain: input.chain ?? [session(sessionID)],
      tickets: tickets(),
    })
  return { store, open, decide, trace, tickets }
}

describe("enforce mode", () => {
  test("off allows a write with no ticket at all", () => {
    expect(setup().decide({ enforce: "off" })).toEqual({ allow: true })
  })

  test("only off, build, and all are accepted config values", () => {
    expect(isEnforce("build")).toBe(true)
    expect(isEnforce("everyone")).toBe(false)
    expect(isEnforce(undefined)).toBe(false)
  })

  test("all gates a session that is not under build", () => {
    const { decide } = setup()
    expect(decide({ enforce: "all", agent: "explore", chain: [session("ses_x", "explore")] }).allow).toBe(false)
  })
})

describe("which actions are gated", () => {
  test("an edit with no ticket is denied and the reason names the recovery", () => {
    const decision = setup().decide()
    expect(decision.allow).toBe(false)
    if (decision.allow) return
    expect(decision.reason).toContain("ticket_create")
    expect(decision.reason).toContain("ticket_stage")
    expect(decision.reason).toContain("Reads are unaffected")
  })

  test("reads and shell commands are never gated", () => {
    const { decide } = setup()
    expect(decide({ action: "read" })).toEqual({ allow: true })
    expect(decide({ action: "shell" })).toEqual({ allow: true })
  })
})

describe("build mode", () => {
  test("a non-build session is left alone", () => {
    const { decide } = setup()
    expect(decide({ agent: "plan", chain: [session("ses_plan", "plan")] })).toEqual({ allow: true })
  })

  test("a subagent inherits build from its parent session", () => {
    const { decide } = setup()
    const chain = [session("ses_child", "general", "ses_build"), session("ses_build")]
    expect(decide({ agent: "general", chain }).allow).toBe(false)
  })
})

describe("what authorizes a write", () => {
  test("a building ticket written from this session authorizes it", () => {
    const { open, decide } = setup()
    open()
    expect(decide()).toEqual({ allow: true })
  })

  test("a parent's building ticket authorizes the child session", () => {
    const { open, decide } = setup()
    open()
    const chain = [session("ses_child", "general", "ses_build"), session("ses_build")]
    expect(decide({ agent: "general", chain })).toEqual({ allow: true })
  })

  test("a sibling session cannot spend another session's ticket", () => {
    const { open, decide } = setup()
    open()
    expect(decide({ chain: [session("ses_other")] }).allow).toBe(false)
  })

  test("a ticket that is still planned does not authorize", () => {
    const { store, decide, trace } = setup()
    store.create({
      title: "Not started",
      intent: "nothing yet",
      directory: REPO,
      repo: REPO,
      owner: null,
      trace: trace(),
    })
    expect(decide().allow).toBe(false)
  })

  test("a deployed ticket does not authorize the next pass", () => {
    const { store, open, decide, trace } = setup()
    const id = open()
    store.append(id, { kind: "stage", stage: "ready-to-deploy" }, trace())
    store.append(id, { kind: "stage", stage: "deployed" }, trace())
    expect(decide().allow).toBe(false)
  })

  test("a ticket for another repository does not authorize", () => {
    const { open, decide } = setup()
    open(OTHER)
    expect(decide().allow).toBe(false)
  })
})
