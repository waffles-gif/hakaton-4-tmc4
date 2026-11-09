import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  BIN_CHAR, binFor, cellFromTile, cellKey, findGroup, isNoise, isScary, tileOfCell, type GroupResult,
} from './gridLogic'
import { ApiError, apiResponse, backoffMs, getJson, isRetryable, sleep } from './http'
import { TileStore } from './tileStore'
import { BINS, type Bin, type LumonFile, type Progress, type RefineResult, type Rules } from './types'

const CELL = 24 // px
const MAX_DOM_CELLS = 2500
const OVERSCAN = 2

const BIN_NAME: Record<Bin, string> = { WO: 'WO', FC: 'FC', DR: 'DR', MA: 'MA' }
const BIN_COLOR: Record<string, string> = {
  W: 'bg-sky-900 text-sky-200',
  F: 'bg-amber-900 text-amber-200',
  D: 'bg-violet-900 text-violet-200',
  M: 'bg-rose-900 text-rose-200',
}

export default function RefinePage() {
  const { id } = useParams()
  const fileId = Number(id)
  const validId = Number.isInteger(fileId) && fileId > 0
  const [file, setFile] = useState<LumonFile | null>(null)
  const [rules, setRules] = useState<Rules | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!validId) return
    const ctrl = new AbortController()
    setFile(null)
    setRules(null)
    setError(null)
    Promise.all([
      getJson<LumonFile>(`/files/${fileId}`, ctrl.signal),
      getJson<Rules>(`/files/${fileId}/rules`, ctrl.signal),
    ])
      .then(([f, r]) => {
        setFile(f)
        setRules(r)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        setError(e instanceof ApiError && e.status === 404 ? 'Ese archivo no existe.' : 'No se pudo cargar el archivo.')
      })
    return () => ctrl.abort()
  }, [fileId, validId])

  if (!validId || error) {
    return (
      <main className="p-6 text-slate-100">
        <p role="alert">{error ?? 'Id de archivo inválido.'}</p>
        <Link to="/files" className="underline">Volver a los archivos</Link>
      </main>
    )
  }
  if (!file || !rules) {
    return <main className="p-6 text-slate-300" aria-busy="true">Cargando archivo…</main>
  }
  return <RefineGrid key={file.id} file={file} rules={rules} />
}

