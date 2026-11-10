import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { fieldErrors } from '../../lib/api'
import { ApiError, apiResponse, backoffMs, getJson, isRetryable, sleep } from '../refine/http'
import { onEvent } from '../events/eventBus'
import type { Department, Refiner, RefinerPatch } from './types'

// Regla de Milchick: PATCH siempre con el ETag exacto leído. Ante 412 se muestra el conflicto
// campo por campo y el usuario elige; nunca se sobrescribe en silencio.

type FieldName = 'title' | 'extension' | 'bio' | 'departmentId'
type Form = Record<FieldName, string>

const LABELS: Record<FieldName, string> = {
  title: 'Título',
  extension: 'Anexo',
  bio: 'Biografía',
  departmentId: 'Departamento',
}
const FIELDS: FieldName[] = ['title', 'extension', 'departmentId', 'bio']

function toForm(r: Refiner): Form {
  return { title: r.title, extension: r.extension, bio: r.bio, departmentId: String(r.department.id) }
}

function validate(f: Form): Partial<Record<FieldName, string>> {
  const e: Partial<Record<FieldName, string>> = {}
  if (f.title.trim().length < 1 || f.title.length > 200) e.title = 'Entre 1 y 200 caracteres.'
  if (!/^[0-9]{3,6}$/.test(f.extension)) e.extension = 'De 3 a 6 dígitos.'
  if (f.bio.length > 2000) e.bio = 'Máximo 2000 caracteres.'
  if (!f.departmentId) e.departmentId = 'Elige un departamento.'
  return e
}

/** Solo los campos que el usuario cambió respecto de la versión leída. */
function diff(base: Form, f: Form): RefinerPatch {
  const p: RefinerPatch = {}
  if (f.title !== base.title) p.title = f.title
  if (f.extension !== base.extension) p.extension = f.extension
  if (f.bio !== base.bio) p.bio = f.bio
  if (f.departmentId !== base.departmentId) p.departmentId = Number(f.departmentId)
  return p
}

const etagOf = (res: Response, r: Refiner) => res.headers.get('ETag') ?? `"${r.version}"`

interface Conflict {
  server: Refiner
  etag: string
  mine: Form
  /** Campos que el usuario había cambiado. */
  changed: FieldName[]
  choice: Record<FieldName, 'mine' | 'server'>
}

