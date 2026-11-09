import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '../lib/auth'
import type { Permission } from '../lib/types'
import { ForbiddenPage } from '../pages/ForbiddenPage'

export function FullScreenLoader({ label = 'Verificando sesión…' }: { label?: string }) {
  return (
    <main className="grid min-h-screen place-items-center" role="status" aria-live="polite">
      <p className="text-slate-300">{label}</p>
    </main>
  )
}

/** Rutas privadas: sin sesión → /login?next=<ruta+query>. Mientras verifica, NO muestra el login. */
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullScreenLoader />
  if (status === 'anonymous') {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <Outlet />
}

/** Sin el permiso → página "sin permiso" (no error ni pantalla en blanco). */
export function RequirePermission({ perm, children }: { perm: Permission; children?: ReactNode }) {
  const { can } = useAuth()
  if (!can(perm)) return <ForbiddenPage perm={perm} />
  return children ? <>{children}</> : <Outlet />
}

/** Solo acepta rutas internas para evitar redirecciones abiertas. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/files'
  return raw
}
