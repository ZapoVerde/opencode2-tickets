import { describe, expect, test } from "bun:test"
import { emptyBoard, readBoard } from "../src/board"
import { createLiveness } from "../src/liveness"
import { openStore } from "../src/store"

const traceOf = (messageID: string, agent = "build") => ({
  sessionID: "ses_board",
  messageID,
  agent,
})

const offline = createLiveness({ timeoutMs: 200 })

/** A ticket created in one message, advanced and given artifacts in the same one. */
const seed = (store: ReturnType<typeof openStore>) => {
  const created = traceOf("msg_board")
  const ticket = store.create({
    title: "WhatsApp send retry",
    intent: "add retry with backoff to WhatsApp send",
    kind: "feature",
    done: ["a failed send is retried once", "the give-up path is unchanged"],
    directory: "/repo",
    repo: "/config/workspace/opencode2",
    owner: "build",
    trace: created,
  })
  store.append(ticket.id, { kind: "stage", stage: "building" }, created)
  store.append(ticket.id, { kind: "stage", stage: "ready-to-deploy" }, created)
  store.append(ticket.id, { kind: "artifact", artifactKind: "branch", name: "work", value: "tickets-phase-1" }, created)
  store.append(
    ticket.id,
    { kind: "artifact", artifactKind: "deploy", name: "production", value: "deploy-2026-11-02" },
    created,
  )
  return ticket
}

describe("readBoard", () => {
  test("renders waiting work first and keeps every row's stage and intent", () => {
    const store = openStore(":memory:")
    const ticket = seed(store)
    const response = readBoard(store, Date.now(), offline)
    expect(response.counts).toEqual({ needsYou: 1, working: 0, closed: 0, stale: 0, total: 1 })
    expect(response.needsYou[0]).toMatchObject({
      id: ticket.id,
      title: "WhatsApp send retry",
      intent: "add retry with backoff to WhatsApp send",
      kind: "feature",
      done: ["a failed send is retried once", "the give-up path is unchanged"],
      stage: "ready-to-deploy",
      owner: "build",
      repo: "/config/workspace/opencode2",
    })
    expect(response.needsYou[0]!.artifacts.map((artifact) => artifact.kind)).toEqual(["branch", "deploy"])
  })

  test("points every message at itself once, however many writes came from it", () => {
    const store = openStore(":memory:")
    seed(store)
    const row = readBoard(store, Date.now(), offline).needsYou[0]!
    // Five writes from one message are one link, not five: the other messages
    // are what the reader needs to see.
    expect(row.traces).toHaveLength(1)
    expect(row.traces[0]).toMatchObject({ sessionID: "ses_board", messageID: "msg_board", agent: "build" })
    expect(row.traces[0]!.kind).toBe("created, stage, stage, artifact, artifact")
  })

  test("a trace entry carries prose only for notes and handovers", () => {
    const store = openStore(":memory:")
    const ticket = seed(store)
    store.append(ticket.id, { kind: "note", text: "provider dedupes by request id" }, traceOf("msg_note"))
    store.append(
      ticket.id,
      { kind: "handover", stage: "ready-to-deploy", note: "needs a phone check", owner: "plan" },
      traceOf("msg_handover", "plan"),
    )
    const row = readBoard(store, Date.now(), offline).needsYou[0]!
    expect(row.traces.map((item) => [item.messageID, item.text])).toEqual([
      ["msg_board", null],
      ["msg_note", "provider dedupes by request id"],
      ["msg_handover", "needs a phone check"],
    ])
  })

  test("artifact liveness is read at board time, not stored", () => {
    const store = openStore(":memory:")
    const ticket = store.create({
      title: "t",
      intent: "i",
      directory: "/nonexistent-repo-path",
      repo: null,
      owner: null,
      trace: traceOf("msg_x"),
    })
    store.append(ticket.id, { kind: "artifact", artifactKind: "branch", name: "b", value: "dev" }, traceOf("msg_x"))
    const row = readBoard(store, Date.now(), offline).working[0]!
    expect(row.artifacts[0]).toMatchObject({ kind: "branch", value: "dev", state: "unknown" })
  })

  test("relations resolve to the other ticket's title so the board reads as prose", () => {
    const store = openStore(":memory:")
    const blocker = store.create({
      title: "Migration",
      intent: "run the migration",
      directory: "/repo",
      repo: null,
      owner: null,
      trace: traceOf("msg_m"),
    })
    store.append(blocker.id, { kind: "stage", stage: "building" }, traceOf("msg_m"))
    const blocked = store.create({
      title: "Retry",
      intent: "add retry",
      directory: "/repo",
      repo: null,
      owner: null,
      trace: traceOf("msg_r"),
    })
    store.append(blocker.id, { kind: "relation", relation: "blocks", ticketID: blocked.id }, traceOf("msg_m"))
    const response = readBoard(store, Date.now(), offline)
    expect(response.needsYou[0]).toMatchObject({ title: "Retry", blocked: true, blockers: ["Migration"] })
  })

  test("an empty sidecar is a well-formed empty board", () => {
    const store = openStore(":memory:")
    expect(readBoard(store, Date.now(), offline)).toEqual(emptyBoard(readBoard(store, Date.now(), offline).generatedAt))
    expect(readBoard(store, Date.now(), offline).counts).toMatchObject({ total: 0 })
  })
})