export default function RefinerEditPage() {
  const { id } = useParams()
  const refinerId = Number(id)
  const validId = Number.isInteger(refinerId) && refinerId > 0

  const [refiner, setRefiner] = useState<Refiner | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)

  /** Aplica una versión del servidor solo si no es más vieja que la que ya tenemos. */
  const versionRef = useRef(0)
  const applyServer = useCallback((r: Refiner, tag: string): boolean => {
    if (r.version < versionRef.current) return false // una respuesta vieja no pisa a una nueva
    versionRef.current = r.version
    setRefiner(r)
    setEtag(tag)
    return true
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await apiResponse(`/refiners/${refinerId}`, { signal })
        const r = (await res.json()) as Refiner
        if (applyServer(r, etagOf(res, r))) setForm(toForm(r))
        setLoadError(null)
        return
      } catch (e) {
        if (signal?.aborted) return
        if (isRetryable(e) && attempt < 5) {
          await sleep(backoffMs(attempt, e.retryAfter), signal)
          continue
        }
        setLoadError(
          e instanceof ApiError
            ? e.code === 'CLEARANCE_REQUIRED'
              ? 'El Piso de Pruebas todavía está cerrado.'
              : e.status === 404
                ? 'Ese expediente no existe.'
                : e.message
            : 'No se pudo cargar el expediente.',
        )
        return
      }
    }
  }, [refinerId, applyServer])

  useEffect(() => {
    if (!validId) return
    const ctrl = new AbortController()
    void load(ctrl.signal)
    getJson<Department[]>('/departments', ctrl.signal).then(setDepartments).catch(() => undefined)
    return () => ctrl.abort()
  }, [validId, load])

  // Si mientras se edita llega un refiner.updated de este expediente, se avisa ANTES de guardar.
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null)
  useEffect(() => {
    const offU = onEvent('refiner.updated', (e) => {
      const d = e.data as { id?: number; version?: number; updatedBy?: { displayName?: string } } | null
      if (d?.id !== refinerId || typeof d.version !== 'number') return
      if (d.version > versionRef.current) setRemoteVersion(d.version)
    })
    const offR = onEvent('stream.reset', () => setRemoteVersion((v) => v ?? versionRef.current + 1))
    return () => {
      offU()
      offR()
    }
  }, [refinerId])

  async function send(patch: RefinerPatch, ifMatch: string, mine: Form, base: Refiner) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await apiResponse(`/refiners/${refinerId}`, {
        method: 'PATCH',
        headers: { 'If-Match': ifMatch },
        body: patch,
      })
      const r = (await res.json()) as Refiner
      applyServer(r, etagOf(res, r))
      setForm(toForm(r))
      setConflict(null)
      setMessage({ text: 'Expediente guardado.', error: false })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        const current = (e.details as { current?: Refiner } | null)?.current
        if (!current) {
          setMessage({ text: 'Alguien cambió el expediente. Recárgalo antes de guardar.', error: true })
          return
        }
        const baseForm = toForm(base)
        const changed = FIELDS.filter((f) => mine[f] !== baseForm[f])
        const choice = Object.fromEntries(FIELDS.map((f) => [f, 'mine'])) as Conflict['choice']
        applyServer(current, `"${current.version}"`)
        setConflict({ server: current, etag: `"${current.version}"`, mine, changed, choice })
        return
      }
      const fe = fieldErrors(e) as Partial<Record<FieldName, string>>
      setErrors(fe)
      setMessage({
        text: e instanceof ApiError
          ? e.status === 403
            ? 'No tienes permiso para editar expedientes.'
            : e.message
          : 'No se pudo guardar. Revisa tu conexión e intenta de nuevo.',
        error: true,
      })
    } finally {
      setSaving(false)
    }
  }

  function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (!form || !refiner || !etag || saving) return
    const v = validate(form)
    setErrors(v)
    if (Object.keys(v).length) return
    const patch = diff(toForm(refiner), form)
    if (Object.keys(patch).length === 0) {
      setMessage({ text: 'No hay cambios que guardar.', error: false })
      return
    }
    void send(patch, etag, form, refiner)
  }

  function resolveConflict() {
    if (!conflict) return
    const serverForm = toForm(conflict.server)
    const merged: Form = { ...serverForm }
    for (const f of conflict.changed) if (conflict.choice[f] === 'mine') merged[f] = conflict.mine[f]
    setForm(merged)
    const patch = diff(serverForm, merged)
    if (Object.keys(patch).length === 0) {
      setConflict(null)
      setMessage({ text: 'Te quedaste con la versión del servidor. No hubo que guardar nada.', error: false })
      return
    }
    void send(patch, conflict.etag, merged, conflict.server)
  }

  if (!validId) return <main className="p-6"><p role="alert">Id de expediente inválido.</p></main>
  if (loadError) {
    return (
      <main className="p-6">
        <p role="alert">{loadError}</p>
        <Link to="/refiners" className="underline">Volver al directorio</Link>
      </main>
    )
  }
  if (!refiner || !form) return <main className="p-6" aria-busy="true">Cargando expediente…</main>

  const depName = (idStr: string) => departments.find((d) => String(d.id) === idStr)?.name ?? `#${idStr}`
  const show = (f: FieldName, v: string) => (f === 'departmentId' ? depName(v) : v || '(vacío)')

  return (
    <main className="mx-auto max-w-2xl p-4 text-slate-100">
      <Link to="/refiners" className="text-sm underline">← Directorio</Link>
      <h1 className="mt-1 text-2xl font-semibold">Editar expediente: {refiner.fullName}</h1>
      <p className="text-xs text-slate-400">Versión {refiner.version}</p>

      {remoteVersion !== null && remoteVersion > refiner.version && !conflict && (
        <div role="alert" className="mt-3 rounded border border-amber-600 bg-amber-950/40 p-3 text-sm">
          Alguien cambió este expediente mientras lo editabas (versión {remoteVersion}). Si guardas ahora verás
          el conflicto campo por campo; también puedes recargar y perder tus cambios.
          <button
            type="button"
            onClick={() => {
              setRemoteVersion(null)
              void load()
            }}
            className="ml-2 underline"
          >
            Recargar
          </button>
        </div>
      )}

      {conflict ? (
        <section role="alertdialog" aria-labelledby="conf-title" className="mt-4 rounded border border-amber-600 bg-amber-950/40 p-4">
          <h2 id="conf-title" className="text-lg font-semibold">Conflicto: alguien cambió el expediente</h2>
          <p className="text-sm text-amber-200">
            Mientras editabas, se guardó la versión {conflict.server.version}. Elige qué valor conservar en cada campo.
          </p>
          {conflict.changed.length === 0 && <p className="mt-2 text-sm">No habías cambiado ningún campo.</p>}
          {conflict.changed.map((f) => {
            const serverForm = toForm(conflict.server)
            return (
              <fieldset key={f} className="mt-3 rounded border border-slate-700 p-2">
                <legend className="px-1 font-medium">{LABELS[f]}</legend>
                <label className="flex gap-2 text-sm">
                  <input
                    type="radio"
                    name={`c-${f}`}
                    checked={conflict.choice[f] === 'mine'}
                    onChange={() => setConflict({ ...conflict, choice: { ...conflict.choice, [f]: 'mine' } })}
                  />
                  <span><strong>Lo que escribiste:</strong> <span className="whitespace-pre-wrap">{show(f, conflict.mine[f])}</span></span>
                </label>
                <label className="mt-1 flex gap-2 text-sm">
                  <input
                    type="radio"
                    name={`c-${f}`}
                    checked={conflict.choice[f] === 'server'}
                    onChange={() => setConflict({ ...conflict, choice: { ...conflict.choice, [f]: 'server' } })}
                  />
                  <span><strong>Lo que hay ahora:</strong> <span className="whitespace-pre-wrap">{show(f, serverForm[f])}</span></span>
                </label>
              </fieldset>
            )
          })}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={resolveConflict}
              className="rounded bg-teal-600 px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              {saving ? 'Guardando…' : 'Guardar con estas elecciones'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setForm(toForm(conflict.server))
                setConflict(null)
              }}
              className="rounded border border-slate-600 px-4 py-2"
            >
              Descartar mis cambios
            </button>
          </div>
        </section>
      ) : (
        <form onSubmit={onSubmit} noValidate className="mt-4 flex flex-col gap-4">
          {(['title', 'extension'] as const).map((f) => (
            <label key={f} className="flex flex-col text-sm">
              {LABELS[f]}
              <input
                value={form[f]}
                onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                inputMode={f === 'extension' ? 'numeric' : undefined}
                aria-invalid={Boolean(errors[f])}
                aria-describedby={errors[f] ? `err-${f}` : undefined}
                className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
              />
              {errors[f] && <span id={`err-${f}`} className="text-red-300">{errors[f]}</span>}
            </label>
          ))}
          <label className="flex flex-col text-sm">
            {LABELS.departmentId}
            <select
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
              aria-invalid={Boolean(errors.departmentId)}
              className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
            >
              {departments.length === 0 && <option value={form.departmentId}>{refiner.department.name}</option>}
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {errors.departmentId && <span className="text-red-300">{errors.departmentId}</span>}
          </label>
          <label className="flex flex-col text-sm">
            {LABELS.bio}
            <textarea
              rows={5}
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value })}
              aria-invalid={Boolean(errors.bio)}
              aria-describedby={errors.bio ? 'err-bio' : undefined}
              className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
            />
            {errors.bio && <span id="err-bio" className="text-red-300">{errors.bio}</span>}
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-teal-600 px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void load()}
              className="rounded border border-slate-600 px-4 py-2"
            >
              Recargar del servidor
            </button>
          </div>
        </form>
      )}

      {message && (
        <p role={message.error ? 'alert' : 'status'} className={`mt-3 rounded p-2 text-sm ${message.error ? 'bg-red-950 text-red-200' : 'bg-slate-800'}`}>
          {message.text}
        </p>
      )}
    </main>
  )
}
