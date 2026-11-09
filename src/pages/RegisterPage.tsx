import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { FullScreenLoader, safeNext } from '../components/guards'
import { Field } from '../components/Field'
import { ApiError, fieldErrors } from '../lib/api'
import { useAuth } from '../lib/auth'

export default function RegisterPage() {
  const { status, register } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [teamName, setTeamName] = useState('')
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
      await register(teamName, email, password)
    } catch (err) {
      const fe = fieldErrors(err)
      setErrors(fe)
      if (Object.keys(fe).length === 0) {
        setFormError(err instanceof ApiError ? err.message : 'No se pudo conectar. Intenta de nuevo.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto mt-16 max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Registrar cuadrilla</h1>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field
          label="Nombre de la cuadrilla"
          required
          minLength={3}
          maxLength={40}
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          error={errors.teamName}
        />
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
          label="Contraseña (mínimo 8 caracteres)"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        {(formError || errors._) && (
          <p role="alert" className="text-sm text-red-300">
            {formError ?? errors._}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-teal-600 px-4 py-2 font-medium text-white hover:bg-teal-500 disabled:opacity-60"
        >
          {busy ? 'Registrando…' : 'Registrar y entrar'}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-300">
        ¿Ya tienes cuenta?{' '}
        <Link to={`/login?next=${encodeURIComponent(next)}`} className="text-teal-300 underline">
          Entrar
        </Link>
      </p>
    </main>
  )
}
