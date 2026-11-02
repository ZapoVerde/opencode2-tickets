/**
 * Flags for the read-only board. Kept apart from `server.ts` so the entry point
 * can be imported by a test without starting a listener, and so the defaults
 * are stated once.
 */
export const DEFAULT_PORT = 4600
export const LOOPBACK = "127.0.0.1"
export const ALL_INTERFACES = "0.0.0.0"

export type ServerOptions = {
  readonly port: number
  readonly host: string
  readonly db: string | null
}

export type ParseResult =
  | { readonly ok: true; readonly options: ServerOptions }
  | { readonly ok: false; readonly message: string }

export function parseArguments(argv: readonly string[]): ParseResult {
  const options: { port: number; host: string; db: string | null } = {
    port: DEFAULT_PORT,
    host: LOOPBACK,
    db: null,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    const [flag, inline] = argument.startsWith("--") ? splitFlag(argument) : [argument, undefined]
    const next = () => {
      if (inline !== undefined) return inline
      const value = argv[index + 1]
      if (value === undefined) return null
      index += 1
      return value
    }
    if (flag === "--port") {
      const raw = next()
      if (raw === null || !/^\d+$/.test(raw) || Number(raw) > 65_535)
        return { ok: false, message: "--port expects an integer between 0 and 65535" }
      options.port = Number(raw)
      continue
    }
    if (flag === "--host") {
      const raw = next()
      if (raw !== LOOPBACK && raw !== ALL_INTERFACES)
        return { ok: false, message: `--host must be ${LOOPBACK} or ${ALL_INTERFACES}` }
      options.host = raw
      continue
    }
    if (flag === "--db") {
      const raw = next()
      if (raw === null || raw.length === 0) return { ok: false, message: "--db expects a path" }
      options.db = raw
      continue
    }
    return { ok: false, message: `unknown argument ${argument}` }
  }
  return { ok: true, options }
}

function splitFlag(argument: string): [string, string | undefined] {
  const index = argument.indexOf("=")
  if (index === -1) return [argument, undefined]
  return [argument.slice(0, index), argument.slice(index + 1)]
}

export const usage = `Usage: bun run web [flags]

Serves a read-only ticket board from the tickets sidecar.

Flags:
  --port <number>          Port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)
  --host <address>         ${LOOPBACK} (default, loopback only) or ${ALL_INTERFACES}
  --db <path>              Sidecar database (default: OPENCODE_TICKETS_DB or XDG opencode/tickets.db)
  -h, --help               Show this help

Other hosts are refused. Exposing the board requires an explicit --host ${ALL_INTERFACES}.`
