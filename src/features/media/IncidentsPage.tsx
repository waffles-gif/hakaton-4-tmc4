import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { getJson } from '../refine/http'

interface Incident {
  id: number
  title: string
  description: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  file: { id: number; name: string } | null
  photos: { mediaId: number; url: string; width: number; height: number }[]
  createdBy: { id: number; displayName: string }
  createdAt: string
}

interface IncidentPage {
  content: Incident[]
  totalPages: number
  totalElements: number
  page: number
  size: number
}

const SIZES = [10, 25, 50] as const

export default function IncidentsPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const pageRaw = Number(params.get('page') ?? '0')
  const page = Number.isInteger(pageRaw) && pageRaw >= 0 ? pageRaw : 0
  const sizeRaw = Number(params.get('size') ?? '10')
  const size = (SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : 10

  const [data, setData] = useState<IncidentPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ctrl = new AbortController() // una respuesta vieja nunca pisa a una nueva
    setLoading(true)
    setError(null)
    getJson<IncidentPage>(`/incidents?page=${page}&size=${size}`, ctrl.signal)
      .then((d) => setData(d))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof ApiError ? e.message : 'No se pudieron cargar las incidencias.')
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [page, size])

  const go = (p: number, s = size) => setParams({ page: String(p), size: String(s) })

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Incidencias</h1>
        {can('incidents:create') && can('media:upload') && (
          <Link to="/incidents/new" className="rounded bg-teal-600 px-3 py-1 text-white">
            Nuevo reporte
          </Link>
        )}
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm">
        Por página
        <select
          value={size}
          onChange={(e) => go(0, Number(e.target.value))}
          className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
        >
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {loading && !data && <p role="status" className="mt-4">Cargando…</p>}
      {error && (
        <p role="alert" className="mt-4 text-red-300">
          {error}{' '}
          <button type="button" className="underline" onClick={() => go(page)}>
            Reintentar
          </button>
        </p>
      )}
      {data && data.content.length === 0 && <p className="mt-4 text-slate-400">No hay reportes todavía.</p>}

      <ul className={`mt-4 flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`}>
        {data?.content.map((i) => (
          <li key={i.id} className="rounded border border-slate-700 p-3">
            {/* Textos externos: siempre como texto, nunca HTML. */}
            <h2 className="font-medium">{i.title}</h2>
            <p className="text-xs text-slate-400">
              {i.severity} · {i.createdBy.displayName} · {new Date(i.createdAt).toLocaleString()}
              {i.file ? ` · archivo ${i.file.name}` : ''}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{i.description}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {i.photos.map((p) => (
                <img
                  key={p.mediaId}
                  src={p.url}
                  width={p.width}
                  height={p.height}
                  loading="lazy"
                  decoding="async"
                  alt={`Foto de la incidencia «${i.title}»`}
                  className="h-28 w-auto rounded bg-slate-800"
                  style={{ aspectRatio: `${p.width} / ${p.height}` }}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>

      {data && data.totalPages > 1 && (
        <nav aria-label="Paginación" className="mt-4 flex items-center gap-3">
          <button type="button" disabled={page <= 0} onClick={() => go(page - 1)} className="underline disabled:opacity-40">
            Anterior
          </button>
          <span className="text-sm">
            Página {page + 1} de {data.totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= data.totalPages}
            onClick={() => go(page + 1)}
            className="underline disabled:opacity-40"
          >
            Siguiente
          </button>
        </nav>
      )}
    </main>
  )
}
