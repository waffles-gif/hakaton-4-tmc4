// Capa HTTP de la grilla: reutiliza el cliente con sesión de src/lib/api.ts
// (Authorization, X-Lumon-Build y refresh coordinado ya van ahí).
import { ApiError, api, apiResponse, sleep } from '../../lib/api'

export { ApiError, apiResponse, sleep }

/** Espera creciente: max(Retry-After, 500ms·2^intento) con un poco de jitter, tope 15 s. */
export function backoffMs(attempt: number, retryAfter: number | null) {
  const exp = Math.min(15000, 500 * 2 ** attempt)
  const ra = retryAfter !== null ? retryAfter * 1000 : 0
  return Math.max(ra, exp) + Math.floor(Math.random() * 250)
}

export function isRetryable(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.status === 503 || e.status === 429)
}

/** GET JSON que reintenta 503 (modo caos) y 429 respetando Retry-After. */
export async function getJson<T>(path: string, signal?: AbortSignal, maxRetries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<T>(path, { signal })
    } catch (e) {
      if (signal?.aborted) throw e
      if (isRetryable(e) && attempt < maxRetries) {
        await sleep(backoffMs(attempt, e.retryAfter), signal)
        continue
      }
      throw e
    }
  }
}
