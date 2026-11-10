import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { API_BASE_URL, api } from '../../lib/api'

// Piso compartido (CP5): WebSocket nativo con ticket nuevo por conexión, ping/pong, reconexión según
// código de cierre, presentes sin duplicados, cursores (máx. 10/s, nada con la pestaña oculta) y
// reservas de grupo (claim/renew/release). Los cursores viven en un store aparte: al llegar NO
// re-renderizan la grilla, solo la capa de cursores. Si el piso no está disponible, se refina igual.

const WS_BASE: string =
  (import.meta.env.VITE_WS_BASE_URL as string | undefined) || API_BASE_URL.replace(/^http/, 'ws')

export type FloorState = 'connecting' | 'open' | 'reconnecting' | 'closed'

const FATAL: Record<number, string> = {
  4400: 'Mensaje inválido',
  4403: 'Origen no verificado o sin permiso',
  4404: 'El archivo no existe',
  4423: 'El Piso de Pruebas está cerrado',
}

interface Cell { r: number; c: number }
export interface Claim { claimId: string; userId: number; displayName: string; cells: Cell[] }
export interface Cursor { userId: number; displayName: string; r: number | null; c: number | null }

interface ServerMsg {
  type: string
  seq?: number
  userId?: number
  displayName?: string
  r?: number | null
  c?: number | null
  t?: number
  requestId?: string | number
  claimId?: string
  cells?: Cell[]
  reason?: string
  holder?: { userId: number; displayName: string } | null
  members?: Array<{ userId: number; displayName: string; r: number | null; c: number | null }>
  claims?: Claim[]
}

export type ClaimResult =
  | { ok: true; claimId: string }
  | { ok: false; reason: 'HELD' | 'NOT_A_GROUP' | 'UNAVAILABLE'; holder: string | null }

