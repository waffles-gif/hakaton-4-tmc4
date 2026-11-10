import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useAuth } from '../../lib/auth'
import { ApiError, getJson } from '../refine/http'
import { onEvent } from '../events/eventBus'
import { safeHttpUrl, type Department, type Refiner, type RefinerPage } from './types'

const SIZES = [10, 25, 50] as const

interface Query {
  page: number
  size: (typeof SIZES)[number]
  departmentId: number | null
  q: string
}

/** Sanea la URL: un valor inválido cae al default (la vista nunca se rompe). */
function readQuery(sp: URLSearchParams): Query {
  const page = Number(sp.get('page'))
  const size = Number(sp.get('size'))
  const dep = Number(sp.get('departmentId'))
  return {
    page: Number.isInteger(page) && page >= 0 ? page : 0,
    size: (SIZES as readonly number[]).includes(size) ? (size as Query['size']) : 10,
    departmentId: Number.isInteger(dep) && dep >= 1 ? dep : null,
    q: (sp.get('q') ?? '').slice(0, 60),
  }
}

function toParams(q: Query): Record<string, string> {
  const out: Record<string, string> = {}
  if (q.page) out.page = String(q.page)
  if (q.size !== 10) out.size = String(q.size)
  if (q.departmentId) out.departmentId = String(q.departmentId)
  if (q.q) out.q = q.q
  return out
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'CLEARANCE_REQUIRED') return 'El Piso de Pruebas todavía está cerrado. Ábranlo desde /estado.'
    if (e.status === 403) return 'No tienes permiso para ver el directorio.'
    return e.message
  }
  return 'No se pudo cargar el directorio.'
}

export default function RefinersPage() {
  const { can } = useAuth()
  const [sp, setSp] = useSearchParams()
  const query = readQuery(sp)
  const queryKey = JSON.stringify(query)

  const [departments, setDepartments] = useState<Department[]>([])
  const [data, setData] = useState<RefinerPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(query.q)

  const update = (patch: Partial<Query>, replace = false) => {
    const next = { ...query, ...patch }
    if (!('page' in patch)) next.page = 0
    setSp(toParams(next), { replace })
  }

  useEffect(() => {
    const ctrl = new AbortController()
    getJson<Department[]>('/departments', ctrl.signal)
      .then(setDepartments)
      .catch(() => undefined) // el error principal lo muestra la lista
    return () => ctrl.abort()
  }, [])

  useEffect(() => setSearch(query.q), [query.q])

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSearch = (v: string) => {
    setSearch(v)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => update({ q: v.trim().slice(0, 60) }, true), 350)
  }
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

  // Eventos (CP5): un expediente actualizado se refleja sin recargar; versión vieja nunca pisa a una nueva.
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    const offU = onEvent('refiner.updated', (e) => {
      const d = e.data as { id?: number; version?: number; refiner?: Refiner } | null
      const fresh = d?.refiner
      if (!fresh) return
      setData((prev) =>
        prev && {
          ...prev,
          content: prev.content.map((r) => (r.id === fresh.id && fresh.version > r.version ? fresh : r)),
        },
      )
    })
    const offR = onEvent('stream.reset', () => setReloadTick((t) => t + 1))
    return () => {
      offU()
      offR()
    }
  }, [])

  // Una respuesta vieja nunca pisa a una nueva: se aborta la anterior.
  useEffect(() => {
    const ctrl = new AbortController()
    const params = new URLSearchParams({ page: String(query.page), size: String(query.size) })
    if (query.departmentId) params.set('departmentId', String(query.departmentId))
    if (query.q) params.set('q', query.q)
    setLoading(true)
    setError(null)
    getJson<RefinerPage>(`/refiners?${params}`, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return
        if (d.totalPages > 0 && query.page >= d.totalPages) {
          setSp(toParams({ ...query, page: d.totalPages - 1 }), { replace: true })
          return
        }
        setData(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setError(errorText(e))
        setLoading(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, reloadTick])

  const canEdit = can('refiners:write')

  return (
    <main className="mx-auto max-w-5xl p-4 text-slate-100">
      <h1 className="mb-4 text-2xl font-semibold">Expedientes del personal</h1>

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
          Departamento
          <select
            value={query.departmentId ?? ''}
            onChange={(e) => update({ departmentId: e.target.value ? Number(e.target.value) : null })}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
          >
            <option value="">Todos</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
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

      <p aria-live="polite" className="mb-2 text-sm text-slate-400">
        {loading ? 'Cargando expedientes…' : error ? '' : `${data?.totalElements ?? 0} expedientes`}
      </p>

      {error && (
        <p role="alert" className="mb-4 rounded border border-red-700 bg-red-950 p-3">{error}</p>
      )}

      {!loading && !error && data && data.content.length === 0 && (
        <p className="rounded border border-slate-700 p-6 text-center text-slate-400">
          No hay expedientes que coincidan.
        </p>
      )}

      {data && data.content.length > 0 && (
        <ul className={`grid gap-3 sm:grid-cols-2 ${loading ? 'opacity-60' : ''}`}>
          {data.content.map((r) => {
            const profile = safeHttpUrl(r.profileUrl)
            return (
              <li key={r.id} className="flex gap-3 rounded border border-slate-700 p-3">
                {/* Tamaño fijo: la imagen no mueve el layout al cargar. Carga diferida. */}
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-slate-800">
                  {r.badge ? (
                    <img
                      src={r.badge.url}
                      width={64}
                      height={64}
                      loading="lazy"
                      decoding="async"
                      alt={`Fotocheck de ${r.fullName}`}
                      className="h-16 w-16 object-cover"
                    />
                  ) : (
                    <div aria-hidden="true" className="grid h-16 w-16 place-items-center text-xl text-slate-500">
                      {r.fullName.trim().charAt(0).toUpperCase() || '?'}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {/* Todo como texto: React escapa el contenido, nunca se interpreta HTML. */}
                  <h2 className="truncate font-medium">{r.fullName}</h2>
                  <p className="truncate text-sm text-slate-300">{r.title}</p>
                  <p className="text-xs text-slate-400">
                    {r.department.name} · anexo {r.extension}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-400">{r.bio}</p>
                  <div className="mt-1 flex gap-3 text-sm">
                    {profile && (
                      <a href={profile} target="_blank" rel="noopener noreferrer" className="underline">
                        Perfil
                      </a>
                    )}
                    {canEdit && (
                      <Link to={`/refiners/${r.id}/edit`} className="underline">
                        Editar
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
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
          <span className="text-sm">Página {query.page + 1} de {data.totalPages}</span>
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
