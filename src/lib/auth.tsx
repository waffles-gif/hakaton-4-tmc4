import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  api,
  endSession,
  getStoredRefreshToken,
  hasStoredSession,
  onAuthChange,
  refreshSession,
  setSession,
  type SessionEndReason,
  type Tokens,
} from './api'
import type { Me, Permission } from './types'

type Status = 'loading' | 'authenticated' | 'anonymous'

interface AuthState {
  status: Status
  me: Me | null
  /** Mensaje para el login cuando la sesión se cerró sola (revocada, reusada…). */
  notice: string | null
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>
  register: (teamName: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  can: (p: Permission) => boolean
  reloadMe: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const NOTICES: Record<SessionEndReason, string | null> = {
  LOGOUT: null,
  REFRESH_REUSED: 'Tu sesión se cerró por seguridad: se detectó un token reutilizado. Vuelve a iniciar sesión.',
  SESSION_REVOKED: 'Tu sesión fue revocada. Vuelve a iniciar sesión.',
  TOKEN_INVALID: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.',
  REFRESH_INVALID: 'Tu sesión expiró. Vuelve a iniciar sesión.',
}

// Restauración al cargar: una sola vez por pestaña (StrictMode monta dos veces).
let bootstrap: Promise<Me | null> | null = null
function restoreSession(): Promise<Me | null> {
  if (!bootstrap) {
    bootstrap = (async () => {
      if (!hasStoredSession()) return null
      try {
        await refreshSession(null)
        return await api<Me>('/auth/me')
      } catch {
        return null
      }
    })()
  }
  return bootstrap
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', me: null, notice: null })
  const statusRef = useRef<Status>(state.status)
  useEffect(() => {
    statusRef.current = state.status
  }, [state.status])

  const reloadMe = useCallback(async () => {
    const me = await api<Me>('/auth/me')
    setState({ status: 'authenticated', me, notice: null })
  }, [])

  useEffect(() => {
    let alive = true
    void restoreSession().then((me) => {
      if (!alive) return
      setState((s) =>
        s.status === 'loading' ? (me ? { status: 'authenticated', me, notice: null } : { ...s, status: 'anonymous' }) : s,
      )
    })
    const off = onAuthChange((msg) => {
      if (msg.type === 'ended') {
        setState({ status: 'anonymous', me: null, notice: NOTICES[msg.reason] })
      } else {
        // Otra pestaña inició sesión: nos sumamos.
        if (statusRef.current !== 'authenticated') void reloadMe().catch(() => undefined)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [reloadMe])

  const startSession = useCallback(
    async (tokens: Tokens) => {
      setSession(tokens)
      await reloadMe()
    },
    [reloadMe],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const t = await api<Tokens>('/auth/login', { method: 'POST', body: { email, password }, auth: false })
      await startSession(t)
    },
    [startSession],
  )

  const register = useCallback(
    async (teamName: string, email: string, password: string) => {
      const t = await api<Tokens>('/auth/register', {
        method: 'POST',
        body: { teamName, email, password },
        auth: false,
      })
      await startSession(t)
    },
    [startSession],
  )

  const logout = useCallback(async () => {
    const rt = getStoredRefreshToken()
    try {
      if (rt) await api('/auth/logout', { method: 'POST', body: { refreshToken: rt }, auth: false })
    } catch {
      /* aunque falle la red, la sesión local se cierra igual */
    } finally {
      endSession('LOGOUT')
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      register,
      logout,
      reloadMe,
      can: (p) => state.me?.permissions.includes(p) ?? false,
    }),
    [state, login, register, logout, reloadMe],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth fuera de AuthProvider')
  return ctx
}
