import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Field } from '../../components/Field'
import { ApiError, api, fieldErrors, sleep } from '../../lib/api'
import { mediaErrorText, prepareIncidentPhoto, uploadPrepared, type Media, type PreparedImage } from './media'

// Reporte de incidencia con 1 a 3 fotos: se suben en paralelo, cada una con su progreso, cancelar y reintentar.
// No se puede enviar hasta que todas estén confirmadas; un error al enviar no borra nada.

type Photo = {
  key: string
  name: string
  file: File
  prepared: PreparedImage | null
  state: 'preparing' | 'uploading' | 'confirmed' | 'error' | 'cancelled'
  progress: number
  media: Media | null
  error: string | null
}

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
type Severity = (typeof SEVERITIES)[number]
const SEVERITY_LABEL: Record<Severity, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' }

export default function IncidentNewPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('MEDIUM')
  const [fileId, setFileId] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const controllers = useRef(new Map<string, AbortController>())

  const patch = (key: string, p: Partial<Photo>) =>
    setPhotos((list) => list.map((ph) => (ph.key === key ? { ...ph, ...p } : ph)))

  async function runUpload(photo: Photo) {
    controllers.current.get(photo.key)?.abort()
    const ctrl = new AbortController()
    controllers.current.set(photo.key, ctrl)
    try {
      let prepared = photo.prepared
      if (!prepared) {
        patch(photo.key, { state: 'preparing', error: null, progress: 0 })
        prepared = await prepareIncidentPhoto(photo.file)
        patch(photo.key, { prepared })
      }
      patch(photo.key, { state: 'uploading', error: null, progress: 0 })
      const media = await uploadPrepared('INCIDENT', prepared, (p) => patch(photo.key, { progress: p }), ctrl.signal)
      patch(photo.key, { state: 'confirmed', media, progress: 1 })
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === 'AbortError'
      patch(photo.key, { state: cancelled ? 'cancelled' : 'error', error: mediaErrorText(e) })
    } finally {
      if (controllers.current.get(photo.key) === ctrl) controllers.current.delete(photo.key)
    }
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return
    const room = 3 - photos.length
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .slice(0, Math.max(0, room))
    const created: Photo[] = picked.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name || 'imagen',
      file,
      prepared: null,
      state: 'preparing',
      progress: 0,
      media: null,
      error: null,
    }))
    setPhotos((list) => [...list, ...created])
    for (const ph of created) void runUpload(ph) // en paralelo
  }

  function remove(key: string) {
    controllers.current.get(key)?.abort()
    setPhotos((list) => list.filter((p) => p.key !== key))
  }

  const allConfirmed = photos.length > 0 && photos.every((p) => p.state === 'confirmed' && p.media)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!allConfirmed || sending) return
    setSending(true)
    setErrors({})
    setFormError(null)
    const body = {
      title,
      description,
      severity,
      fileId: fileId ? Number(fileId) : null,
      mediaIds: photos.flatMap((p) => (p.media ? [p.media.mediaId] : [])),
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await api('/incidents', { method: 'POST', body })
          break
        } catch (err) {
          // 503 en modo caos: no se guardó nada → esperar y reintentar.
          if (err instanceof ApiError && err.status === 503 && attempt < 3) {
            await sleep(Math.max((err.retryAfter ?? 0) * 1000, 800 * 2 ** attempt))
            continue
          }
          throw err
        }
      }
      navigate('/incidents')
    } catch (err) {
      setErrors(fieldErrors(err))
      setFormError(
        err instanceof ApiError
          ? err.code === 'MEDIA_NOT_USABLE'
            ? 'Alguna foto ya no se puede usar (ya usada o inválida). Quítala y sube otra.'
            : err.message
          : 'No se pudo enviar. Tus datos y fotos siguen aquí: reintenta.',
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link to="/incidents" className="text-teal-300 underline">
        ← Incidencias
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Nuevo reporte de incidencia</h1>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4" noValidate>
        <Field
          label="Título"
          required
          minLength={3}
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="inc-desc" className="text-sm font-medium text-slate-200">
            Descripción
          </label>
          <textarea
            id="inc-desc"
            required
            maxLength={4000}
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={errors.description ? true : undefined}
            className="rounded border border-slate-600 bg-slate-900 px-3 py-2"
          />
          {errors.description && <p className="text-sm text-red-300">{errors.description}</p>}
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="inc-sev" className="text-sm font-medium text-slate-200">
              Severidad
            </label>
            <select
              id="inc-sev"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity)}
              className="rounded border border-slate-600 bg-slate-900 px-3 py-2"
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="ID de archivo (opcional)"
            inputMode="numeric"
            value={fileId}
            onChange={(e) => setFileId(e.target.value.replace(/\D/g, ''))}
            error={errors.fileId}
          />
        </div>

        <fieldset className="rounded border border-slate-700 p-3">
          <legend className="px-1 text-sm font-medium">Fotos (1 a 3)</legend>
          {photos.length < 3 && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }}
              onPaste={(e) => addFiles(e.clipboardData.files)}
              tabIndex={0}
              aria-label="Zona para soltar o pegar fotos"
              className="rounded border border-dashed border-slate-500 p-3 text-sm text-slate-300 focus:border-teal-400 focus:outline-none"
            >
              <label className="cursor-pointer text-teal-300 underline">
                Elegir fotos
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>{' '}
              · o arrástralas aquí · o pégalas
            </div>
          )}
          <ul className="mt-3 flex flex-col gap-2">
            {photos.map((p) => (
              <li key={p.key} className="rounded border border-slate-700 p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0">
                    {p.state === 'preparing' && 'Preparando…'}
                    {p.state === 'uploading' && `${Math.round(p.progress * 100)}%`}
                    {p.state === 'confirmed' && <span className="text-emerald-300">Confirmada ✔</span>}
                    {p.state === 'cancelled' && 'Cancelada'}
                    {p.state === 'error' && <span className="text-red-300">Error</span>}
                  </span>
                </div>
                {p.state === 'uploading' && (
                  <progress max={1} value={p.progress} className="mt-1 w-full" aria-label={`Progreso de ${p.name}`} />
                )}
                {p.error && p.state === 'error' && <p className="mt-1 text-red-300">{p.error}</p>}
                <div className="mt-1 flex gap-3">
                  {(p.state === 'uploading' || p.state === 'preparing') && (
                    <button type="button" className="underline" onClick={() => controllers.current.get(p.key)?.abort()}>
                      Cancelar
                    </button>
                  )}
                  {(p.state === 'error' || p.state === 'cancelled') && (
                    <button type="button" className="underline" onClick={() => void runUpload(p)}>
                      Reintentar
                    </button>
                  )}
                  <button type="button" className="underline" onClick={() => remove(p.key)}>
                    Quitar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </fieldset>

        {formError && (
          <p role="alert" className="text-sm text-red-300">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={!allConfirmed || sending}
          className="rounded bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-500 disabled:opacity-50"
        >
          {sending ? 'Enviando…' : allConfirmed ? 'Enviar reporte' : 'Esperando a que se confirmen las fotos…'}
        </button>
      </form>
    </main>
  )
}
