import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, apiResponse } from '../../lib/api'
import type { Refiner } from '../refiners/types'
import { LIMITS, MediaError, decodeImage, mediaErrorText, renderWebp, uploadPrepared, type Media } from './media'

// Editor de fotocheck: elegir (selector, arrastrar o pegar) → recorte cuadrado con arrastre y zoom (también
// con teclado) → WebP 512×512 ≤120 KB sin metadatos → subida con progreso, cancelar y reintentar →
// PATCH del expediente con If-Match (Regla de Milchick: ante 412 se muestra el conflicto, nunca en silencio).

const VIEW = 320 // lado del visor en px

type Upload =
  | { state: 'idle' }
  | { state: 'working'; label: string; progress: number | null }
  | { state: 'error'; message: string }
  | { state: 'done'; media: Media }

type Save =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'conflict'; current: Refiner; etag: string }
  | { state: 'error'; message: string }
  | { state: 'saved' }

export default function BadgeEditorPage() {
  const { id } = useParams()
  const refinerId = Number(id)
  const validId = Number.isInteger(refinerId) && refinerId > 0

  const [refiner, setRefiner] = useState<Refiner | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1) // 1 = el lado menor llena el visor
  const [offset, setOffset] = useState({ x: 0, y: 0 }) // centro del recorte, en px del visor respecto al centro
  const [upload, setUpload] = useState<Upload>({ state: 'idle' })
  const [save, setSave] = useState<Save>({ state: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Cargar el expediente con su ETag.
  useEffect(() => {
    if (!validId) return
    const ctrl = new AbortController()
    apiResponse(`/refiners/${refinerId}`, { signal: ctrl.signal })
      .then(async (res) => {
        const r = (await res.json()) as Refiner
        setRefiner(r)
        setEtag(res.headers.get('ETag') ?? `"${r.version}"`)
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setLoadError(e instanceof ApiError ? e.message : 'No se pudo cargar el expediente.')
      })
    return () => ctrl.abort()
  }, [refinerId, validId])

  // Geometría: escala base para que el lado menor llene el visor.
  const base = bitmap ? VIEW / Math.min(bitmap.width, bitmap.height) : 1
  const scale = base * zoom
  const clampOffset = useCallback(
    (o: { x: number; y: number }, z: number) => {
      if (!bitmap) return o
      const s = base * z
      const maxX = Math.max(0, (bitmap.width * s - VIEW) / 2)
      const maxY = Math.max(0, (bitmap.height * s - VIEW) / 2)
      return { x: Math.min(maxX, Math.max(-maxX, o.x)), y: Math.min(maxY, Math.max(-maxY, o.y)) }
    },
    [bitmap, base],
  )

  // Dibujar la vista previa.
  useEffect(() => {
    const cv = canvasRef.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    ctx.clearRect(0, 0, VIEW, VIEW)
    if (!bitmap) return
    const w = bitmap.width * scale
    const h = bitmap.height * scale
    ctx.drawImage(bitmap, VIEW / 2 - w / 2 + offset.x, VIEW / 2 - h / 2 + offset.y, w, h)
  }, [bitmap, scale, offset])

  async function pick(file: File | null | undefined) {
    if (!file) return
    setPickError(null)
    setUpload({ state: 'idle' })
    setSave({ state: 'idle' })
    try {
      const bmp = await decodeImage(file)
      if (bitmap) bitmap.close()
      setBitmap(bmp)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
    } catch (e) {
      setPickError(e instanceof MediaError ? e.message : 'No se pudo leer la imagen.')
    }
  }

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    void pick(e.dataTransfer.files[0])
  }
  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      void pick(file)
    }
  }

  // Arrastre del recorte con Pointer Events.
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!bitmap) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset(clampOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }, zoom))
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  const setZoomClamped = (z: number) => {
    const nz = Math.min(4, Math.max(1, z))
    setZoom(nz)
    setOffset((o) => clampOffset(o, nz))
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (!bitmap) return
    const step = e.shiftKey ? 40 : 10
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const m = moves[e.key]
    if (m) {
      e.preventDefault()
      setOffset((o) => clampOffset({ x: o.x + m[0], y: o.y + m[1] }, zoom))
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      setZoomClamped(zoom + 0.1)
    } else if (e.key === '-') {
      e.preventDefault()
      setZoomClamped(zoom - 0.1)
    }
  }

  async function startUpload() {
    if (!bitmap) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setSave({ state: 'idle' })
    try {
      setUpload({ state: 'working', label: 'Preparando imagen…', progress: null })
      // Recorte en píxeles de la imagen original.
      const side = VIEW / scale
      const cx = bitmap.width / 2 - offset.x / scale
      const cy = bitmap.height / 2 - offset.y / scale
      const crop = { sx: cx - side / 2, sy: cy - side / 2, sw: side, sh: side }
      const img = await renderWebp(bitmap, crop, LIMITS.BADGE.size, LIMITS.BADGE.size, LIMITS.BADGE.maxBytes)
      setUpload({ state: 'working', label: 'Subiendo…', progress: 0 })
      const media = await uploadPrepared(
        'BADGE',
        img,
        (p) => setUpload({ state: 'working', label: p < 1 ? 'Subiendo…' : 'Confirmando…', progress: p }),
        ctrl.signal,
      )
      setUpload({ state: 'done', media })
      await saveBadge(media.mediaId, etag)
    } catch (e) {
      setUpload({ state: 'error', message: mediaErrorText(e) })
    }
  }

  async function saveBadge(mediaId: number, ifMatch: string | null) {
    if (!ifMatch) return
    setSave({ state: 'saving' })
    try {
      const res = await apiResponse(`/refiners/${refinerId}`, {
        method: 'PATCH',
        body: { badgeMediaId: mediaId },
        headers: { 'If-Match': ifMatch },
      })
      const r = (await res.json()) as Refiner
      setRefiner(r)
      setEtag(res.headers.get('ETag') ?? `"${r.version}"`)
      setSave({ state: 'saved' })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        const d = e.details
        if (d && typeof d === 'object' && 'current' in d && d.current && typeof d.current === 'object') {
          const current = d.current as Refiner
          setSave({ state: 'conflict', current, etag: `"${current.version}"` })
          return
        }
      }
      setSave({ state: 'error', message: e instanceof ApiError ? e.message : 'No se pudo guardar el expediente.' })
    }
  }

  const uploadedId = upload.state === 'done' ? upload.media.mediaId : null

  if (!validId) return <main className="p-6">Expediente inválido.</main>
  if (loadError) return <main className="p-6 text-red-300" role="alert">{loadError}</main>
  if (!refiner) return <main className="p-6" role="status">Cargando expediente…</main>

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link to="/refiners" className="text-teal-300 underline">
        ← Expedientes
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Fotocheck de {refiner.fullName}</h1>

      <div className="mt-4 flex flex-wrap gap-6">
        <section aria-labelledby="actual" className="w-40">
          <h2 id="actual" className="text-sm font-medium text-slate-300">
            Actual
          </h2>
          <div className="mt-2 h-40 w-40 overflow-hidden rounded bg-slate-800">
            {refiner.badge ? (
              <img
                src={refiner.badge.url}
                width={160}
                height={160}
                alt={`Fotocheck actual de ${refiner.fullName}`}
                className="h-40 w-40 object-cover"
              />
            ) : (
              <p className="grid h-40 place-items-center text-sm text-slate-500">Sin fotocheck</p>
            )}
          </div>
        </section>

        <section aria-labelledby="nuevo" className="flex flex-col gap-3">
          <h2 id="nuevo" className="text-sm font-medium text-slate-300">
            Nuevo
          </h2>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onPaste={onPaste}
            tabIndex={0}
            aria-label="Zona para soltar o pegar una imagen"
            className="rounded border border-dashed border-slate-500 p-3 text-sm text-slate-300 focus:border-teal-400 focus:outline-none"
          >
            <label className="cursor-pointer text-teal-300 underline">
              Elegir archivo
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </label>{' '}
            · o arrástrala aquí · o pégala (Ctrl/Cmd+V) con esta zona enfocada
          </div>
          {pickError && (
            <p role="alert" className="text-sm text-red-300">
              {pickError}
            </p>
          )}

          <canvas
            ref={canvasRef}
            width={VIEW}
            height={VIEW}
            tabIndex={bitmap ? 0 : -1}
            role="img"
            aria-label="Recorte cuadrado. Arrastra o usa las flechas para mover; + y − para el zoom."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            className="touch-none rounded bg-slate-800 outline-offset-2 focus:outline-2 focus:outline-teal-400"
            style={{ width: VIEW, height: VIEW, cursor: bitmap ? 'grab' : 'default' }}
          />
          <label className="flex items-center gap-2 text-sm">
            Zoom
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              disabled={!bitmap}
              onChange={(e) => setZoomClamped(Number(e.target.value))}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!bitmap || upload.state === 'working'}
              onClick={() => void startUpload()}
              className="rounded bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-500 disabled:opacity-50"
            >
              {upload.state === 'error' ? 'Reintentar' : 'Subir fotocheck'}
            </button>
            {upload.state === 'working' && (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="rounded border border-slate-600 px-4 py-2"
              >
                Cancelar
              </button>
            )}
          </div>

          {upload.state === 'working' && (
            <div role="status" aria-live="polite" className="text-sm">
              <p>{upload.label}</p>
              {upload.progress !== null && (
                <progress max={1} value={upload.progress} className="w-full" aria-label="Progreso de la subida">
                  {Math.round(upload.progress * 100)}%
                </progress>
              )}
            </div>
          )}
          {upload.state === 'error' && (
            <p role="alert" className="text-sm text-red-300">
              {upload.message}
            </p>
          )}

          {save.state === 'saving' && <p role="status">Guardando expediente…</p>}
          {save.state === 'saved' && (
            <p role="status" className="text-emerald-300">
              ¡Fotocheck actualizado!
            </p>
          )}
          {save.state === 'error' && (
            <div role="alert" className="text-sm text-red-300">
              <p>{save.message}</p>
              {uploadedId !== null && (
                <button type="button" className="underline" onClick={() => void saveBadge(uploadedId, etag)}>
                  Reintentar guardado
                </button>
              )}
            </div>
          )}
          {save.state === 'conflict' && uploadedId !== null && (
            <div role="alert" className="rounded border border-amber-500 p-3 text-sm">
              <p className="font-medium text-amber-200">
                El expediente cambió mientras subías la foto (versión {save.current.version}).
              </p>
              <p className="mt-1 text-slate-300">
                Ahora en el servidor: {save.current.title} · anexo {save.current.extension} ·{' '}
                {save.current.badge ? 'tiene otro fotocheck' : 'sin fotocheck'}. Solo se cambiaría el fotocheck.
              </p>
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  className="rounded bg-amber-600 px-3 py-1 text-white"
                  onClick={() => {
                    setRefiner(save.current)
                    setEtag(save.etag)
                    void saveBadge(uploadedId, save.etag)
                  }}
                >
                  Aplicar mi fotocheck sobre la versión actual
                </button>
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setRefiner(save.current)
                    setEtag(save.etag)
                    setSave({ state: 'idle' })
                  }}
                >
                  Descartar
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
