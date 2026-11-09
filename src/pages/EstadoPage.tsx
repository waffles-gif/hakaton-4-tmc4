import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError, BUILD_SHA, api } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { Check, Clearance, ClearanceCheckResult, IntegrationsStatus } from '../lib/types'

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string }

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `${e.code}: ${e.message}` : 'Error de red'
}

function fmt(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function Checks({ checks }: { checks: Check[] }) {
  if (checks.length === 0) return <p className="text-slate-400">Sin comprobaciones todavía.</p>
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {checks.map((c) => (
        <li key={c.name} className="text-sm">
          <span className={c.passed ? 'text-emerald-300' : 'text-red-300'}>{c.passed ? '✔' : '✘'}</span>{' '}
          <strong>{c.name}</strong> — {c.detail}
        </li>
      ))}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-slate-800 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  )
}

export default function EstadoPage() {
  const { reloadMe } = useAuth()
  const [health, setHealth] = useState<Load<{ status: string; time: string }>>({ state: 'loading' })
  const [integ, setInteg] = useState<Load<IntegrationsStatus>>({ state: 'loading' })
  const [clear, setClear] = useState<Load<Clearance>>({ state: 'loading' })
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<Load<ClearanceCheckResult> | null>(null)
  const [chaosBusy, setChaosBusy] = useState(false)
  const [chaosError, setChaosError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setHealth({ state: 'loading' })
    setInteg({ state: 'loading' })
    setClear({ state: 'loading' })
    await Promise.all([
      api<{ status: string; time: string }>('/meta/health', { auth: false })
        .then((data) => setHealth({ state: 'ok', data }))
        .catch((e: unknown) => setHealth({ state: 'error', message: errMsg(e) })),
      api<IntegrationsStatus>('/integrations/status')
        .then((data) => setInteg({ state: 'ok', data }))
        .catch((e: unknown) => setInteg({ state: 'error', message: errMsg(e) })),
      api<Clearance>('/clearance')
        .then((data) => setClear({ state: 'ok', data }))
        .catch((e: unknown) => setClear({ state: 'error', message: errMsg(e) })),
    ])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runCheck() {
    if (checking) return
    setChecking(true)
    setCheckResult({ state: 'loading' })
    try {
      const data = await api<ClearanceCheckResult>('/clearance/check', { method: 'POST' })
      setCheckResult({ state: 'ok', data })
      if (data.granted) await reloadMe()
      void load()
    } catch (e) {
      setCheckResult({ state: 'error', message: errMsg(e) })
    } finally {
      setChecking(false)
    }
  }

  async function setChaos(level: number) {
    setChaosBusy(true)
    setChaosError(null)
    try {
      await api('/workspace/chaos', { method: 'PUT', body: { level } })
      void load()
    } catch (e) {
      setChaosError(errMsg(e))
    } finally {
      setChaosBusy(false)
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Estado</h1>
        <button type="button" onClick={() => void load()} className="rounded border border-slate-600 px-3 py-1">
          Actualizar
        </button>
      </div>

      <Section title="Build y API">
        <p>
          Build desplegado: <code className="text-teal-300">{BUILD_SHA}</code>
        </p>
        <p>
          API:{' '}
          {health.state === 'loading'
            ? 'comprobando…'
            : health.state === 'ok'
              ? `responde (${fmt(health.data.time)})`
              : `no responde — ${health.message}`}
        </p>
      </Section>

      <Section title="Integraciones">
        {integ.state === 'loading' && <p>Cargando…</p>}
        {integ.state === 'error' && <p className="text-red-300">{integ.message}</p>}
        {integ.state === 'ok' && (
          <>
            <p>
              Dominio: {integ.data.deploy.origin ?? 'sin verificar'} (verificado {fmt(integ.data.deploy.verifiedAt)})
            </p>
            <p>
              Último build visto: {integ.data.deploy.lastBuildSeen ?? '—'} ({fmt(integ.data.deploy.lastBuildSeenAt)})
            </p>
            <p>
              Storage: {integ.data.storage.provider ?? 'sin configurar'} (verificado{' '}
              {fmt(integ.data.storage.verifiedAt)})
            </p>
            <Checks checks={integ.data.storage.checks} />
          </>
        )}
      </Section>

      <Section title="Piso de Pruebas">
        {clear.state === 'loading' && <p>Cargando…</p>}
        {clear.state === 'error' && <p className="text-red-300">{clear.message}</p>}
        {clear.state === 'ok' && (
          <>
            <p>
              Estado:{' '}
              <strong className={clear.data.granted ? 'text-emerald-300' : 'text-amber-300'}>
                {clear.data.granted ? `abierto (${fmt(clear.data.grantedAt)})` : 'cerrado'}
              </strong>
            </p>
            <p className="mt-1">
              Workspace {clear.data.workspace.kind} · caos {clear.data.workspace.chaosLevel}
            </p>
            {clear.data.workspace.kind === 'DEV' && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <span>Modo caos:</span>
                {[0, 1, 2].map((l) => (
                  <button
                    key={l}
                    type="button"
                    disabled={chaosBusy}
                    aria-pressed={clear.data.workspace.chaosLevel === l}
                    onClick={() => void setChaos(l)}
                    className="rounded border border-slate-600 px-2 py-0.5 aria-pressed:bg-teal-700 disabled:opacity-50"
                  >
                    {l}
                  </button>
                ))}
                {chaosError && <span className="text-red-300">{chaosError}</span>}
              </div>
            )}
            <h3 className="mt-3 font-medium">Última revisión ({fmt(clear.data.checkedAt)})</h3>
            <Checks checks={clear.data.checks} />
          </>
        )}

        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={checking}
          className="mt-4 rounded bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-500 disabled:opacity-60"
        >
          {checking ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
        </button>
        {checkResult?.state === 'error' && (
          <p role="alert" className="mt-2 text-red-300">
            {checkResult.message}
          </p>
        )}
        {checkResult?.state === 'ok' && (
          <div role="status" className="mt-2">
            <p>{checkResult.data.granted ? '¡Piso de Pruebas abierto!' : 'Todavía no se cumplen todas las comprobaciones:'}</p>
            <Checks checks={checkResult.data.checks} />
          </div>
        )}
      </Section>

      {clear.state === 'ok' && (
        <Section title="Rondas de control">
          <p>
            Roster: {clear.data.roster.members.map((m) => m.name).join(', ') || 'sin inscribir'}{' '}
            {clear.data.roster.complete ? '(completo)' : '(incompleto: inscriban a los 3)'}
          </p>
          <p>
            Ronda aprobada:{' '}
            {clear.data.round.approved ? `sí (ronda ${clear.data.round.approvedRound ?? '?'})` : 'todavía no'}
          </p>
          <p>Próxima ronda: {fmt(clear.data.round.nextRoundAt)}</p>
          {clear.data.round.drawnMember && (
            <p className="font-semibold text-amber-300">
              Sorteado/a: {clear.data.round.drawnMember.name} ({clear.data.round.drawnMember.code})
            </p>
          )}
          {clear.data.round.attempts.length > 0 && (
            <ul className="mt-2 text-sm">
              {clear.data.round.attempts.map((a) => (
                <li key={a.round}>
                  Ronda {a.round}: {a.member.name} — {a.result ?? 'pendiente'}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </main>
  )
}
