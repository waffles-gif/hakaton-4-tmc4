import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'

const MAX_DELAY = 30_000

/** Si /meta/health no responde: "Conectando con Lumon…", reintento con espera creciente y botón manual. */
export function HealthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [nextIn, setNextIn] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current)
    if (ticker.current) clearInterval(ticker.current)
  }

  const check = useCallback(async (n: number) => {
    clearTimers()
    setNextIn(null)
    try {
      await api('/meta/health', { auth: false })
      setOk(true)
    } catch {
      const delay = Math.min(1000 * 2 ** n, MAX_DELAY)
      setAttempt(n + 1)
      let left = Math.round(delay / 1000)
      setNextIn(left)
      ticker.current = setInterval(() => {
        left -= 1
        setNextIn(Math.max(left, 0))
      }, 1000)
      timer.current = setTimeout(() => void check(n + 1), delay)
    }
  }, [])

  useEffect(() => {
    void check(0)
    return clearTimers
  }, [check])

  if (ok) return <>{children}</>

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="max-w-sm text-center" role="status" aria-live="polite">
        <h1 className="text-xl font-semibold">Conectando con Lumon…</h1>
        {attempt > 0 && (
          <p className="mt-2 text-slate-300">
            No hay respuesta (intento {attempt}).{nextIn !== null && ` Reintentando en ${nextIn} s.`}
          </p>
        )}
        <button
          type="button"
          onClick={() => void check(attempt)}
          className="mt-4 rounded bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-500"
        >
          Reintentar ahora
        </button>
      </div>
    </main>
  )
}
