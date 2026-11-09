import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { FullScreenLoader, safeNext } from '../components/guards'
import { Field } from '../components/Field'
import { ApiError, fieldErrors } from '../lib/api'
import { useAuth } from '../lib/auth'

export default function LoginPage() {
  const { status, login, notice } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'loading') return <FullScreenLoader />
  if (status === 'authenticated') return <Navigate to={next} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErrors({})
    setFormError(null)
    try {
      await login(email, password)
    } catch (err) {
      setErrors(fieldErrors(err))
      setFormError(
        err instanceof ApiError
          ? err.code === 'INVALID_CREDENTIALS'
            ? 'Email o contraseña incorrectos.'
            : err.message
          : 'No se pudo conectar. Intenta de nuevo.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto mt-16 max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Entrar al piso</h1>
      {notice && (
        <p role="alert" className="mt-4 rounded border border-amber-500 bg-amber-950 p-3 text-amber-200">
          {notice}
        </p>
      )}
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Field
          label="Contraseña"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        {formError && (
          <p role="alert" className="text-sm text-red-300">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-500 disabled:opacity-60"
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-300">
        ¿Primera vez?{' '}
        <Link to={`/register?next=${encodeURIComponent(next)}`} className="text-teal-300 underline">
          Registrar cuadrilla
        </Link>
      </p>
    </main>
  )
}
