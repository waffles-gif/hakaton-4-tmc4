import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { ApiError, api } from '../../lib/api'
import { getStatus, onEvent, startEvents, stopEvents, subscribeStatus, type EventStatus } from './eventBus'

const LABEL: Record<EventStatus, string> = {
  off: 'Eventos: desconectado',
  connecting: 'Eventos: conectando…',
  open: 'Eventos: en vivo',
  reconnecting: 'Eventos: reconectando…',
}
const DOT: Record<EventStatus, string> = {
  off: 'bg-slate-500',
  connecting: 'bg-amber-400',
  open: 'bg-emerald-400',
  reconnecting: 'bg-amber-400',
}

/** Indicador visible del estado del stream. Monta la conexión mientras haya sesión. */
export function EventsIndicator() {
  useEffect(() => {
    startEvents()
    return () => stopEvents()
  }, [])
  const status = useSyncExternalStore(subscribeStatus, getStatus)
  return (
    <span className="flex items-center gap-1 text-xs text-slate-300" role="status" aria-live="polite">
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT[status]}`} />
      {LABEL[status]}
    </span>
  )
}

interface Contingency {
  id: number
  message: string
}

/**
 * Modal de contingencia: aparece en TODAS las pestañas (los eventos se reparten por BroadcastChannel),
 * atrapa el foco, se anuncia (alertdialog) y solo se cierra al confirmar con POST /contingency/{id}/ack
 * o cuando llega contingency.resolved (otra pestaña ya confirmó).
 */
export function ContingencyModal() {
  const [current, setCurrent] = useState<Contingency | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const confirmBtn = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const offA = onEvent('contingency.activated', (e) => {
      const d = e.data as { id?: number; message?: string } | null
      if (typeof d?.id !== 'number') return
      setCurrent({ id: d.id, message: d.message ?? 'Contingencia de horas extra.' })
      setError(null)
    })
    const offR = onEvent('contingency.resolved', (e) => {
      const d = e.data as { id?: number } | null
      setCurrent((c) => (c && c.id === d?.id ? null : c))
    })
    return () => {
      offA()
      offR()
    }
  }, [])

  // Al abrir: guardar el foco anterior y mover el foco al modal. Al cerrar: devolverlo.
  useEffect(() => {
    if (current) {
      previousFocus.current = document.activeElement as HTMLElement | null
      confirmBtn.current?.focus()
    } else {
      previousFocus.current?.focus?.()
    }
  }, [current])

  if (!current) return null

  async function ack() {
    if (!current || busy) return
    setBusy(true)
    setError(null)
    try {
      await api(`/contingency/${current.id}/ack`, { method: 'POST' })
      setCurrent(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo confirmar. Intenta de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  // Trampa de foco: Tab y Shift+Tab no salen del modal. Escape no lo cierra.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      return
    }
    if (e.key !== 'Tab' || !dialog.current) return
    const items = dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-4">
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-msg"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded border border-red-500 bg-slate-950 p-6 text-slate-100"
      >
        <h2 id="contingency-title" className="text-xl font-semibold text-red-300">
          Contingencia activada
        </h2>
        {/* El mensaje viene del servidor: se muestra como texto. */}
        <p id="contingency-msg" className="mt-2 whitespace-pre-wrap">{current.message}</p>
        {error && (
          <p role="alert" className="mt-3 rounded bg-red-950 p-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <button
          ref={confirmBtn}
          type="button"
          onClick={() => void ack()}
          disabled={busy}
          className="mt-4 w-full rounded bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-500 disabled:opacity-60"
        >
          {busy ? 'Confirmando…' : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}
