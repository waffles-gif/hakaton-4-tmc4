import { Link, isRouteErrorResponse, useRouteError } from 'react-router'

/** Error de render en una ruta: nunca pantalla en blanco. */
export default function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Error desconocido'
  return (
    <main className="mx-auto max-w-lg p-8 text-center" role="alert">
      <h1 className="text-2xl font-semibold">Algo salió mal</h1>
      <p className="mt-2 break-words text-slate-300">{message}</p>
      <div className="mt-4 flex justify-center gap-4">
        <button type="button" onClick={() => window.location.reload()} className="text-teal-300 underline">
          Reintentar
        </button>
        <Link to="/" className="text-teal-300 underline">
          Volver al inicio
        </Link>
      </div>
    </main>
  )
}
