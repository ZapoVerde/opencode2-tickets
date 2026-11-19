import { describe, expect, test } from "bun:test"
import { openStore } from "../src/store"
import { TOOL_NAMES, type ToolContext, tools } from "../src/tools"
import { derive } from "../src/ticket"

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  sessionID: "ses_ticket",
  messageID: "msg_discussed",
  agent: "build",
  ...overrides,
})

const setup = () => {
  const store = openStore(":memory:")
  const registry = new Map(tools({ store, directory: "/repo", repo: "/repo" }).map((tool) => [tool.name, tool]))
  const call = async (name: string, input: unknown, ctx = context()) => {
    const tool = registry.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    return tool.execute(input, ctx)
  }
  return { store, registry, call }
}

/** The tool reports the new id in its text, which is what the model and UI read. */
const idFrom = (content: string) => /tick_[a-z0-9]+/.exec(content)?.[0] ?? ""

const create = async (call: Awaited<ReturnType<typeof setup>>["call"]) => {
  const result = await call("ticket_create", {
    title: "WhatsApp send retry",
    intent: "add retry with backoff to WhatsApp send",
  })
  return idFrom(result.content)
}

describe("tool surface", () => {
  test("registers the write tools and nothing else", () => {
    const { registry } = setup()
    expect([...registry.keys()]).toEqual([...TOOL_NAMES])
  })

  test("every tool carries a JSON schema the host can validate", () => {
    const { registry } = setup()
    for (const tool of registry.values()) {
      expect(tool.input).toMatchObject({ type: "object" })
      expect(tool.options).toEqual({ codemode: false })
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })
})

describe("ticket_create", () => {
  test("records the call's session, message, and agent as the trace", async () => {
    const { store, call } = setup()
    const id = await create(call)
    expect(store.events(id)[0]).toMatchObject({
      kind: "created",
      stage: "planned",
      sessionID: "ses_ticket",
      messageID: "msg_discussed",
      agent: "build",
    })
  })

  test("folds whitespace so the list stays scannable", async () => {
    const { store, call } = setup()
    const result = await call("ticket_create", {
      title: "  WhatsApp\n send retry ",
      intent: "  add   retry with backoff ",
    })
    const ticket = store.get(idFrom(result.content))!
    expect(ticket.title).toBe("WhatsApp send retry")
    expect(ticket.intent).toBe("add retry with backoff")
  })

  test("accepts an explicit repo for a worktree checkout", async () => {
    const { store, call } = setup()
    const result = await call("ticket_create", {
      title: "t",
      intent: "i",
      repo: "/projects/example",
    })
    expect(store.get(idFrom(result.content))!.repo).toBe("/projects/example")
  })

  test("refuses an empty title or intent", async () => {
    const { call } = setup()
    await expect(call("ticket_create", { title: "  ", intent: "i" })).rejects.toThrow("title is empty")
    await expect(call("ticket_create", { title: "t", intent: "\n" })).rejects.toThrow("intent is empty")
  })

  test("records the kind and folds the done lines into a checklist", async () => {
    const { store, call } = setup()
    const result = await call("ticket_create", {
      title: "Reader controls",
      intent: "each control does something",
      kind: "ui",
      done: ["  every shipped control was tapped  ", "", "every shipped control was tapped", "font size changes"],
    })
    const ticket = store.get(idFrom(result.content))!
    expect(ticket.kind).toBe("ui")
    expect(ticket.done).toEqual(["every shipped control was tapped", "font size changes"])
  })

  test("an unknown kind falls back to feature and no done lines is legal", async () => {
    const { store, call } = setup()
    const result = await call("ticket_create", { title: "t", intent: "i", kind: "epic" })
    expect(store.get(idFrom(result.content))).toMatchObject({ kind: "feature", done: [] })
  })

  test("caps the checklist so a definition of done cannot become a backlog", async () => {
    const { store, call } = setup()
    const result = await call("ticket_create", {
      title: "t",
      intent: "i",
      done: ["a", "b", "c", "d", "e", "f", "g"],
    })
    expect(store.get(idFrom(result.content))!.done).toEqual(["a", "b", "c", "d", "e", "f"])
  })
})

describe("stage transitions", () => {
  const advance = async () => {
    const scoped = setup()
    const id = await create(scoped.call)
    return { ...scoped, id }
  }

  test("walks planned → building → ready-to-deploy and reports the move", async () => {
    const { store, call, id } = await advance()
    const first = await call("ticket_stage", { ticket: id, stage: "building" })
    expect(first.content).toBe(`${id}: planned → building`)
    const second = await call("ticket_stage", { ticket: id, stage: "ready-to-deploy" })
    expect(second.content).toBe(
      `${id}: building → ready-to-deploy · no done lines recorded, so the reviewer has only the intent`,
    )
    expect(derive(store.events(id)).stage).toBe("ready-to-deploy")
  })

  test("refuses a skip the transition table forbids and records nothing", async () => {
    const { store, call, id } = await advance()
    await expect(call("ticket_stage", { ticket: id, stage: "deployed" })).rejects.toThrow(
      "cannot move from planned to deployed",
    )
    expect(store.events(id)).toHaveLength(1)
  })

  test("refuses a no-op move to the current stage", async () => {
    const { call, id } = await advance()
    await expect(call("ticket_stage", { ticket: id, stage: "planned" })).rejects.toThrow(
      "ticket is already planned",
    )
  })

  test("held is a stage that can return to building", async () => {
    const { store, call, id } = await advance()
    await call("ticket_stage", { ticket: id, stage: "held" })
    await call("ticket_stage", { ticket: id, stage: "building" })
    expect(derive(store.events(id)).stage).toBe("building")
  })

  test("abandoned is terminal", async () => {
    const { call, id } = await advance()
    await call("ticket_stage", { ticket: id, stage: "abandoned" })
    await expect(call("ticket_stage", { ticket: id, stage: "building" })).rejects.toThrow(
      "cannot move from abandoned to building",
    )
  })

  test("an unknown ticket is rejected before the stage table is consulted", async () => {
    const { call } = setup()
    await expect(call("ticket_stage", { ticket: "tick_nope", stage: "building" })).rejects.toThrow("unknown ticket")
  })
})

describe("handover", () => {
  const ready = async () => {
    const scoped = setup()
    const id = await create(scoped.call)
    await scoped.call("ticket_stage", { ticket: id, stage: "building" })
    return { ...scoped, id }
  }

  test("moves the stage, records the note, and sets the new owner", async () => {
    const { store, call, id } = await ready()
    const result = await call(
      "ticket_handover",
      { ticket: id, stage: "ready-to-deploy", note: "retry loop untested on mobile", owner: "plan" },
      context({ messageID: "msg_handover", agent: "build" }),
    )
    expect(result.content).toContain("Handed over")
    const state = derive(store.events(id))
    expect(state).toMatchObject({ stage: "ready-to-deploy", owner: "plan" })
    const event = store.events(id).at(-1)!
    expect(event).toMatchObject({
      kind: "handover",
      text: "retry loop untested on mobile",
      messageID: "msg_handover",
      sessionID: "ses_ticket",
    })
  })

  test("hands the baton at the current stage without a transition", async () => {
    const { store, call, id } = await ready()
    await call("ticket_handover", { ticket: id, stage: "building", note: "you take it", owner: "plan" })
    const state = derive(store.events(id))
    expect(state.stage).toBe("building")
    expect(state.owner).toBe("plan")
  })

  test("a handover cannot skip stages either", async () => {
    const { call } = setup()
    const id = await create(call)
    await expect(
      call("ticket_handover", { ticket: id, stage: "deployed", note: "shipped", owner: null }),
    ).rejects.toThrow("cannot move from planned to deployed")
  })

  test("a handover needs a non-empty note", async () => {
    const { call, id } = await ready()
    await expect(
      call("ticket_handover", { ticket: id, stage: "building", note: "   ", owner: null }),
    ).rejects.toThrow("handover needs a one-line note")
  })

  test("folds a multi-line note into the one line the board shows", async () => {
    const { store, call, id } = await ready()
    await call("ticket_handover", { ticket: id, stage: "building", note: "first\nsecond\tthird", owner: null })
    expect(derive(store.events(id)).owner).toBeNull()
    expect(store.events(id).at(-1)!.text).toBe("first second third")
  })
})

describe("owner, note, artifact, question, relation", () => {
  const ready = async () => {
    const scoped = setup()
    const id = await create(scoped.call)
    return { ...scoped, id }
  }

  test("owner sets and clears without touching the stage", async () => {
    const { store, call, id } = await ready()
    await call("ticket_owner", { ticket: id, owner: "plan" })
    expect(derive(store.events(id)).owner).toBe("plan")
    await call("ticket_owner", { ticket: id, owner: null })
    expect(derive(store.events(id)).owner).toBeNull()
    expect(derive(store.events(id)).stage).toBe("planned")
  })

  test("a note is appended as prose and does not change stage or owner", async () => {
    const { store, call, id } = await ready()
    await call("ticket_owner", { ticket: id, owner: "build" })
    await call("ticket_note", { ticket: id, note: "the provider dedupes by request id" })
    const state = derive(store.events(id))
    expect(state.owner).toBe("build")
    expect(state.stage).toBe("planned")
    expect(store.events(id).at(-1)).toMatchObject({ kind: "note", text: "the provider dedupes by request id" })
  })

  test("artifacts are appended and the value is never overwritten", async () => {
    const { store, call, id } = await ready()
    await call("ticket_artifact", { ticket: id, kind: "branch", name: "work", value: "tickets-phase-1" })
    await call("ticket_artifact", { ticket: id, kind: "commit", name: "fix", value: "3bc815b" })
    await call("ticket_artifact", { ticket: id, kind: "deploy", name: "production", value: "deploy-2026-11-02" })
    expect(derive(store.events(id)).artifacts.map((artifact) => [artifact.kind, artifact.value])).toEqual([
      ["branch", "tickets-phase-1"],
      ["commit", "3bc815b"],
      ["deploy", "deploy-2026-11-02"],
    ])
  })

  test("an artifact value with whitespace is refused: it is a SHA or a path, not prose", async () => {
    const { call, id } = await ready()
    await expect(
      call("ticket_artifact", { ticket: id, kind: "commit", name: "c", value: "head of dev" }),
    ).rejects.toThrow("artifact value must be a single token")
  })

  test("a question is set and cleared, and clearing is idempotent", async () => {
    const { store, call, id } = await ready()
    await call("ticket_question", { ticket: id, question: "ship before the migration?" })
    expect(derive(store.events(id)).question).toBe("ship before the migration?")
    await call("ticket_question", { ticket: id, question: null })
    await call("ticket_question", { ticket: id, question: null })
    expect(derive(store.events(id)).question).toBeNull()
  })

  test("relations record direction from the authored ticket and reject unknown targets", async () => {
    const { store, call, id } = await ready()
    const other = idFrom((await call("ticket_create", { title: "other", intent: "other intent" })).content)
    await call("ticket_relation", { ticket: id, relation: "blocks", target: other })
    expect(derive(store.events(id)).relations).toEqual([
      { relation: "blocks", ticketID: other, at: expect.any(Number) },
    ])
    await expect(
      call("ticket_relation", { ticket: id, relation: "fork", target: "tick_nope" }),
    ).rejects.toThrow("unknown ticket tick_nope")
    await expect(call("ticket_relation", { ticket: id, relation: "fork", target: id })).rejects.toThrow(
      "a ticket cannot relate to itself",
    )
  })
})

describe("done-when walkthrough", () => {
  test("create, hand over, ready-to-deploy, attach a branch and a deploy, all traced", async () => {
    const { store, call } = setup()
    const id = await create(call)
    await call("ticket_stage", { ticket: id, stage: "building" }, context({ messageID: "msg_build" }))
    await call("ticket_artifact", { ticket: id, kind: "branch", name: "work", value: "tickets-phase-1" })
    await call(
      "ticket_handover",
      { ticket: id, stage: "ready-to-deploy", note: "needs a phone check before merge", owner: "build" },
      context({ messageID: "msg_handover" }),
    )
    await call("ticket_artifact", { ticket: id, kind: "deploy", name: "production", value: "deploy-2026-11-02" })

    const state = derive(store.events(id))
    expect(state.stage).toBe("ready-to-deploy")
    expect(state.owner).toBe("build")
    expect(state.artifacts.map((artifact) => artifact.kind)).toEqual(["branch", "deploy"])
    // Every trace entry points at a message; none restates the work.
    expect(store.events(id).filter((event) => event.messageID !== null).map((event) => event.messageID)).toEqual([
      "msg_discussed",
      "msg_build",
      "msg_discussed",
      "msg_handover",
      "msg_discussed",
    ])
  })

  test("a deploy that is found wanting becomes a new linked ticket, not a reopened one", async () => {
    const { store, call } = setup()
    const first = await create(call)
    for (const stage of ["building", "ready-to-deploy", "deployed"]) {
      await call("ticket_stage", { ticket: first, stage })
    }
    await call("ticket_artifact", { ticket: first, kind: "deploy", name: "production", value: "deploy-1" })

    // The deployed ticket is closed to further work; that is the whole point.
    await expect(call("ticket_stage", { ticket: first, stage: "building" })).rejects.toThrow(
      "cannot move from deployed to building",
    )

    // The check found a new intent, so it gets its own ticket and its own remit.
    const followUp = idFrom(
      (
        await call("ticket_create", {
          title: "Cap retries at five",
          intent: "stop retrying after five attempts",
        })
      ).content,
    )
    await call("ticket_relation", { ticket: followUp, relation: "fork", target: first })
    await call("ticket_artifact", { ticket: first, kind: "branch", name: "shipped", value: "main" })

    // The first ticket keeps its whole history, including the deploy that led here.
    expect(derive(store.events(first))).toMatchObject({ stage: "deployed" })
    expect(derive(store.events(first)).artifacts.map((artifact) => artifact.kind)).toEqual(["deploy", "branch"])
    // The new ticket starts clean at planned and points back at what prompted it.
    expect(derive(store.events(followUp))).toMatchObject({ stage: "planned" })
    expect(derive(store.events(followUp)).relations).toEqual([
      { relation: "fork", ticketID: first, at: expect.any(Number) },
    ])
  })

  test("a replaced ticket is superseded, which is the only move left after deploy", async () => {
    const { store, call } = setup()
    const first = await create(call)
    for (const stage of ["building", "ready-to-deploy", "deployed"]) {
      await call("ticket_stage", { ticket: first, stage })
    }
    const replacement = idFrom(
      (await call("ticket_create", { title: "Send retry v2", intent: "retry with jitter" })).content,
    )
    await call("ticket_relation", { ticket: first, relation: "supersedes", target: replacement })
    await call("ticket_stage", { ticket: first, stage: "superseded" })
    expect(derive(store.events(first)).stage).toBe("superseded")
    await expect(call("ticket_stage", { ticket: first, stage: "building" })).rejects.toThrow(
      "cannot move from superseded to building",
    )
  })
})
