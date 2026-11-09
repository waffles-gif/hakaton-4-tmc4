import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError, getJson } from './http'
import type { FilePage, FileStatus } from './types'

const SIZES = [10, 25, 50] as const
const SORTS = ['updatedAt,desc', 'progress,desc', 'name,asc'] as const
const SORT_LABEL: Record<(typeof SORTS)[number], string> = {
  'updatedAt,desc': 'Más recientes',
  'progress,desc': 'Más avanzados',
  'name,asc': 'Nombre A–Z',
}

interface Query {
  page: number
  size: (typeof SIZES)[number]
  status: FileStatus | ''
  q: string
  sort: (typeof SORTS)[number]
}

/** Sanea la URL: cualquier valor inválido cae al default (una URL rota no rompe la vista). */
function readQuery(sp: URLSearchParams): Query {
  const page = Number(sp.get('page'))
  const size = Number(sp.get('size'))
  const status = sp.get('status')
  const sort = sp.get('sort')
  return {
    page: Number.isInteger(page) && page >= 0 ? page : 0,
    size: (SIZES as readonly number[]).includes(size) ? (size as Query['size']) : 10,
    status: status === 'ACTIVE' || status === 'COMPLETE' ? status : '',
    q: (sp.get('q') ?? '').slice(0, 60),
    sort: (SORTS as readonly string[]).includes(sort ?? '') ? (sort as Query['sort']) : 'updatedAt,desc',
  }
}

function toParams(q: Query): Record<string, string> {
  const out: Record<string, string> = {}
  if (q.page) out.page = String(q.page)
  if (q.size !== 10) out.size = String(q.size)
  if (q.status) out.status = q.status
  if (q.q) out.q = q.q
  if (q.sort !== 'updatedAt,desc') out.sort = q.sort
  return out
}

const pct = (n: number) => `${Math.round(n * 100)}%`

export default function FilesPage() {
  const [sp, setSp] = useSearchParams()
  const query = readQuery(sp)
  const queryKey = JSON.stringify(query)

  const [data, setData] = useState<FilePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(query.q)

  const update = (patch: Partial<Query>, replace = false) => {
    const next = { ...query, ...patch }
    if (!('page' in patch)) next.page = 0
    setSp(toParams(next), { replace })
  }

  // Si la URL cambia por atrás/adelante, el input refleja la URL.
  useEffect(() => setSearch(query.q), [query.q])

  // Búsqueda sin una request por tecla: debounce de 350 ms antes de tocar la URL.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSearch = (v: string) => {
    setSearch(v)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => update({ q: v.trim().slice(0, 60) }, true), 350)
  }
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

  // Una respuesta vieja nunca pisa a una nueva: abortamos la anterior.
  useEffect(() => {
    const ctrl = new AbortController()
    const params = new URLSearchParams({ page: String(query.page), size: String(query.size), sort: query.sort })
    if (query.status) params.set('status', query.status)
    if (query.q) params.set('q', query.q)
    setLoading(true)
    setError(null)
    getJson<FilePage>(`/files?${params}`, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return
        // Página fuera de rango → ir a la última válida.
        if (d.totalPages > 0 && query.page >= d.totalPages) {
          setSp(toParams({ ...query, page: d.totalPages - 1 }), { replace: true })
          return
        }
        setData(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'No se pudo cargar la lista.')
        setLoading(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  return (
    <main className="mx-auto max-w-5xl p-4 text-slate-100">
      <h1 className="mb-4 text-2xl font-semibold">Archivos de datos</h1>

      <form className="mb-4 flex flex-wrap gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Filtros">
        <label className="flex flex-col text-sm">
          Buscar
          <input
            type="search"
            maxLength={60}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          Estado
          <select
            value={query.status}
            onChange={(e) => update({ status: e.target.value as Query['status'] })}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
          >
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="COMPLETE">Completados</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Orden
          <select
            value={query.sort}
            onChange={(e) => update({ sort: e.target.value as Query['sort'] })}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
          >
            {SORTS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Por página
          <select
            value={query.size}
            onChange={(e) => update({ size: Number(e.target.value) as Query['size'] })}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
          >
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </form>

      <div aria-live="polite" className="mb-2 text-sm text-slate-400">
        {loading ? 'Cargando archivos…' : error ? '' : `${data?.totalElements ?? 0} archivos`}
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded border border-red-700 bg-red-950 p-3">
          {error}
        </p>
      )}

      {!loading && !error && data && data.content.length === 0 && (
        <p className="rounded border border-slate-700 p-6 text-center text-slate-400">
          No hay archivos que coincidan con los filtros.
        </p>
      )}

      {data && data.content.length > 0 && (
        <ul className={`divide-y divide-slate-800 rounded border border-slate-700 ${loading ? 'opacity-60' : ''}`}>
          {data.content.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div>
                <Link to={`/files/${f.id}/refine`} className="font-medium underline">
                  {f.name}
                </Link>
                <p className="text-xs text-slate-400">
                  {f.rows} × {f.cols} · {f.refinedGroups}/{f.totalGroups} grupos · {f.mistakes} errores ·{' '}
                  {f.status === 'COMPLETE' ? 'Completado' : 'Activo'}
                </p>
              </div>
              <div className="w-40" aria-label={`Progreso ${pct(f.progress.overall)}`}>
                <div className="h-2 rounded bg-slate-800">
                  <div className="h-2 rounded bg-teal-500" style={{ width: pct(f.progress.overall) }} />
                </div>
                <p className="text-right text-xs">{pct(f.progress.overall)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && data.totalPages > 1 && (
        <nav className="mt-4 flex items-center gap-3" aria-label="Paginación">
          <button
            type="button"
            disabled={query.page === 0}
            onClick={() => update({ page: query.page - 1 })}
            className="rounded border border-slate-600 px-3 py-1 disabled:opacity-40"
          >
            Anterior
          </button>
          <span className="text-sm">
            Página {query.page + 1} de {data.totalPages}
          </span>
          <button
            type="button"
            disabled={query.page + 1 >= data.totalPages}
            onClick={() => update({ page: query.page + 1 })}
            className="rounded border border-slate-600 px-3 py-1 disabled:opacity-40"
          >
            Siguiente
          </button>
        </nav>
      )}
    </main>
  )
}
