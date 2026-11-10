// Stream de eventos (SSE) del CP5.
// - Ticket de un solo uso (POST /events/tickets) por conexión; el access token nunca va en la URL.
// - UNA conexión por navegador: la pestaña que tiene el Web Lock es la líder y reparte los eventos
//   por BroadcastChannel. Si se cierra, el lock se libera y otra pestaña la retoma.
// - Se lee con fetch + ReadableStream (sin librerías) para ver también los comentarios ": hb" del
//   heartbeat: sin datos ni heartbeat por 45 s → conexión muerta → se reconecta.
// - Reconexión con espera creciente, enviando lastEventId. Eventos duplicados se descartan por id.
import { API_BASE_URL, api, endSession, sleep } from '../../lib/api'

export type EventStatus = 'off' | 'connecting' | 'open' | 'reconnecting'

export interface LumonEvent {
  id: number | null
  type: string
  data: unknown
}

type Handler = (e: LumonEvent) => void
type Msg = { kind: 'event'; event: LumonEvent } | { kind: 'status'; status: EventStatus }

const DEAD_AFTER_MS = 45_000
const LOCK = 'lumon-sse'

// ---------- suscriptores ----------
const handlers = new Map<string, Set<Handler>>()

export function onEvent(type: string, fn: Handler): () => void {
  let set = handlers.get(type)
  if (!set) handlers.set(type, (set = new Set()))
  set.add(fn)
  return () => set.delete(fn)
}

// ---------- estado de la conexión (para el indicador) ----------
let status: EventStatus = 'off'
const statusListeners = new Set<() => void>()
export const subscribeStatus = (fn: () => void) => {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}
export const getStatus = () => status
function setStatus(s: EventStatus, broadcast = true) {
  status = s
  for (const fn of statusListeners) fn()
  if (broadcast) channel?.postMessage({ kind: 'status', status: s } satisfies Msg)
}

// ---------- deduplicación y reparto ----------
const seen = new Set<number>()
const seenOrder: number[] = []
let lastId: number | null = null

function dispatch(e: LumonEvent) {
  if (e.id !== null) {
    if (seen.has(e.id)) return // llegó dos veces
    seen.add(e.id)
    seenOrder.push(e.id)
    if (seenOrder.length > 2000) seen.delete(seenOrder.shift()!)
    if (e.type === 'stream.reset' || lastId === null || e.id > lastId) lastId = e.id
  }
  if (e.type === 'session.revoked') {
    const reason = (e.data as { reason?: string } | null)?.reason
    endSession(reason === 'REFRESH_REUSED' ? 'REFRESH_REUSED' : 'SESSION_REVOKED')
  }
  for (const h of handlers.get(e.type) ?? []) h(e)
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lumon-events') : null

channel?.addEventListener('message', (ev: MessageEvent<Msg>) => {
  const m = ev.data
  if (m.kind === 'event') dispatch(m.event)
  else if (!isLeader) setStatus(m.status, false)
})

// ---------- parser SSE ----------
function parseBlock(block: string): LumonEvent | null {
  let id: number | null = null
  let type = 'message'
  let data = ''
  let hasData = false
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue // comentario (": lumon", ": hb")
    const k = line.indexOf(':')
    const field = k < 0 ? line : line.slice(0, k)
    let val = k < 0 ? '' : line.slice(k + 1)
    if (val.startsWith(' ')) val = val.slice(1)
    if (field === 'id') {
      const n = Number(val)
      id = Number.isFinite(n) ? n : null
    } else if (field === 'event') type = val
    else if (field === 'data') {
      data += (hasData ? '\n' : '') + val
      hasData = true
    }
  }
  if (!hasData) return null
  let parsed: unknown = data
  try {
    parsed = JSON.parse(data)
  } catch {
    /* texto plano */
  }
  return { id, type, data: parsed }
}

async function readStream(body: ReadableStream<Uint8Array>, ctrl: AbortController, onEv: (e: LumonEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let timer = setTimeout(() => ctrl.abort(), DEAD_AFTER_MS)
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(), DEAD_AFTER_MS)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      alive() // cualquier byte (datos o heartbeat) cuenta como vida
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n')
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = parseBlock(buf.slice(0, i))
        buf = buf.slice(i + 2)
        if (ev) onEv(ev)
      }
    }
  } catch {
    /* abortado, conexión muerta o corte de red */
  } finally {
    clearTimeout(timer)
  }
}

// ---------- conexión (solo la pestaña líder) ----------
let isLeader = false
let stopCtrl: AbortController | null = null

function backoff(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 400)
}

async function runLoop(signal: AbortSignal) {
  let attempt = 0
  while (!signal.aborted) {
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
    let waitExtra = 0
    try {
      const { ticket } = await api<{ ticket: string }>('/events/tickets', { method: 'POST', signal })
      const qs = new URLSearchParams({ ticket })
      if (lastId !== null) qs.set('lastEventId', String(lastId))
      const ctrl = new AbortController()
      const onStop = () => ctrl.abort()
      signal.addEventListener('abort', onStop, { once: true })
      try {
        const res = await fetch(`${API_BASE_URL}/events/stream?${qs}`, { signal: ctrl.signal, cache: 'no-store' })
        if (res.ok && res.body) {
          setStatus('open')
          attempt = 0
          await readStream(res.body, ctrl, (e) => {
            if (e.type === 'stream.superseded') waitExtra = 10_000 // otra conexión tomó el stream
            channel?.postMessage({ kind: 'event', event: e } satisfies Msg)
            dispatch(e)
          })
        } else if (res.status === 401) {
          waitExtra = 5_000 // ticket vencido o sesión revocada: el siguiente ticket lo decide
        } else if (res.status === 423 || res.status === 403) {
          waitExtra = 30_000
        }
      } finally {
        signal.removeEventListener('abort', onStop)
      }
    } catch {
      if (signal.aborted) break
    }
    attempt++
    try {
      await sleep(backoff(attempt) + waitExtra, signal)
    } catch {
      break
    }
  }
}

/** Empieza a escuchar (llamar con sesión iniciada). Idempotente. */
export function startEvents() {
  if (stopCtrl) return
  const ctrl = new AbortController()
  stopCtrl = ctrl
  if (status === 'off') setStatus('connecting', false)
  if (typeof navigator !== 'undefined' && navigator.locks) {
    navigator.locks
      .request(LOCK, { signal: ctrl.signal }, async () => {
        isLeader = true
        try {
          await runLoop(ctrl.signal)
        } finally {
          isLeader = false
        }
      })
      .catch(() => undefined)
  } else {
    void runLoop(ctrl.signal)
  }
}

export function stopEvents() {
  stopCtrl?.abort()
  stopCtrl = null
  setStatus('off', false)
}
