import { NavLink, Outlet } from 'react-router'
import { useAuth } from '../lib/auth'
import type { Permission } from '../lib/types'

const LINKS: { to: string; label: string; perm?: Permission }[] = [
  { to: '/files', label: 'Archivos', perm: 'files:read' },
  { to: '/estado', label: 'Estado' },
]

export function Layout() {
  const { me, logout, can } = useAuth()
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-4 border-b border-slate-800 px-4 py-3">
        <span className="font-semibold tracking-wide">Lumon · MDR</span>
        <nav aria-label="Principal" className="flex gap-3">
          {LINKS.filter((l) => !l.perm || can(l.perm)).map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => (isActive ? 'text-teal-300 underline' : 'text-slate-200 hover:text-white')}
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {me && (
            <span className="text-slate-300">
              {me.displayName} · {me.team.code} · {me.role.name}
            </span>
          )}
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded border border-slate-600 px-3 py-1 hover:bg-slate-800"
          >
            Salir
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  )
}