/** Store mínimo con suscripción (para useSyncExternalStore). */
function createStore<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set: (v: T) => {
      value = v
      for (const s of subs) s()
    },
    subscribe: (fn: () => void) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export function useFloor(fileId: number) {
  const [state, setState] = useState<FloorState>('connecting')
  const [note, setNote] = useState<string | null>(null)
  const [claims, setClaims] = useState<Map<string, Claim>>(new Map())
  const cursors = useMemo(() => createStore<Map<number, Cursor>>(new Map()), [])
  const api$ = useRef<{
    send: (o: object) => boolean
    pending: Map<string, (r: ClaimResult) => void>
    myClaim: string | null
  }>({ send: () => false, pending: new Map(), myClaim: null })

  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let attempt = 0
    let badTickets = 0
    let seq: number | null = null
    let missedPongs = 0
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const ref = api$.current

    const send = (o: object) => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify(o))
      return true
    }
    ref.send = send

    const resetState = () => {
      cursors.set(new Map())
      setClaims(new Map())
      ref.myClaim = null
      for (const [, resolve] of ref.pending) resolve({ ok: false, reason: 'UNAVAILABLE', holder: null })
      ref.pending.clear()
    }

    const schedule = (minMs = 0) => {
      if (stopped) return
      attempt++
      setState('reconnecting')
      const delay = Math.max(minMs, Math.min(30_000, 1000 * 2 ** (attempt - 1))) + Math.floor(Math.random() * 300)
      retryTimer = setTimeout(() => void connect(), delay)
    }

    const putCursor = (userId: number, displayName: string | undefined, r: number | null, c: number | null) => {
      const next = new Map(cursors.get())
      const prev = next.get(userId)
      next.set(userId, { userId, displayName: displayName ?? prev?.displayName ?? '', r, c })
      cursors.set(next)
    }

    const handle = (m: ServerMsg) => {
      if (m.type === 'pong') {
        missedPongs = 0
        return
      }
      if (typeof m.seq === 'number') {
        if (m.type !== 'snapshot' && seq !== null && m.seq !== seq + 1) {
          seq = null
          send({ type: 'resync' }) // salto de seq: se perdió algo → reconstruir desde snapshot
          return
        }
        seq = m.seq
      }
      switch (m.type) {
        case 'snapshot':
          cursors.set(new Map((m.members ?? []).map((x) => [x.userId, { ...x }])))
          setClaims(new Map((m.claims ?? []).map((cl) => [cl.claimId, cl])))
          break
        case 'member.joined':
          if (typeof m.userId === 'number') putCursor(m.userId, m.displayName, null, null)
          break
        case 'member.left':
          if (typeof m.userId === 'number') {
            const next = new Map(cursors.get())
            next.delete(m.userId)
            cursors.set(next)
          }
          break
        case 'cursor':
          if (typeof m.userId === 'number') putCursor(m.userId, undefined, m.r ?? null, m.c ?? null)
          break
        case 'claim.granted':
        case 'claim.updated':
          if (m.claimId && typeof m.userId === 'number' && m.cells) {
            const cl: Claim = { claimId: m.claimId, userId: m.userId, displayName: m.displayName ?? '', cells: m.cells }
            setClaims((prev) => new Map(prev).set(cl.claimId, cl))
            if (m.type === 'claim.granted') {
              ref.myClaim = m.claimId
              const key = String(m.requestId)
              ref.pending.get(key)?.({ ok: true, claimId: m.claimId })
              ref.pending.delete(key)
            }
          }
          break
        case 'claim.denied': {
          const key = String(m.requestId)
          ref.pending.get(key)?.({
            ok: false,
            reason: m.reason === 'HELD' ? 'HELD' : 'NOT_A_GROUP',
            holder: m.holder?.displayName ?? null,
          })
          ref.pending.delete(key)
          break
        }
        case 'claim.released':
          if (m.claimId) {
            const id = m.claimId
            if (ref.myClaim === id) ref.myClaim = null
            setClaims((prev) => {
              const next = new Map(prev)
              next.delete(id)
              return next
            })
          }
          break
      }
    }

    async function connect() {
      if (stopped) return
      setState(attempt === 0 ? 'connecting' : 'reconnecting')
      let ticket: string
      try {
        ticket = (await api<{ ticket: string }>('/floor/tickets', { method: 'POST', body: { fileId } })).ticket
      } catch {
        schedule()
        return
      }
      if (stopped) return
      const socket = new WebSocket(`${WS_BASE}/floor/ws?ticket=${encodeURIComponent(ticket)}`)
      ws = socket
      socket.onopen = () => {
        attempt = 0
        missedPongs = 0
        seq = null
        setState('open')
        setNote(null)
        pingTimer = setInterval(() => {
          if (missedPongs >= 2) {
            socket.close() // dos pong sin llegar: conexión muerta
            return
          }
          missedPongs++
          send({ type: 'ping', t: Date.now() })
        }, 15_000)
      }
      socket.onmessage = (ev: MessageEvent<string>) => {
        try {
          handle(JSON.parse(ev.data) as ServerMsg)
        } catch {
          /* no JSON */
        }
      }
      socket.onclose = (ev) => {
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        if (ws === socket) ws = null
        resetState() // nada de cursores ni reservas fantasma
        if (stopped) return
        const fatal = FATAL[ev.code]
        if (fatal) {
          setState('closed')
          setNote(`${fatal}. El piso compartido no está disponible; puedes seguir refinando.`)
          return
        }
        if (ev.code === 4401) {
          badTickets++
          if (badTickets >= 2) {
            setState('closed')
            setNote('No se pudo entrar al piso compartido. Puedes seguir refinando.')
            return
          }
        } else badTickets = 0
        schedule(ev.code === 4429 ? 10_000 : 0)
      }
    }

    void connect()
    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      if (pingTimer) clearInterval(pingTimer)
      if (ref.myClaim) send({ type: 'release', claimId: ref.myClaim })
      ws?.close(1000)
      ref.send = () => false
    }
  }, [fileId, cursors])

  // Renovar la reserva propia cada 10 s mientras dure (vence a los 15 s).
  useEffect(() => {
    const t = setInterval(() => {
      const ref = api$.current
      if (ref.myClaim) ref.send({ type: 'renew', claimId: ref.myClaim })
    }, 10_000)
    return () => clearInterval(t)
  }, [])

  // Cursor propio: máximo 10 mensajes por segundo y ninguno con la pestaña oculta.
  const lastCursor = useRef(0)
  const pendingCursor = useRef<Cell | null>(null)
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendCursor = (r: number, c: number) => {
    if (document.hidden) return
    pendingCursor.current = { r, c }
    const flush = () => {
      cursorTimer.current = null
      const p = pendingCursor.current
      if (!p || document.hidden) return
      lastCursor.current = Date.now()
      api$.current.send({ type: 'cursor', r: p.r, c: p.c })
      pendingCursor.current = null
    }
    const wait = 100 - (Date.now() - lastCursor.current)
    if (wait <= 0) flush()
    else if (!cursorTimer.current) cursorTimer.current = setTimeout(flush, wait)
  }

  const reqSeq = useRef(0)
  /** Reserva el grupo de esa celda. Si el piso no responde en 3 s, se sigue sin reserva. */
  const claim = (r: number, c: number): Promise<ClaimResult> => {
    const ref = api$.current
    const requestId = `c-${++reqSeq.current}`
    return new Promise((resolve) => {
      if (!ref.send({ type: 'claim', requestId, r, c })) {
        resolve({ ok: false, reason: 'UNAVAILABLE', holder: null })
        return
      }
      ref.pending.set(requestId, resolve)
      setTimeout(() => {
        if (ref.pending.delete(requestId)) resolve({ ok: false, reason: 'UNAVAILABLE', holder: null })
      }, 3000)
    })
  }

  const release = () => {
    const ref = api$.current
    if (ref.myClaim) {
      ref.send({ type: 'release', claimId: ref.myClaim })
      ref.myClaim = null
    }
  }

  return { state, note, claims, cursors, sendCursor, claim, release }
}