type Selection =
  | { kind: 'none' }
  | { kind: 'loading'; r: number; c: number }
  | { kind: 'empty'; message: string }
  | { kind: 'group'; group: GroupResult; noise: boolean; bin: Bin; refined: boolean }

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function RefineGrid({ file, rules }: { file: LumonFile; rules: Rules }) {
  const { rows, cols, tileSize } = file
  const [sp, setSp] = useSearchParams()

  const store = useMemo(() => new TileStore(file.id), [file.id])
  useEffect(() => {
    store.activate()
    return () => store.dispose()
  }, [store])
  useSyncExternalStore(store.subscribe, store.getVersion)

  // ---------- posición inicial desde ?r=&c= (saneada) ----------
  const initial = useRef(() => {
    const r = Number(sp.get('r'))
    const c = Number(sp.get('c'))
    return {
      r: Number.isInteger(r) ? clamp(r, 0, rows - 1) : 0,
      c: Number.isInteger(c) ? clamp(c, 0, cols - 1) : 0,
    }
  }).current()

  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: initial.r * CELL, left: initial.c * CELL, w: 800, h: 560 })
  const [focus, setFocus] = useState(initial)
  const focusByKey = useRef(false)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = initial.r * CELL
    el.scrollLeft = initial.c * CELL
    const ro = new ResizeObserver(() => {
      setView((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight }))
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- scroll → ventana visible + URL (replace: no llena el historial) ----------
  const raf = useRef(0)
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      setView((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }))
    })
    if (urlTimer.current) clearTimeout(urlTimer.current)
    urlTimer.current = setTimeout(() => {
      const r = clamp(Math.floor(el.scrollTop / CELL), 0, rows - 1)
      const c = clamp(Math.floor(el.scrollLeft / CELL), 0, cols - 1)
      setSp((prev) => {
        const next = new URLSearchParams(prev)
        next.set('r', String(r))
        next.set('c', String(c))
        return next
      }, { replace: true })
    }, 250)
  }
  useEffect(() => () => {
    cancelAnimationFrame(raf.current)
    if (urlTimer.current) clearTimeout(urlTimer.current)
  }, [])

  // ---------- virtualización: rango de filas/columnas en el DOM (≤ 2500 celdas) ----------
  const visRows = Math.ceil(view.h / CELL) + 1
  const visCols = Math.ceil(view.w / CELL) + 1
  let ov = OVERSCAN
  while (ov > 0 && (visRows + 2 * ov) * (visCols + 2 * ov) > MAX_DOM_CELLS - 1) ov--
  const firstRow = Math.floor(view.top / CELL)
  const firstCol = Math.floor(view.left / CELL)
  const r0 = clamp(firstRow - ov, 0, rows)
  const c0 = clamp(firstCol - ov, 0, cols)
  let r1 = clamp(firstRow + visRows + ov, 0, rows)
  let c1 = clamp(firstCol + visCols + ov, 0, cols)
  // Pantallas gigantes: recortar hasta respetar el máximo (deja 1 lugar para la celda con foco).
  while ((r1 - r0) * (c1 - c0) > MAX_DOM_CELLS - 1) {
    if (r1 - r0 > c1 - c0) r1--
    else c1--
  }

  // ---------- pedir solo los tiles visibles; cancelar los que salieron ----------
  const tr0 = Math.floor(r0 / tileSize)
  const tr1 = Math.floor(Math.max(r0, r1 - 1) / tileSize)
  const tc0 = Math.floor(c0 / tileSize)
  const tc1 = Math.floor(Math.max(c0, c1 - 1) / tileSize)
  useEffect(() => {
    const keys: Array<[number, number]> = []
    for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) keys.push([tr, tc])
    store.want(keys)
  }, [store, tr0, tr1, tc0, tc1])

  // ---------- selección de grupo ----------
  const [selection, setSelection] = useState<Selection>({ kind: 'none' })
  const selToken = useRef(0)
  const selectedSet = useMemo(() => {
    const s = new Set<string>()
    if (selection.kind === 'group') for (const { r, c } of selection.group.cells) s.add(cellKey(r, c))
    return s
  }, [selection])

  const selectAt = useCallback(async (r: number, c: number) => {
    const token = ++selToken.current
    setSelection({ kind: 'loading', r, c })
    try {
      const group = await findGroup(r, c, rows, cols, rules, async (rr, cc) => {
        const { tr, tc } = tileOfCell(rr, cc, tileSize)
        const t = store.get(tr, tc) ?? (await store.ensure(tr, tc, true))
        return cellFromTile(t, rr, cc)
      })
      if (token !== selToken.current) return
      if (!group) {
        setSelection({ kind: 'empty', message: 'Esa celda no da miedo.' })
        return
      }
      setSelection({
        kind: 'group',
        group,
        noise: isNoise(group, rules),
        bin: binFor(group, rules),
        refined: group.alreadyRefined,
      })
    } catch {
      if (token !== selToken.current) return
      setSelection({ kind: 'empty', message: 'No se pudieron cargar los bloques del grupo. Intenta de nuevo.' })
    }
  }, [rows, cols, rules, tileSize, store])

  // ---------- refinar (idempotente por intención) ----------
  const [progress, setProgress] = useState<Progress>(file.progress)
  const [stats, setStats] = useState({ refinedGroups: file.refinedGroups, totalGroups: file.totalGroups, mistakes: file.mistakes, status: file.status })
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [sending, setSending] = useState(false)
  /** firma de la intención (caja + celdas) → Idempotency-Key. Se reutiliza en todo reintento. */
  const intentKeys = useRef(new Map<string, string>())
  const inFlight = useRef<string | null>(null)

  const refine = useCallback(async (bin: Bin) => {
    if (selection.kind !== 'group') {
      setMessage({ text: 'Primero elige una celda que dé miedo para seleccionar su grupo.', error: true })
      return
    }
    if (selection.noise) {
      setMessage({ text: 'Ese grupo es ruido: no se puede refinar.', error: true })
      return
    }
    if (selection.refined) {
      setMessage({ text: 'Ese grupo ya está refinado.', error: true })
      return
    }
    const cells = selection.group.cells
    const sig = `${bin}|${cells.map((x) => cellKey(x.r, x.c)).sort().join(',')}`
    if (inFlight.current === sig) return // doble clic / doble Enter: misma intención en curso
    let key = intentKeys.current.get(sig)
    if (!key) {
      key = crypto.randomUUID()
      intentKeys.current.set(sig, key)
    }
    inFlight.current = sig
    setSending(true)
    setMessage({ text: `Enviando el grupo a ${BIN_NAME[bin]}…`, error: false })
    const body = { bin, cells }

    try {
      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await apiResponse(`/files/${file.id}/refinements`, {
            method: 'POST',
            headers: { 'Idempotency-Key': key },
            body,
          })
        } catch (e) {
          if (e instanceof ApiError) {
            if (isRetryable(e) && attempt < 6) {
              // Caos: el refinamiento puede estar ya guardado → misma key tras Retry-After.
              setMessage({ text: 'Lumon no responde, reintentando con la misma intención…', error: false })
              await sleep(backoffMs(attempt, e.retryAfter))
              continue
            }
            handleRefineError(e)
            return
          }
          // Error de red: puede que se haya guardado. Reintentar con la MISMA key.
          if (attempt >= 5) throw new Error('NETWORK')
          setMessage({ text: 'Sin conexión, reintentando con la misma intención…', error: false })
          await sleep(backoffMs(attempt, null))
          continue
        }

        {
          const result = (await res.json()) as RefineResult
          const replayed = res.headers.get('Idempotent-Replayed') === 'true'
          store.markBins(cells, BIN_CHAR[bin], tileSize)
          setProgress(result.file.progress)
          setStats(result.file)
          intentKeys.current.delete(sig)
          setSelection({ kind: 'none' })
          setMessage({
            text: `Grupo de ${result.size} celdas refinado en ${BIN_NAME[bin]}${replayed ? ' (confirmado tras reintento)' : ''}.`,
            error: false,
          })
          return
        }
      }
    } catch {
      setMessage({ text: 'No se pudo refinar por la red. Vuelve a intentarlo: no se refinará dos veces.', error: true })
    } finally {
      inFlight.current = null
      setSending(false)
    }

    function handleRefineError(err: ApiError) {
      const d = (err.details ?? {}) as Record<string, unknown>
      if (err.code === 'ALREADY_REFINED') {
        const tiles = Array.isArray(d.tiles) ? (d.tiles as Array<[number, number]>) : []
        store.invalidate(tiles)
        setSelection({ kind: 'none' })
        setMessage({ text: 'Alguien ya refinó parte de ese grupo. Actualicé los bloques: vuelve a elegirlo.', error: true })
      } else if (err.code === 'GROUP_CLAIMED') {
        const holder = (d.holder as { displayName?: string } | undefined)?.displayName ?? 'otro refinador'
        setMessage({ text: `${holder} tiene reservado ese grupo. Espera a que lo libere.`, error: true })
      } else if (err.code === 'WRONG_BIN') {
        setStats((s) => ({ ...s, mistakes: typeof d.mistakes === 'number' ? d.mistakes : s.mistakes + 1 }))
        setMessage({ text: `${BIN_NAME[bin]} no es la caja correcta. Revisa la caja sugerida.`, error: true })
      } else if (err.code === 'GROUP_INVALID') {
        const reasons: Record<string, string> = {
          BELOW_THRESHOLD: 'Hay celdas que no dan miedo.',
          NOT_CONNECTED: 'Las celdas no forman un solo grupo.',
          INCOMPLETE: `Faltan ${String(d.missing ?? '')} celdas del grupo. Vuelve a seleccionarlo.`,
          SIZE_OUT_OF_RANGE: 'Ese grupo es ruido.',
        }
        setMessage({ text: reasons[String(d.reason)] ?? err.message, error: true })
      } else if (err.status === 403) {
        setMessage({ text: 'No tienes permiso para refinar (files:refine).', error: true })
      } else {
        setMessage({ text: err.message || 'Error al refinar.', error: true })
      }
    }
  }, [selection, file.id, store, tileSize])

  // ---------- teclado ----------
  const moveFocus = (r: number, c: number) => {
    const nr = clamp(r, 0, rows - 1)
    const nc = clamp(c, 0, cols - 1)
    focusByKey.current = true
    setFocus({ r: nr, c: nc })
    const el = scroller.current
    if (!el) return
    const y = nr * CELL
    const x = nc * CELL
    if (y < el.scrollTop) el.scrollTop = y
    else if (y + CELL > el.scrollTop + el.clientHeight) el.scrollTop = y + CELL - el.clientHeight
    if (x < el.scrollLeft) el.scrollLeft = x
    else if (x + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = x + CELL - el.clientWidth
  }

  useEffect(() => {
    if (!focusByKey.current) return
    focusByKey.current = false
    scroller.current
      ?.querySelector<HTMLElement>(`[data-cell="${focus.r}:${focus.c}"]`)
      ?.focus({ preventScroll: true })
  }, [focus])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(view.h / CELL) - 1)
    const { r, c } = focus
    switch (e.key) {
      case 'ArrowUp': moveFocus(r - 1, c); break
      case 'ArrowDown': moveFocus(r + 1, c); break
      case 'ArrowLeft': moveFocus(r, c - 1); break
      case 'ArrowRight': moveFocus(r, c + 1); break
      case 'PageUp': moveFocus(r - page, c); break
      case 'PageDown': moveFocus(r + page, c); break
      case 'Home': moveFocus(e.ctrlKey ? 0 : r, 0); break
      case 'End': moveFocus(e.ctrlKey ? rows - 1 : r, cols - 1); break
      case 'Enter':
      case ' ':
        void selectAt(r, c)
        break
      case '1': case '2': case '3': case '4':
        void refine(BINS[Number(e.key) - 1]!)
        break
      default:
        return
    }
    e.preventDefault()
  }

  // ---------- arrastrar el grupo a una caja (Pointer Events) ----------
  const [drag, setDrag] = useState<{ x: number; y: number; over: Bin | null } | null>(null)
  const binAt = (x: number, y: number): Bin | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bin]')
    const b = el?.dataset.bin
    return b && (BINS as readonly string[]).includes(b) ? (b as Bin) : null
  }
  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (selection.kind !== 'group') return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x: e.clientX, y: e.clientY, over: null })
  }
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    setDrag({ x: e.clientX, y: e.clientY, over: binAt(e.clientX, e.clientY) })
  }
  const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    const target = binAt(e.clientX, e.clientY)
    setDrag(null)
    if (target) void refine(target)
  }

  // ---------- render ----------
  const complete = stats.status === 'COMPLETE' || progress.overall >= 1
  if (complete) {
    return (
      <main className="flex min-h-[70vh] flex-col items-center justify-center gap-4 p-6 text-slate-100">
        <h1 className="text-3xl font-semibold">Archivo completado</h1>
        <p>{file.name}: {stats.refinedGroups} grupos refinados, {stats.mistakes} errores.</p>
        <p className="text-slate-400">Que cada número encuentre su caja.</p>
        <Link to="/files" className="underline">Volver a los archivos</Link>
      </main>
    )
  }

  const rowEls = []
  const focusInRange = focus.r >= r0 && focus.r < r1 && focus.c >= c0 && focus.c < c1
  for (let r = r0; r < r1; r++) {
    const cells = []
    for (let c = c0; c < c1; c++) cells.push(renderCell(r, c))
    rowEls.push(
      <div key={r} role="row" aria-rowindex={r + 1} className="absolute left-0" style={{ top: r * CELL, height: CELL }}>
        {cells}
      </div>,
    )
  }
  if (!focusInRange) {
    // La celda con foco siempre está en el DOM aunque se haya hecho scroll lejos.
    rowEls.push(
      <div key="focus" role="row" aria-rowindex={focus.r + 1} className="absolute left-0" style={{ top: focus.r * CELL, height: CELL }}>
        {renderCell(focus.r, focus.c)}
      </div>,
    )
  }

  function renderCell(r: number, c: number) {
    const { tr, tc } = tileOfCell(r, c, tileSize)
    const tile = store.get(tr, tc)
    const isFocus = focus.r === r && focus.c === c
    const style = { left: c * CELL, width: CELL, height: CELL } as Record<string, string | number>
    if (!tile) {
      return (
        <div
          key={c}
          role="gridcell"
          aria-colindex={c + 1}
          aria-busy="true"
          data-cell={`${r}:${c}`}
          tabIndex={isFocus ? 0 : -1}
          onFocus={() => !isFocus && setFocus({ r, c })}
          className="absolute top-0 border border-slate-900 bg-slate-800/60"
          style={style}
        />
      )
    }
    const info = cellFromTile(tile, r, c)
    const scary = isScary(info.tremor, rules)
    const selected = selectedSet.has(cellKey(r, c))
    if (scary && info.bin === '.') {
      style['--a'] = `${(info.tremor / 100) * 1.5}px`
      style['--d'] = `${Math.max(0.15, 1.1 - info.tremor / 100)}s`
    }
    return (
      <div
        key={c}
        role="gridcell"
        aria-colindex={c + 1}
        aria-selected={selected}
        aria-label={`${info.value}${scary ? ', da miedo' : ''}${info.bin !== '.' ? `, en caja ${info.bin}` : ''}`}
        data-cell={`${r}:${c}`}
        tabIndex={isFocus ? 0 : -1}
        onFocus={() => !isFocus && setFocus({ r, c })}
        onClick={() => {
          setFocus({ r, c })
          void selectAt(r, c)
        }}
        className={[
          'absolute top-0 flex select-none items-center justify-center font-mono text-xs cursor-pointer',
          info.bin !== '.' ? BIN_COLOR[info.bin] ?? '' : scary ? 'mdr-scary text-teal-200' : 'text-slate-400',
          selected ? 'outline outline-2 -outline-offset-2 outline-yellow-300 bg-yellow-900/40' : '',
          isFocus ? 'ring-2 ring-inset ring-white' : '',
        ].join(' ')}
        style={style}
      >
        {info.value}
      </div>
    )
  }

  return (
    <main className="flex flex-col gap-3 p-4 text-slate-100">
      <style>{`
        @keyframes mdr-shake { 0%,100% { transform: translate(0,0) } 25% { transform: translate(var(--a),0) } 75% { transform: translate(calc(var(--a) * -1),0) } }
        .mdr-scary { animation: mdr-shake var(--d) linear infinite; font-weight: 700 }
        @media (prefers-reduced-motion: reduce) { .mdr-scary { animation: none; text-decoration: underline; } }
      `}</style>

      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to="/files" className="text-sm underline">← Archivos</Link>
          <h1 className="text-xl font-semibold">{file.name}</h1>
          <p className="text-xs text-slate-400">
            {rows} × {cols} · {stats.refinedGroups}/{stats.totalGroups} grupos · {stats.mistakes} errores ·
            umbral {rules.tremorThreshold}, conectividad {rules.connectivity}, grupos de {rules.minGroupSize} a {rules.maxGroupSize}
          </p>
        </div>
        {store.isBlocked() && (
          <p role="status" className="rounded bg-amber-950 px-2 py-1 text-xs text-amber-200">
            Demasiadas solicitudes: esperando antes de pedir más bloques…
          </p>
        )}
      </header>

      <div className="flex flex-col gap-3 lg:flex-row">
        <div
          ref={scroller}
          role="grid"
          aria-label={`Grilla de ${file.name}`}
          aria-rowcount={rows}
          aria-colcount={cols}
          aria-multiselectable="true"
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          className="relative h-[70vh] min-w-0 shrink-0 overflow-auto rounded border border-slate-700 bg-slate-950 lg:flex-1"
        >
          <div role="presentation" className="relative" style={{ height: rows * CELL, width: cols * CELL }}>
            {rowEls}
          </div>
        </div>

        <aside className="flex w-full flex-col gap-3 lg:w-72" aria-label="Grupo y cajas">
          <section className="rounded border border-slate-700 p-3" aria-live="polite">
            <h2 className="mb-1 font-semibold">Grupo seleccionado</h2>
            {selection.kind === 'none' && <p className="text-sm text-slate-400">Haz clic o pulsa Enter sobre un número que tiemble.</p>}
            {selection.kind === 'loading' && <p className="text-sm">Buscando el grupo completo…</p>}
            {selection.kind === 'empty' && <p className="text-sm">{selection.message}</p>}
            {selection.kind === 'group' && (
              <div
                onPointerDown={onDragStart}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={() => setDrag(null)}
                className="cursor-grab touch-none rounded bg-slate-800 p-2 text-sm"
              >
                <p>
                  Tamaño: {selection.group.truncated ? `más de ${rules.maxGroupSize}` : selection.group.cells.length} celdas
                </p>
                {selection.refined ? (
                  <p>Ya está refinado.</p>
                ) : selection.noise ? (
                  <p className="text-amber-300">Es ruido: no se puede refinar.</p>
                ) : (
                  <p>
                    Caja según las reglas: <strong>{BIN_NAME[selection.bin]}</strong>
                  </p>
                )}
                {!selection.noise && !selection.refined && (
                  <p className="mt-1 text-xs text-slate-400">Arrástralo a una caja, o pulsa 1–4 / los botones.</p>
                )}
              </div>
            )}
          </section>

          <section className="grid grid-cols-2 gap-2" aria-label="Cajas">
            {BINS.map((b, i) => (
              <button
                key={b}
                type="button"
                data-bin={b}
                disabled={sending}
                onClick={() => void refine(b)}
                aria-keyshortcuts={String(i + 1)}
                className={`rounded border p-2 text-left text-sm ${drag?.over === b ? 'border-yellow-300 bg-yellow-900/40' : 'border-slate-600'} disabled:opacity-60`}
              >
                <span className="font-semibold">{BIN_NAME[b]}</span> <span className="text-xs text-slate-400">({i + 1})</span>
                <div className="mt-1 h-2 rounded bg-slate-800" role="progressbar" aria-label={`Progreso ${b}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress[b] * 100)}>
                  <div className="h-2 rounded bg-teal-500" style={{ width: `${progress[b] * 100}%` }} />
                </div>
                <span className="text-xs">{Math.round(progress[b] * 100)}%</span>
              </button>
            ))}
          </section>

          <p className="text-sm">Total: {Math.round(progress.overall * 100)}%</p>

          {message && (
            <p role={message.error ? 'alert' : 'status'} className={`rounded p-2 text-sm ${message.error ? 'bg-red-950 text-red-200' : 'bg-slate-800'}`}>
              {message.text}
            </p>
          )}
        </aside>
      </div>

      {drag && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded bg-yellow-400 px-2 py-1 text-xs font-semibold text-black"
          style={{ left: drag.x + 8, top: drag.y + 8 }}
        >
          Grupo ({selection.kind === 'group' ? selection.group.cells.length : 0})
        </div>
      )}
    </main>
  )
}
