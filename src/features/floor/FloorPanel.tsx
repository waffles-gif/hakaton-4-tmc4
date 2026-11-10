import { useEffect, useState } from 'react'
import { API_BASE_URL, api } from '../../lib/api'

// Piso compartido (CP5), versión reducida: conexión WebSocket nativa con ticket nuevo por conexión,
// latido ping/pong, reconexión según el código de cierre y lista de presentes sin duplicados
// (snapshot + member.joined/left, resync ante salto de seq). Si el piso no está disponible,
// la grilla sigue funcionando igual.

const WS_BASE: string =
  (import.meta.env.VITE_WS_BASE_URL as string | undefined) || API_BASE_URL.replace(/^http/, 'ws')

type FloorState = 'connecting' | 'open' | 'reconnecting' | 'closed'

const FATAL: Record<number, string> = {
  4400: 'Mensaje inválido',
  4403: 'Origen no verificado o sin permiso',
  4404: 'El archivo no existe',
  4423: 'El Piso de Pruebas está cerrado',
}

interface ServerMsg {
  type: string
  seq?: number
  userId?: number
  displayName?: string
  members?: Array<{ userId: number; displayName: string }>
}

export function FloorPanel({ fileId }: { fileId: number }) {
  const [state, setState] = useState<FloorState>('connecting')
  const [members, setMembers] = useState<Map<number, string>>(new Map())
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let attempt = 0
    let badTickets = 0
    let seq: number | null = null
    let missedPongs = 0
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const send = (o: object) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
    }

    const schedule = (minMs = 0) => {
      if (stopped) return
      attempt++
      setState('reconnecting')
      const delay = Math.max(minMs, Math.min(30_000, 1000 * 2 ** (attempt - 1))) + Math.floor(Math.random() * 300)
      retryTimer = setTimeout(() => void connect(), delay)
    }

    const handle = (m: ServerMsg) => {
      if (m.type === 'pong') {
        missedPongs = 0
        return
      }
      if (typeof m.seq === 'number') {
        // seq crece de uno en uno: si hay un salto, se perdió algo → resync y reconstruir desde snapshot.
        if (m.type !== 'snapshot' && seq !== null && m.seq !== seq + 1) {
          seq = null
          send({ type: 'resync' })
          return
        }
        seq = m.seq
      }
      if (m.type === 'snapshot' && m.members) {
        setMembers(new Map(m.members.map((x) => [x.userId, x.displayName])))
      } else if (m.type === 'member.joined' && typeof m.userId === 'number') {
        const { userId, displayName = '' } = m
        setMembers((prev) => new Map(prev).set(userId, displayName))
      } else if (m.type === 'member.left' && typeof m.userId === 'number') {
        const { userId } = m
        setMembers((prev) => {
          const next = new Map(prev)
          next.delete(userId)
          return next
        })
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
            socket.close() // dos pong sin llegar: conexión muerta → se reconecta en onclose
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
          /* mensaje no JSON: se ignora */
        }
      }
      socket.onclose = (ev) => {
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        if (ws === socket) ws = null
        setMembers(new Map()) // sin cursores ni presentes fantasma: al reconectar llega snapshot
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
            setNote('No se pudo entrar al piso compartido (ticket inválido). Puedes seguir refinando.')
            return
          }
        } else {
          badTickets = 0
        }
        schedule(ev.code === 4429 ? 10_000 : 0)
      }
    }

    void connect()
    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      if (pingTimer) clearInterval(pingTimer)
      ws?.close(1000)
    }
  }, [fileId])

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

  return (
    <section className="rounded border border-slate-700 p-3 text-sm" aria-label="Piso compartido">
      <p role="status" aria-live="polite" className="flex items-center gap-2">
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${dot[state]}`} />
        {label[state]}
      </p>
      {note && <p className="mt-1 text-xs text-amber-300">{note}</p>}
      {state === 'open' && (
        <>
          <h2 className="mt-2 font-semibold">Presentes ({members.size})</h2>
          <ul className="mt-1 text-xs text-slate-300">
            {[...members.entries()].map(([id, name]) => (
              <li key={id}>{name}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
