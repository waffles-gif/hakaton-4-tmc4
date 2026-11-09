import { Link } from 'react-router'

export default function NotFoundPage() {
  return (
    <main className="mx-auto max-w-lg p-8 text-center">
      <h1 className="text-2xl font-semibold">404 · Página no encontrada</h1>
      <p className="mt-2 text-slate-300">Esta sala no existe en el piso separado.</p>
      <Link to="/" className="mt-4 inline-block text-teal-300 underline">
        Volver al inicio
      </Link>
    </main>
  )
}
