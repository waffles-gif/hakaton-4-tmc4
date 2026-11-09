// Cliente HTTP de la app. Toda request pasa por aquí:
// - Añade X-Lumon-Build (SHA del build) y Authorization.
// - Access token SOLO en memoria. Refresh token en localStorage (es de un solo uso).
// - Refresh coordinado: una sola request de refresh por pestaña (promesa compartida)
//   y una sola entre pestañas (Web Locks). Los tokens nuevos se reparten por BroadcastChannel.
// - Solo TOKEN_EXPIRED dispara refresh, y cada request se reintenta UNA vez.

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
export const BUILD_SHA = __BUILD_SHA__

const REFRESH_KEY = 'lumon.refresh'
const LOCK_NAME = 'lumon-refresh'

export interface ApiErrorBody {
  error: string
  message: string
  details: unknown
  requestId?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly retryAfter: number | null

  constructor(status: number, body: ApiErrorBody, retryAfter: number | null) {
    super(body.message)
    this.status = status
    this.code = body.error
    this.details = body.details
    this.retryAfter = retryAfter
  }
}

/** Errores de validación: { fields: { campo: mensaje } } */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {}
  const d = err.details
  if (d && typeof d === 'object') {
    if ('fields' in d && d.fields && typeof d.fields === 'object') {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(d.fields)) if (typeof v === 'string') out[k] = v
      return out
    }
    if ('field' in d && typeof d.field === 'string') return { [d.field]: err.message }
  }
  return {}
}

export interface Tokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

// ---------- Estado de sesión (en memoria) ----------

let accessToken: string | null = null

export type SessionEndReason = 'LOGOUT' | 'REFRESH_REUSED' | 'SESSION_REVOKED' | 'TOKEN_INVALID' | 'REFRESH_INVALID'

type AuthMessage =
  | { type: 'tokens'; accessToken: string }
  | { type: 'ended'; reason: SessionEndReason }

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lumon-auth') : null

type Listener = (e: AuthMessage) => void
const listeners = new Set<Listener>()

/** Suscribirse a cambios de sesión (de esta pestaña o de otras). */
export function onAuthChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(msg: AuthMessage, broadcast: boolean) {
  if (broadcast) channel?.postMessage(msg)
  for (const l of listeners) l(msg)
}

channel?.addEventListener('message', (ev: MessageEvent<AuthMessage>) => {
  const msg = ev.data
  if (msg.type === 'tokens') accessToken = msg.accessToken
  else accessToken = null
  emit(msg, false)
})

function readRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

function writeRefreshToken(rt: string | null) {
  try {
    if (rt) localStorage.setItem(REFRESH_KEY, rt)
    else localStorage.removeItem(REFRESH_KEY)
  } catch {
    /* almacenamiento bloqueado: la sesión solo vive en esta pestaña */
  }
}

export function getStoredRefreshToken(): string | null {
  return readRefreshToken()
}

export function hasStoredSession(): boolean {
  return readRefreshToken() !== null
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Guardar un par nuevo (login, registro o refresh) y avisar a las otras pestañas. */
export function setSession(t: Tokens) {
  accessToken = t.accessToken
  writeRefreshToken(t.refreshToken)
  emit({ type: 'tokens', accessToken: t.accessToken }, true)
}

/** Cerrar la sesión localmente en TODAS las pestañas. */
export function endSession(reason: SessionEndReason) {
  accessToken = null
  writeRefreshToken(null)
  emit({ type: 'ended', reason }, true)
}

// ---------- Refresh coordinado ----------

let refreshing: Promise<void> | null = null

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(LOCK_NAME, fn)
  }
  return fn()
}

/**
 * Renueva el access token. `staleToken` es el token con el que falló la request:
 * si al conseguir el lock ya hay otro distinto, otra pestaña/request ya renovó y no se repite.
 */
export function refreshSession(staleToken: string | null = accessToken): Promise<void> {
  if (!refreshing) {
    refreshing = withLock(async () => {
      if (accessToken && accessToken !== staleToken) return
      const rt = readRefreshToken()
      if (!rt) {
        endSession('REFRESH_INVALID')
        throw new ApiError(401, { error: 'REFRESH_INVALID', message: 'No hay sesión guardada.', details: null }, null)
      }
      const res = await rawFetch('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) })
      if (!res.ok) {
        const err = await toApiError(res)
        if (res.status === 401) endSession(asReason(err.code))
        throw err
      }
      setSession((await res.json()) as Tokens)
    }).finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

function asReason(code: string): SessionEndReason {
  if (code === 'REFRESH_REUSED' || code === 'SESSION_REVOKED' || code === 'TOKEN_INVALID') return code
  return 'REFRESH_INVALID'
}

// ---------- fetch ----------

function rawFetch(path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Lumon-Build', BUILD_SHA)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`)
  return fetch(`${API_BASE_URL}${path}`, { ...init, headers })
}

async function toApiError(res: Response): Promise<ApiError> {
  const ra = res.headers.get('Retry-After')
  const retryAfter = ra !== null && !Number.isNaN(Number(ra)) ? Number(ra) : null
  let body: ApiErrorBody = { error: `HTTP_${res.status}`, message: res.statusText || 'Error de red', details: null }
  try {
    const json: unknown = await res.json()
    if (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string') {
      body = json as ApiErrorBody
    }
  } catch {
    /* cuerpo vacío o no JSON */
  }
  return new ApiError(res.status, body, retryAfter)
}

export interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** false para rutas públicas (login, register, health…). */
  auth?: boolean
}

/**
 * Hace la request y devuelve la Response cruda (útil para leer ETag, Retry-After…).
 * Lanza ApiError si el status no es 2xx.
 */
export async function apiResponse(path: string, opts: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', body, headers, signal, auth = true } = opts
  const init: RequestInit = { method, headers, signal }
  if (body !== undefined) init.body = JSON.stringify(body)

  if (auth && !accessToken && hasStoredSession()) await refreshSession(null)

  const tokenUsed = auth ? accessToken : null
  let res = await rawFetch(path, { ...init, token: tokenUsed })

  if (auth && res.status === 401) {
    const err = await toApiError(res)
    if (err.code !== 'TOKEN_EXPIRED') {
      if (err.code === 'SESSION_REVOKED' || err.code === 'TOKEN_INVALID') endSession(err.code)
      throw err
    }
    await refreshSession(tokenUsed)
    res = await rawFetch(path, { ...init, token: accessToken }) // un solo reintento
    if (res.status === 401) {
      const err2 = await toApiError(res)
      endSession(asReason(err2.code))
      throw err2
    }
  }

  if (!res.ok) throw await toApiError(res)
  return res
}

/** Request JSON tipada. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiResponse(path, opts)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** Espera `ms`, cancelable. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason)
    })
  })
}
