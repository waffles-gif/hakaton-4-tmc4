// Caché de tiles con: una sola request en vuelo por tile, cancelación de los que salen de la vista,
// bloqueo global durante Retry-After (429), reintento con espera creciente (503) y
// auto-limitación (40 tiles / 10 s por sesión según Swagger → usamos 36 para tener margen).
import { ApiError, apiResponse, backoffMs } from './http'
import { decodeTile, tileKey, type Tile } from './gridLogic'
import type { TileDto } from './types'

const WINDOW_MS = 10_000
const WINDOW_MAX = 36
const MAX_CONCURRENT = 6

interface Job {
  key: string
  tr: number
  tc: number
  /** Pedido por la selección de un grupo: no se cancela al hacer scroll. */
  pinned: boolean
  attempt: number
  notBefore: number
  controller: AbortController | null
  waiters: Array<{ resolve: (t: Tile) => void; reject: (e: unknown) => void }>
}

export class TileStore {
  private readonly fileId: number
  private tiles = new Map<string, Tile>()
  private jobs = new Map<string, Job>() // en cola o en vuelo
  private queue: string[] = []
  private active = 0
  private sentAt: number[] = []
  private blockedUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  private version = 0
  private disposed = false
  errorCount = 0

  constructor(fileId: number) {
    this.fileId = fileId
  }

  // --- suscripción para useSyncExternalStore ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = () => this.version
  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  get(tr: number, tc: number): Tile | undefined {
    return this.tiles.get(tileKey(tr, tc))
  }

  isBlocked() {
    return Date.now() < this.blockedUntil
  }

  /** Asegura un tile; devuelve el de caché o se une a la request en vuelo (nunca duplica). */
  ensure(tr: number, tc: number, pinned = false): Promise<Tile> {
    const key = tileKey(tr, tc)
    const cached = this.tiles.get(key)
    if (cached) return Promise.resolve(cached)
    return new Promise<Tile>((resolve, reject) => {
      let job = this.jobs.get(key)
      if (!job) {
        job = { key, tr, tc, pinned, attempt: 0, notBefore: 0, controller: null, waiters: [] }
        this.jobs.set(key, job)
        this.queue.push(key)
      }
      if (pinned) job.pinned = true
      job.waiters.push({ resolve, reject })
      this.pump()
    })
  }

  /** Pide (sin esperar) los tiles visibles y cancela los que ya no hacen falta. */
  want(keys: Array<[number, number]>) {
    const wanted = new Set(keys.map(([r, c]) => tileKey(r, c)))
    for (const [key, job] of this.jobs) {
      if (!wanted.has(key) && !job.pinned) this.cancel(job)
    }
    for (const [tr, tc] of keys) {
      this.ensure(tr, tc).catch(() => {})
    }
  }

  /** Tras 409 ALREADY_REFINED: tirar de caché y volver a pedir. */
  invalidate(keys: Array<[number, number]>) {
    for (const [tr, tc] of keys) this.tiles.delete(tileKey(tr, tc))
    this.emit()
    for (const [tr, tc] of keys) this.ensure(tr, tc).catch(() => {})
  }

  /** Marca celdas como refinadas localmente (sin volver a pedir la grilla). */
  markBins(cells: Array<{ r: number; c: number }>, ch: string, tileSize: number) {
    for (const { r, c } of cells) {
      const t = this.tiles.get(tileKey(Math.floor(r / tileSize), Math.floor(c / tileSize)))
      if (!t) continue
      const i = (r - t.originRow) * t.cols + (c - t.originCol)
      t.bins[i] = ch
    }
    this.emit()
  }

  /** Se llama al montar (StrictMode monta → desmonta → monta: hay que poder reactivar). */
  activate() {
    this.disposed = false
    this.pump()
  }

  /** Al desmontar: cancela todo lo pendiente. La caché se conserva. */
  dispose() {
    this.disposed = true
    for (const job of [...this.jobs.values()]) this.cancel(job)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private cancel(job: Job) {
    this.jobs.delete(job.key)
    this.queue = this.queue.filter((k) => k !== job.key)
    job.controller?.abort()
    const err = new DOMException('cancelado', 'AbortError')
    for (const w of job.waiters) w.reject(err)
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, Math.max(0, ms))
  }

  private pump() {
    if (this.disposed) return
    const now = Date.now()
    if (now < this.blockedUntil) return this.schedule(this.blockedUntil - now)
    this.sentAt = this.sentAt.filter((t) => now - t < WINDOW_MS)

    // Prioridad: los pinned (selección de grupo) primero.
    this.queue.sort((a, b) => Number(this.jobs.get(b)?.pinned) - Number(this.jobs.get(a)?.pinned))

    let nextWake = Infinity
    for (let i = 0; i < this.queue.length && this.active < MAX_CONCURRENT; ) {
      if (this.sentAt.length >= WINDOW_MAX) {
        nextWake = Math.min(nextWake, (this.sentAt[0] ?? now) + WINDOW_MS - now + 5)
        break
      }
      const key = this.queue[i]!
      const job = this.jobs.get(key)
      if (!job) {
        this.queue.splice(i, 1)
        continue
      }
      if (job.notBefore > now) {
        nextWake = Math.min(nextWake, job.notBefore - now)
        i++
        continue
      }
      this.queue.splice(i, 1)
      this.start(job)
    }
    if (nextWake !== Infinity) this.schedule(nextWake)
  }

  private async start(job: Job) {
    this.active++
    this.sentAt.push(Date.now())
    const controller = new AbortController()
    job.controller = controller
    try {
      const res = await apiResponse(`/files/${this.fileId}/tiles/${job.tr}/${job.tc}`, {
        signal: controller.signal,
      })
      const tile = decodeTile((await res.json()) as TileDto)
      if (this.jobs.get(job.key) !== job) return // cancelado mientras tanto
      this.jobs.delete(job.key)
      this.tiles.set(job.key, tile)
      for (const w of job.waiters) w.resolve(tile)
      this.emit()
    } catch (e) {
      if (controller.signal.aborted) return
      if (e instanceof ApiError) {
        if (e.status === 429) {
          // Nada de requests de tiles hasta que pase Retry-After.
          this.blockedUntil = Date.now() + (e.retryAfter ?? 1) * 1000
          this.requeue(job, 0)
          this.emit()
        } else if (e.status === 503 && job.attempt < 6) {
          this.requeue(job, backoffMs(job.attempt++, e.retryAfter))
        } else {
          this.fail(job, e)
        }
      } else if (job.attempt < 4) {
        this.requeue(job, backoffMs(job.attempt++, null)) // error de red
      } else {
        this.fail(job, e)
      }
    } finally {
      job.controller = null
      this.active--
      this.pump()
    }
  }

  private requeue(job: Job, delay: number) {
    if (this.jobs.get(job.key) !== job) return
    job.notBefore = Date.now() + delay
    this.queue.unshift(job.key)
  }

  private fail(job: Job, err: unknown) {
    this.jobs.delete(job.key)
    this.errorCount++
    for (const w of job.waiters) w.reject(err)
    this.emit()
  }
}