export type Floor = ReturnType<typeof useFloor>

/** Cursores de los demás sobre las celdas visibles. Solo esta capa se re-renderiza al moverse. */
export function CursorsLayer({ floor, myId, cell, range }: {
  floor: Floor
  myId: number | undefined
  cell: number
  range: { r0: number; r1: number; c0: number; c1: number }
}) {
  const map = useSyncExternalStore(floor.cursors.subscribe, floor.cursors.get)
  return (
    <>
      {[...map.values()]
        .filter((x) => x.userId !== myId && x.r !== null && x.c !== null)
        .filter((x) => x.r! >= range.r0 && x.r! < range.r1 && x.c! >= range.c0 && x.c! < range.c1)
        .map((x) => (
          <div
            key={x.userId}
            aria-hidden="true"
            className="pointer-events-none absolute z-10 border-2 border-fuchsia-400"
            style={{ top: x.r! * cell, left: x.c! * cell, width: cell, height: cell }}
          >
            <span className="absolute -top-4 left-0 whitespace-nowrap rounded bg-fuchsia-500 px-1 text-[10px] text-white">
              {x.displayName}
            </span>
          </div>
        ))}
    </>
  )
}

/** Estado de la conexión y lista de presentes; quien está fuera de la vista tiene "Ir". */
export function FloorPanel({ floor, myId, range, onGoTo }: {
  floor: Floor
  myId: number | undefined
  range: { r0: number; r1: number; c0: number; c1: number }
  onGoTo: (r: number, c: number) => void
}) {
  const map = useSyncExternalStore(floor.cursors.subscribe, floor.cursors.get)
  const label: Record<FloorState, string> = {
    connecting: 'Piso: conectando…',
    open: 'Piso: conectado',
    reconnecting: 'Piso: reconectando…',
    closed: 'Piso: no disponible',
  }
  const dot: Record<FloorState, string> = {
    connecting: 'bg-amber-400',
    open: 'bg-emerald-400',
    reconnecting: 'bg-amber-400',
    closed: 'bg-slate-500',
  }
  const members = [...map.values()]
  return (
    <section className="rounded border border-slate-700 p-3 text-sm" aria-label="Piso compartido">
      <p role="status" aria-live="polite" className="flex items-center gap-2">
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${dot[floor.state]}`} />
        {label[floor.state]}
      </p>
      {floor.note && <p className="mt-1 text-xs text-amber-300">{floor.note}</p>}
      {floor.state === 'open' && (
        <>
          <h2 className="mt-2 font-semibold">Presentes ({members.length})</h2>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-slate-300">
            {members.map((m) => {
              const visible =
                m.r !== null && m.c !== null && m.r >= range.r0 && m.r < range.r1 && m.c >= range.c0 && m.c < range.c1
              return (
                <li key={m.userId} className="flex items-center justify-between gap-2">
                  <span>
                    {m.displayName}
                    {m.userId === myId ? ' (tú)' : ''}
                  </span>
                  {m.userId !== myId && m.r !== null && m.c !== null && !visible && (
                    <button type="button" className="underline" onClick={() => onGoTo(m.r!, m.c!)}>
                      Ir ({m.r}, {m.c})
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
