// Read-only board. The page renders whatever `/api/board` derives; it never
// writes, and it never invents a stage or a status the sidecar did not record.

const GROUPS = ["needsYou", "working", "closed"]

const state = { board: null }

const base64Url = (value) => {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

/**
 * A trace entry opens the exact message it points at. The app reads
 * `#message-<id>`, so the link needs only the server key and session id in the
 * path; the board is served from the same origin as the app.
 */
const messageHref = (trace) => {
  if (!trace.sessionID) return null
  const origin = location.origin
  const path = `/server/${base64Url(origin)}/session/${trace.sessionID}`
  return trace.messageID ? `${path}#message-${trace.messageID}` : path
}

const relative = (at) => {
  const delta = Date.now() - at
  if (delta < 60_000) return "just now"
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toISOString().slice(0, 10)
}

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const renderArtifacts = (row) => {
  if (row.artifacts.length === 0) return null
  const list = el("ul", "artifacts")
  list.append(el("li", "section-label", "Where the work is"))
  for (const artifact of row.artifacts) {
    const item = el("li")
    const value = el("code", null, artifact.value)
    item.append(`${artifact.kind} `, value, ` · ${artifact.name}`)
    if (artifact.state !== "unknown" && artifact.state !== "present") {
      item.append(` · ${artifact.state}`)
    } else if (artifact.detail) {
      item.append(` · ${artifact.detail}`)
    }
    list.append(item)
  }
  return list
}

const renderTraces = (row) => {
  if (row.traces.length === 0) return null
  const list = el("ul", "traces")
  list.append(el("li", "section-label", "Where it happened"))
  for (const trace of row.traces) {
    const item = el("li", "trace")
    const href = messageHref(trace)
    if (href) {
      const link = el("a", null, trace.messageID ?? trace.sessionID)
      link.href = href
      item.append(link)
    } else {
      item.append(el("span", null, "no trace"))
    }
    if (trace.text) item.append(el("span", "trace-text", trace.text))
    if (trace.agent) item.append(el("span", "trace-meta", trace.agent))
    item.append(el("span", "trace-meta", relative(trace.at)))
    list.append(item)
  }
  return list
}

const renderRelations = (row) => {
  if (row.relations.length === 0) return null
  const list = el("ul", "relations")
  list.append(el("li", "section-label", "Related"))
  for (const relation of row.relations) {
    list.append(el("li", null, `${relation.relation} ${relation.ticketID}`))
  }
  return list
}

const renderCard = (row) => {
  const attention = row.stage === "ready-to-deploy" || row.stage === "held" || row.blocked
  const card = el("article", "card")
  card.dataset.attention = String(attention)

  const head = el("div", "card-head")
  head.append(el("h3", "card-title", row.title))
  const stage = el("span", "stage", row.stage)
  stage.dataset.stage = row.stage
  head.append(stage)
  card.append(head)

  card.append(el("p", "intent", row.intent))

  if (row.question) {
    const question = el("p", "question", row.question)
    card.append(question)
  }

  const flags = []
  if (row.stale) flags.push(["warn", "stale: no activity for a week"])
  if (row.owner) flags.push([null, `owner ${row.owner}`])
  if (row.blocked) flags.push(["bad", `blocked by ${row.blockers.join(", ")}`])
  if (flags.length > 0) {
    const strip = el("div", "flags")
    for (const [tone, label] of flags) {
      const flag = el("span", "flag", label)
      if (tone) flag.dataset.tone = tone
      strip.append(flag)
    }
    card.append(strip)
  }

  const meta = el("p", "meta")
  meta.append(el("code", null, row.repo ?? row.directory))
  meta.append(el("span", "meta-date", relative(row.lastEventAt)))
  card.append(meta)

  for (const section of [renderArtifacts(row), renderRelations(row), renderTraces(row)]) {
    if (section) card.append(section)
  }

  return card
}

const render = () => {
  const board = state.board
  const summary = document.getElementById("summary")
  const empty = document.getElementById("empty")
  if (!board) return
  const { counts } = board
  summary.textContent =
    counts.total === 0
      ? "No tickets"
      : `${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you · ${counts.working} moving · ${counts.closed} settled`
  empty.hidden = counts.total !== 0
  for (const group of GROUPS) {
    const target = document.getElementById(group)
    target.replaceChildren(...board[group].map(renderCard))
  }
}

const load = async () => {
  const outdated = document.getElementById("outdated")
  const summary = document.getElementById("summary")
  try {
    const response = await fetch("./api/board", { cache: "no-store" })
    if (!response.ok) throw new Error(`board returned ${response.status}`)
    state.board = await response.json()
    outdated.hidden = true
    render()
  } catch (error) {
    // A stale image is the common cause: the page and the API come from the
    // same container, so a route the process does not serve means "restart it".
    outdated.hidden = false
    summary.textContent = "Unavailable"
    console.error(error)
  }
}

document.getElementById("refresh").addEventListener("click", load)
load()
setInterval(load, 30_000)
