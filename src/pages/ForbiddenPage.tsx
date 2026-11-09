import { Link } from 'react-router'

export function ForbiddenPage({ perm }: { perm?: string }) {
  return (
    <main className="mx-auto max-w-lg p-8 text-center">
      <h1 className="text-2xl font-semibold">Sin permiso</h1>
      <p className="mt-2 text-slate-300">
        Tu rol no tiene acceso a esta sección{perm ? ` (se necesita «${perm}»)` : ''}.
      </p>
      <Link to="/" className="mt-4 inline-block text-teal-300 underline">
        Volver al inicio
      </Link>
    </main>
  )
}
